# --- Lambda IAM Execution Role ---
resource "aws_iam_role" "lambda_exec_role" {
  name = "chai-q-lambda-exec-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# s3_trigger needs permission to start the Step Function
resource "aws_iam_role_policy" "lambda_sfn_start" {
  name = "chai-q-lambda-sfn-start"
  role = aws_iam_role.lambda_exec_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = "states:StartExecution"
      Effect   = "Allow"
      Resource = aws_sfn_state_machine.research_orchestrator.arn
    }]
  })
}

# --- pymongo Lambda Layer (aggregator depends on it, not in Lambda runtime) ---
# Built inside Docker to produce Linux x86_64 binaries compatible with Lambda.
resource "null_resource" "pymongo_layer_build" {
  triggers = {
    version = "pymongo-srv-4.6.1-linux-v2"
  }
  provisioner "local-exec" {
    command = <<-EOT
      rm -rf "${path.module}/.pymongo-layer"
      mkdir -p "${path.module}/.pymongo-layer/python"
      docker run --rm --platform linux/amd64 \
        --entrypoint pip \
        -v "${path.module}/.pymongo-layer/python:/out" \
        public.ecr.aws/lambda/python:3.11 \
        install "pymongo[srv]==4.6.1" -t /out --quiet
    EOT
  }
}

data "archive_file" "pymongo_layer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/.pymongo-layer"
  output_path = "${path.module}/.pymongo-layer.zip"
  depends_on  = [null_resource.pymongo_layer_build]
}

resource "aws_lambda_layer_version" "pymongo" {
  layer_name          = "chai-q-pymongo"
  filename            = data.archive_file.pymongo_layer_zip.output_path
  source_code_hash    = data.archive_file.pymongo_layer_zip.output_base64sha256
  compatible_runtimes = ["python3.11"]
}

# --- Package Lambda source files ---
data "archive_file" "trigger_zip" {
  type        = "zip"
  source_file = "../orchestrator/lambda_trigger.py"
  output_path = "/tmp/chai-q-trigger.zip"
}

data "archive_file" "aggregator_zip" {
  type        = "zip"
  source_file = "../orchestrator/aggregator.py"
  output_path = "/tmp/chai-q-aggregator.zip"
}

data "archive_file" "mark_lab_failed_zip" {
  type        = "zip"
  source_file = "../orchestrator/mark_lab_failed.py"
  output_path = "/tmp/chai-q-mark-lab-failed.zip"
}

data "archive_file" "search_orchestrator_zip" {
  type        = "zip"
  source_file = "../orchestrator/search_orchestrator.py"
  output_path = "/tmp/chai-q-search-orchestrator.zip"
}

# --- S3 Trigger Lambda ---
resource "aws_lambda_function" "s3_trigger" {
  filename         = data.archive_file.trigger_zip.output_path
  source_code_hash = data.archive_file.trigger_zip.output_base64sha256
  function_name    = "chai-q-s3-trigger"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "lambda_trigger.handler"
  runtime          = "python3.11"
  timeout          = 30

  environment {
    variables = {
      STATE_MACHINE_ARN = aws_sfn_state_machine.research_orchestrator.arn
    }
  }
}

# Allow S3 to invoke the trigger Lambda
resource "aws_lambda_permission" "allow_s3_invoke" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.s3_trigger.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.raw_input.arn
}

# Wire S3 upload event -> Lambda trigger
resource "aws_s3_bucket_notification" "upload_trigger" {
  bucket = aws_s3_bucket.raw_input.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.s3_trigger.arn
    events              = ["s3:ObjectCreated:*"]
  }

  depends_on = [aws_lambda_permission.allow_s3_invoke]
}

# --- Aggregator Lambda ---
resource "aws_lambda_function" "aggregator" {
  filename         = data.archive_file.aggregator_zip.output_path
  source_code_hash = data.archive_file.aggregator_zip.output_base64sha256
  function_name    = "chai-q-aggregator"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "aggregator.handler"
  runtime          = "python3.11"
  timeout          = 60
  layers           = [aws_lambda_layer_version.pymongo.arn]

  environment {
    variables = {
      MONGO_URI = var.mongo_uri
    }
  }
}

