# ============================================================
# Audio pipeline (generate-only): copy -> transcode -> poll.
# Loudness normalization is done by GCP Transcoder (PreprocessingConfig.Audio.lufs=-16),
# so there is NO separate ffmpeg normalize worker. Renditions land in
# gs://${audio_bucket}/output/<episode_id>/. NO finalize-to-CDN, NO signing yet (by design).
# Reuses gcp_deps layer + gcp_lambda_role + step_function_role from lambda.tf (no ffmpeg).
# ============================================================

variable "audio_bucket" {
  type    = string
  default = "chai-q-audio-transcoder"
}

locals {
  audio_lambda_env = {
    MONGO_URI                  = var.mongo_uri
    SUBTITLE_MONGO_URI         = var.subtitle_mongo_uri    # gld2sqs.podcast_subtitles (audio); same cluster as video subs
    GCP_PROJECT                = var.gcp_project
    GCP_LOCATION               = var.gcp_location          # asia-south1
    GCS_INPUT_BUCKET           = var.audio_bucket          # one bucket, input/ + output/ prefixes
    GCS_OUTPUT_BUCKET          = var.audio_bucket
    GCP_CREDENTIALS_SECRET_ARN = local.gcp_credentials_secret_arn_effective
    AUDIO_SEGMENT_SECONDS      = "2"   # match video segment/GOP duration (gcp_transcoder.py = 2s)
    AUDIO_LADDER_KBPS          = "64"   # single-rung static ladder, HE-AAC (all-GCP; no ffprobe)
    AUDIO_LOUDNESS_LUFS        = "-16"
    AUDIO_PUBLIC_BUCKET        = "chai-q-audio-public"  # renditions copied here on success (public, no masters)
  }
}

# --- zips ---
data "archive_file" "audio_copy_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_copy_audio_to_gcs.py"
  output_path = "/tmp/chai-q-audio-copy.zip"
}
# Bundles the shared lang_codes module (BCP-47 normalization). lang_codes.py has no
# top-level env reads so it's safe to import here — keeping the language table in
# one place avoids the hand-sync hazard of duplicating it across video + audio.
data "archive_file" "audio_transcoder_zip" {
  type        = "zip"
  output_path = "/tmp/chai-q-audio-transcoder.zip"
  source {
    content  = file("../orchestrator/gcp_audio_transcoder.py")
    filename = "gcp_audio_transcoder.py"
  }
  source {
    content  = file("../orchestrator/lang_codes.py")
    filename = "lang_codes.py"
  }
}
data "archive_file" "audio_check_zip" {
  type        = "zip"
  output_path = "/tmp/chai-q-audio-check.zip"
  # Bundles audio_subtitle_publish.py + shared lang_codes so check_audio_status
  # can publish subtitles into the public bucket on SUCCEEDED. lang_codes has no
  # top-level env reads so importing it from a Lambda is safe.
  source {
    content  = file("../orchestrator/gcp_check_audio_status.py")
    filename = "gcp_check_audio_status.py"
  }
  source {
    content  = file("../orchestrator/audio_subtitle_publish.py")
    filename = "audio_subtitle_publish.py"
  }
  source {
    content  = file("../orchestrator/lang_codes.py")
    filename = "lang_codes.py"
  }
}
data "archive_file" "audio_list_zip" {
  type        = "zip"
  source_file = "../orchestrator/list_audio_episodes.py"
  output_path = "/tmp/chai-q-audio-list.zip"
}

# --- lambdas (reuse gcp_deps layer + gcp_lambda_role; no ffmpeg layer — all-GCP) ---
resource "aws_lambda_function" "audio_copy" {
  filename         = data.archive_file.audio_copy_zip.output_path
  source_code_hash = data.archive_file.audio_copy_zip.output_base64sha256
  function_name    = "chai-q-audio-copy"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_copy_audio_to_gcs.handler"
  runtime          = "python3.11"
  timeout          = 900
  memory_size      = 512
  layers           = [aws_lambda_layer_version.gcp_deps.arn]
  environment { variables = local.audio_lambda_env }
}

resource "aws_lambda_function" "audio_transcoder" {
  filename         = data.archive_file.audio_transcoder_zip.output_path
  source_code_hash = data.archive_file.audio_transcoder_zip.output_base64sha256
  function_name    = "chai-q-audio-transcoder"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_audio_transcoder.handler"
  runtime          = "python3.11"
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.gcp_deps.arn]
  environment { variables = local.audio_lambda_env }
}

resource "aws_lambda_function" "audio_check" {
  filename         = data.archive_file.audio_check_zip.output_path
  source_code_hash = data.archive_file.audio_check_zip.output_base64sha256
  function_name    = "chai-q-audio-check"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_check_audio_status.handler"
  runtime          = "python3.11"
  timeout          = 60
  # Bumped from default 128MB — on SUCCEEDED this lambda copies all renditions
  # into the public preview bucket (one copy_blob per object), which needs headroom.
  memory_size      = 512
  layers           = [aws_lambda_layer_version.gcp_deps.arn]
  environment { variables = local.audio_lambda_env }
}

resource "aws_lambda_function" "audio_list" {
  filename         = data.archive_file.audio_list_zip.output_path
  source_code_hash = data.archive_file.audio_list_zip.output_base64sha256
  function_name    = "chai-q-audio-list-episodes"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "list_audio_episodes.handler"
  runtime          = "python3.11"
  timeout          = 60
  layers           = [aws_lambda_layer_version.gcp_deps.arn]
  environment { variables = local.audio_lambda_env }
}

# --- per-episode child state machine ---
resource "aws_sfn_state_machine" "audio_orchestrator" {
  name     = "Audio-Orchestrator"
  role_arn = aws_iam_role.step_function_role.arn
  definition = templatefile("../orchestrator/gcp_audio_step_function_def.json", {
    gcp_copy_audio_lambda_arn         = aws_lambda_function.audio_copy.arn
    gcp_audio_transcoder_lambda_arn   = aws_lambda_function.audio_transcoder.arn
    gcp_check_audio_status_lambda_arn = aws_lambda_function.audio_check.arn
  })
}

# --- per-show batch parent (Map 30-wide, nested child executions) ---
resource "aws_sfn_state_machine" "audio_show_batch" {
  name     = "Audio-Show-Batch"
  role_arn = aws_iam_role.step_function_role.arn
  definition = templatefile("../orchestrator/gcp_audio_show_batch_def.json", {
    list_audio_episodes_lambda_arn = aws_lambda_function.audio_list.arn
    audio_child_state_machine_arn  = aws_sfn_state_machine.audio_orchestrator.arn
  })
}

# NOTE: step_function_role already grants lambda:InvokeFunction, states:StartExecution/
# DescribeExecution/StopExecution, and events:Put*/DescribeRule on Resource="*" (iam_roles.tf),
# which covers invoking the audio Lambdas and starting the child SM as a .sync nested
# execution. No extra IAM needed for audio.

output "audio_orchestrator_arn" {
  value = aws_sfn_state_machine.audio_orchestrator.arn
}
output "audio_show_batch_arn" {
  value = aws_sfn_state_machine.audio_show_batch.arn
}
