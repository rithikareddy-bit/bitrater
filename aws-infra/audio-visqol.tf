# ============================================================
# Audio Quality Check (ViSQOL) — on-demand "Calculate" worker.
# Scores the already-encoded 64k HE-AAC rendition of one episode against its source
# (both public HTTPS, no GCP creds). Measurement-only — no re-transcode, no Step Functions.
# The dashboard's /api/audio/visqol route SubmitJob's this def onto the SHARED batch queue.
# See AUDIO-QUALITY-CHECK-PLAN.md.
# ============================================================

# --- ECR repo for the ViSQOL worker image ---
resource "aws_ecr_repository" "audio_visqol_worker" {
  name                 = "audio-visqol-worker"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

# --- Mongo URI in Secrets Manager (so it's NOT plaintext in the job definition) ---
# The worker fetches this at runtime via its jobRole; the job def carries only the ARN.
resource "aws_secretsmanager_secret" "audio_mongo_uri" {
  name = "chai-q-audio-mongo-uri"
}
resource "aws_secretsmanager_secret_version" "audio_mongo_uri" {
  secret_id     = aws_secretsmanager_secret.audio_mongo_uri.id
  secret_string = var.mongo_uri
}

# Let the Batch container (jobRole = batch_instance_role) read just this one secret.
resource "aws_iam_role_policy" "audio_visqol_secret_read" {
  name = "chai-q-audio-visqol-secret-read"
  role = aws_iam_role.batch_instance_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.audio_mongo_uri.arn
    }]
  })
}

# --- Build & push the image (multi-stage: builds ViSQOL via Bazel + static ffmpeg) ---
resource "null_resource" "audio_visqol_push" {
  triggers = {
    worker_hash = filemd5("../audio-visqol-worker/worker.py")
    docker_hash = filemd5("../audio-visqol-worker/Dockerfile")
    reqs_hash   = filemd5("../audio-visqol-worker/requirements.txt")
  }

  provisioner "local-exec" {
    command = <<EOF
      aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${aws_ecr_repository.audio_visqol_worker.repository_url}

      # Build context = repo root so the Dockerfile's COPY paths resolve.
      cd ..
      docker build --platform linux/amd64 -t audio-visqol-worker -f audio-visqol-worker/Dockerfile .

      docker tag audio-visqol-worker:latest ${aws_ecr_repository.audio_visqol_worker.repository_url}:latest
      docker push ${aws_ecr_repository.audio_visqol_worker.repository_url}:latest
    EOF
  }

  depends_on = [aws_ecr_repository.audio_visqol_worker]
}

# --- Batch job definition (reuses the shared queue / compute env / instance role) ---
resource "aws_batch_job_definition" "audio_visqol_def" {
  name = "audio-visqol"
  type = "container"

  container_properties = jsonencode({
    image = "${aws_ecr_repository.audio_visqol_worker.repository_url}:latest"

    # Only the secret ARN (not the credential) is in the job def; the worker fetches the URI at
    # runtime via its jobRole (see _resolve_mongo_uri / _fetch_secret in worker.py). EPISODE_ID/
    # MASTER_URL/SOURCE_URL are passed per-job via the dashboard's SubmitJob containerOverrides.
    environment = [
      { name = "MONGO_SECRET_ARN", value = aws_secretsmanager_secret.audio_mongo_uri.arn },
      { name = "VISQOL_SEGMENT", value = "mid-180s" },
    ]

    jobRoleArn = aws_iam_role.batch_instance_role.arn

    # ViSQOL is memory-heavy; sized a touch above the video research worker (7168) — fits the
    # c5.2xlarge / m5.* instances in the compute env (G5 in the plan).
    resourceRequirements = [
      { value = "4", type = "VCPU" },
      { value = "8192", type = "MEMORY" },
    ]
  })

  timeout {
    attempt_duration_seconds = 3600 # 1 hour — a single episode, mid-window
  }

  depends_on = [null_resource.audio_visqol_push]
}

output "audio_visqol_job_definition_arn" {
  value = aws_batch_job_definition.audio_visqol_def.arn
}