# --- Mark lab failed (Step Function Catch) ---
resource "aws_lambda_function" "mark_lab_failed" {
  filename         = data.archive_file.mark_lab_failed_zip.output_path
  source_code_hash = data.archive_file.mark_lab_failed_zip.output_base64sha256
  function_name    = "chai-q-mark-lab-failed"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "mark_lab_failed.handler"
  runtime          = "python3.11"
  timeout          = 30
  layers           = [aws_lambda_layer_version.pymongo.arn]

  environment {
    variables = {
      MONGO_URI = var.mongo_uri
    }
  }
}

# --- Decision-driven search orchestrator ---
resource "aws_lambda_function" "search_orchestrator" {
  filename         = data.archive_file.search_orchestrator_zip.output_path
  source_code_hash = data.archive_file.search_orchestrator_zip.output_base64sha256
  function_name    = "chai-q-search-orchestrator"
  role             = aws_iam_role.lambda_exec_role.arn
  handler          = "search_orchestrator.handler"
  runtime          = "python3.11"
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.pymongo.arn]

  environment {
    variables = {
      MONGO_URI                = var.mongo_uri
      BATCH_JOB_QUEUE_ARN      = aws_batch_job_queue.chai_q_queue.arn
      BATCH_JOB_DEFINITION_ARN = aws_batch_job_definition.chai_q_worker_def.arn
    }
  }
}

# =============================================================================
# GCP Pipeline Lambdas + GCP-Orchestrator Step Function
# =============================================================================

# --- GCP Lambda Layer (google-cloud deps + pymongo + requests) ---
# Built inside Docker to produce Linux x86_64 binaries compatible with Lambda.
resource "null_resource" "gcp_layer_build" {
  triggers = {
    version = "gcp-transcoder-0.3-linux-v2"
  }
  provisioner "local-exec" {
    command = <<-EOT
      rm -rf "${path.module}/.gcp-layer"
      mkdir -p "${path.module}/.gcp-layer/python"
      docker run --rm --platform linux/amd64 \
        --entrypoint pip \
        -v "${path.module}/.gcp-layer/python:/out" \
        public.ecr.aws/lambda/python:3.11 \
        install \
          "google-cloud-video-transcoder>=1.0.0" \
          "google-cloud-storage>=2.0.0" \
          "pymongo[srv]==4.6.1" \
          "requests>=2.31.0" \
          -t /out --quiet
    EOT
  }
}

data "archive_file" "gcp_layer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/.gcp-layer"
  output_path = "${path.module}/.gcp-layer.zip"
  depends_on  = [null_resource.gcp_layer_build]
}

resource "aws_lambda_layer_version" "gcp_deps" {
  layer_name          = "chai-q-gcp-deps"
  filename            = data.archive_file.gcp_layer_zip.output_path
  source_code_hash    = data.archive_file.gcp_layer_zip.output_base64sha256
  compatible_runtimes = ["python3.11"]
}

# --- Package GCP Lambda source files ---
data "archive_file" "gcp_copy_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_copy_s3_to_gcs.py"
  output_path = "/tmp/chai-q-gcp-copy.zip"
}

data "archive_file" "gcp_transcoder_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_transcoder.py"
  output_path = "/tmp/chai-q-gcp-transcoder.zip"
}

data "archive_file" "gcp_check_status_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_check_status.py"
  output_path = "/tmp/chai-q-gcp-check-status.zip"
}

data "archive_file" "gcp_finalize_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_finalize_hls.py"
  output_path = "/tmp/chai-q-gcp-finalize.zip"
}

locals {
  gcp_lambda_env = {
    MONGO_URI                  = var.mongo_uri
    GCP_PROJECT                = var.gcp_project
    GCP_LOCATION               = var.gcp_location
    GCS_INPUT_BUCKET           = var.gcs_input_bucket
    GCS_OUTPUT_BUCKET          = var.gcs_output_bucket
    GCP_CREDENTIALS_SECRET_ARN = local.gcp_credentials_secret_arn_effective
    SUBTITLE_MONGO_URI         = var.subtitle_mongo_uri
    CDN_BASE                   = var.cdn_base
  }
}

# --- CopySourceToGCS Lambda ---
resource "aws_lambda_function" "gcp_copy" {
  filename         = data.archive_file.gcp_copy_zip.output_path
  source_code_hash = data.archive_file.gcp_copy_zip.output_base64sha256
  function_name    = "chai-q-gcp-copy-s3-to-gcs"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_copy_s3_to_gcs.handler"
  runtime          = "python3.11"
  timeout          = 900
  memory_size      = 512
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- SubmitGCPJob Lambda ---
resource "aws_lambda_function" "gcp_transcoder" {
  filename         = data.archive_file.gcp_transcoder_zip.output_path
  source_code_hash = data.archive_file.gcp_transcoder_zip.output_base64sha256
  function_name    = "chai-q-gcp-transcoder"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_transcoder.handler"
  runtime          = "python3.11"
  timeout          = 120
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- CheckJobStatus Lambda ---
resource "aws_lambda_function" "gcp_check_status" {
  filename         = data.archive_file.gcp_check_status_zip.output_path
  source_code_hash = data.archive_file.gcp_check_status_zip.output_base64sha256
  function_name    = "chai-q-gcp-check-status"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_check_status.handler"
  runtime          = "python3.11"
  timeout          = 60
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- FinalizeHLS Lambda ---
resource "aws_lambda_function" "gcp_finalize" {
  filename         = data.archive_file.gcp_finalize_zip.output_path
  source_code_hash = data.archive_file.gcp_finalize_zip.output_base64sha256
  function_name    = "chai-q-gcp-finalize-hls"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_finalize_hls.handler"
  runtime          = "python3.11"
  timeout          = 300
  memory_size      = 256
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- CreateCombinedMaster Lambda ---
data "archive_file" "gcp_create_combined_master_zip" {
  type        = "zip"
  source_file = "../orchestrator/gcp_create_combined_master.py"
  output_path = "/tmp/chai-q-gcp-create-combined-master.zip"
}

resource "aws_lambda_function" "gcp_create_combined_master" {
  filename         = data.archive_file.gcp_create_combined_master_zip.output_path
  source_code_hash = data.archive_file.gcp_create_combined_master_zip.output_base64sha256
  function_name    = "chai-q-gcp-create-combined-master"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "gcp_create_combined_master.handler"
  runtime          = "python3.11"
  timeout          = 120
  memory_size      = 256
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = local.gcp_lambda_env
  }
}

# --- FFmpeg Lambda Layer ---
# Downloads a static Linux x86_64 ffmpeg binary and packages it as a layer.
resource "null_resource" "ffmpeg_layer_build" {
  triggers = {
    version = "ffmpeg-7.0-linux-x86_64-v1"
  }
  provisioner "local-exec" {
    command = <<-EOT
      rm -rf "${path.module}/.ffmpeg-layer" "${path.module}/.ffmpeg-tmp"
      mkdir -p "${path.module}/.ffmpeg-layer/bin" "${path.module}/.ffmpeg-tmp"
      curl -sL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" \
        -o "${path.module}/.ffmpeg-tmp/ffmpeg.tar.xz"
      tar -xJf "${path.module}/.ffmpeg-tmp/ffmpeg.tar.xz" -C "${path.module}/.ffmpeg-tmp"
      find "${path.module}/.ffmpeg-tmp" -name "ffmpeg" -not -name "*.xz" -exec cp {} "${path.module}/.ffmpeg-layer/bin/ffmpeg" \;
      find "${path.module}/.ffmpeg-tmp" -name "ffprobe" -exec cp {} "${path.module}/.ffmpeg-layer/bin/ffprobe" \;
      chmod +x "${path.module}/.ffmpeg-layer/bin/ffmpeg" "${path.module}/.ffmpeg-layer/bin/ffprobe"
      rm -rf "${path.module}/.ffmpeg-tmp"
    EOT
  }
}

data "archive_file" "ffmpeg_layer_zip" {
  type        = "zip"
  source_dir  = "${path.module}/.ffmpeg-layer"
  output_path = "${path.module}/.ffmpeg-layer.zip"
  depends_on  = [null_resource.ffmpeg_layer_build]
}

# FFmpeg binary zip exceeds Lambda's 70 MB direct-upload limit — upload via S3 first.
# null_resource.ffmpeg_layer_build gates actual content changes via its `version`
# trigger. The archive_file's output_md5 fluctuates across re-zips even when the
# ffmpeg binary is byte-identical (zip header timestamps aren't deterministic), so
# we ignore `etag` + `source` drift to prevent unnecessary 60 MB re-uploads on
# every `terraform apply`. Bump the null_resource's `version` trigger to force an
# actual ffmpeg upgrade.
resource "aws_s3_object" "ffmpeg_layer_zip" {
  bucket = aws_s3_bucket.raw_input.id
  key    = "lambda-layers/ffmpeg-layer.zip"
  source = data.archive_file.ffmpeg_layer_zip.output_path
  etag   = data.archive_file.ffmpeg_layer_zip.output_md5

  lifecycle {
    ignore_changes = [etag, source]
  }
}

resource "aws_lambda_layer_version" "ffmpeg" {
  layer_name          = "chai-q-ffmpeg"
  s3_bucket           = aws_s3_object.ffmpeg_layer_zip.bucket
  s3_key              = aws_s3_object.ffmpeg_layer_zip.key
  source_code_hash    = data.archive_file.ffmpeg_layer_zip.output_base64sha256
  compatible_runtimes = ["python3.11"]
}

# --- QualityChecker Lambda ---
# Bundles the handler + shared signer helper into one zip so the runtime can
# sign Media CDN URLs before fetching the combined manifest and variant streams.
data "archive_file" "quality_checker_zip" {
  type        = "zip"
  output_path = "/tmp/chai-q-quality-checker.zip"

  source {
    content  = file("../orchestrator/quality_checker.py")
    filename = "quality_checker.py"
  }
  source {
    content  = file("../orchestrator/media_cdn_signer.py")
    filename = "media_cdn_signer.py"
  }
}

resource "aws_lambda_function" "quality_checker" {
  filename         = data.archive_file.quality_checker_zip.output_path
  source_code_hash = data.archive_file.quality_checker_zip.output_base64sha256
  function_name    = "chai-q-quality-checker"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "quality_checker.handler"
  runtime          = "python3.11"
  timeout          = 600
  memory_size      = 1024
  # gcp_deps layer provides pymongo + cryptography (Ed25519 for the signer).
  # ffmpeg layer provides /opt/bin/ffmpeg + ffprobe.
  layers = [
    aws_lambda_layer_version.gcp_deps.arn,
    aws_lambda_layer_version.ffmpeg.arn,
  ]

  environment {
    variables = {
      MONGO_URI              = var.mongo_uri
      FFMPEG_PATH            = "/opt/bin/ffmpeg"
      FFPROBE_PATH           = "/opt/bin/ffprobe"
      CDN_BASE               = var.cdn_base
      SIGNING_KEY_SECRET_ID  = var.media_cdn_signing_key_secret_id
      SIGNED_URL_TTL_SECONDS = tostring(var.signed_url_ttl_seconds)
    }
  }
}

# --- GCP-Orchestrator Step Function ---
resource "aws_sfn_state_machine" "gcp_orchestrator" {
  name     = "GCP-Orchestrator"
  role_arn = aws_iam_role.step_function_role.arn

  definition = templatefile("../orchestrator/gcp_step_function_def.json", {
    gcp_copy_lambda_arn         = aws_lambda_function.gcp_copy.arn
    gcp_transcoder_lambda_arn   = aws_lambda_function.gcp_transcoder.arn
    gcp_check_status_lambda_arn = aws_lambda_function.gcp_check_status.arn
    gcp_finalize_lambda_arn     = aws_lambda_function.gcp_finalize.arn
  })
}

# --- Resign Playback URLs Lambda ---
# Bundles the handler + shared signer helper into one zip so the runtime can import both.
data "archive_file" "resign_playback_urls_zip" {
  type        = "zip"
  output_path = "/tmp/chai-q-resign-playback-urls.zip"

  source {
    content  = file("../orchestrator/resign_playback_urls.py")
    filename = "resign_playback_urls.py"
  }
  source {
    content  = file("../orchestrator/media_cdn_signer.py")
    filename = "media_cdn_signer.py"
  }
}

resource "aws_lambda_function" "resign_playback_urls" {
  filename         = data.archive_file.resign_playback_urls_zip.output_path
  source_code_hash = data.archive_file.resign_playback_urls_zip.output_base64sha256
  function_name    = "chai-q-resign-playback-urls"
  role             = aws_iam_role.gcp_lambda_role.arn
  handler          = "resign_playback_urls.handler"
  runtime          = "python3.11"
  timeout          = 900 # Max allowed. Full sweep across 549 episodes × ~12 files each.
  memory_size      = 512
  layers           = [aws_lambda_layer_version.gcp_deps.arn]

  environment {
    variables = merge(local.gcp_lambda_env, {
      SIGNING_KEY_SECRET_ID  = var.media_cdn_signing_key_secret_id
      SIGNED_URL_TTL_SECONDS = tostring(var.signed_url_ttl_seconds)
      SIGNING_ENABLED        = tostring(var.signing_enabled)
    })
  }
}
