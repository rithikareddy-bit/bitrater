#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Transcoding Optimization — Full Deployment Script
# ============================================================
# Run from: bitrater/ (project root)
# Prerequisites: gcloud, aws cli, docker, terraform all installed
#
# Secrets are NOT in this repo. Terraform variables (mongo_uri, subtitle_mongo_uri,
# cdn_base, bucket names, secret ARNs) live in aws-infra/terraform.tfvars, which
# Terraform loads automatically — they are NOT passed from the shell.
# .env.deploy is optional and only supplies shell-side values (e.g. AUDIO_BUCKET).
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/scripts/guard_no_aws_deploy.sh"
if [[ -f "${SCRIPT_DIR}/.env.deploy" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/.env.deploy"
  set +a
fi
# terraform.tfvars is the real prerequisite — Terraform prompts (or fails the
# validation blocks in variables.tf) without it. Check it up front rather than
# 5 minutes into a deploy, at Step 2.
if [[ ! -f "${SCRIPT_DIR}/aws-infra/terraform.tfvars" ]]; then
  echo "ERROR: aws-infra/terraform.tfvars not found."
  echo "  It holds mongo_uri, subtitle_mongo_uri, cdn_base, bucket names and secret ARNs."
  echo "  Terraform reads it automatically; without it Step 2 cannot run."
  exit 1
fi

# Terraform var is gcp_credentials_secret_arn. Prefer .env.deploy export GCP_CREDENTIALS_SECRET_ARN
# so it matches deploy secrets; otherwise Step 1d creates/updates the secret and we use its ARN.
if [[ -n "${GCP_CREDENTIALS_SECRET_ARN:-}" ]]; then
  GCP_SECRET_ARN_FOR_TF="${GCP_CREDENTIALS_SECRET_ARN}"
else
  GCP_SECRET_ARN_FOR_TF=""
fi

GCP_PROJECT="media-cdn-poc-466009"
GCP_LOCATION="asia-south1"
GCS_INPUT_BUCKET="chai-q-transcoder-input"
GCS_OUTPUT_BUCKET="chai-q-transcoder-output"
GCP_SA_NAME="chai-q-transcoder"
GCP_SA_EMAIL="${GCP_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"

AWS_ACCOUNT="107647021172"
AWS_REGION="us-east-1"
ECR_BASE="${AWS_ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "========================================"
echo "STEP 1: One-time GCP Setup"
echo "========================================"

echo "[1a] Enabling Transcoder API..."
gcloud services enable transcoder.googleapis.com --project="${GCP_PROJECT}"

echo "[1b] Creating GCS buckets..."
gcloud storage buckets create "gs://${GCS_INPUT_BUCKET}" \
  --project="${GCP_PROJECT}" --location="${GCP_LOCATION}" 2>/dev/null || echo "  (input bucket already exists)"
gcloud storage buckets create "gs://${GCS_OUTPUT_BUCKET}" \
  --project="${GCP_PROJECT}" --location="${GCP_LOCATION}" 2>/dev/null || echo "  (output bucket already exists)"
AUDIO_BUCKET="${AUDIO_BUCKET:-chai-q-audio-transcoder}"
gcloud storage buckets create "gs://${AUDIO_BUCKET}" \
  --project="${GCP_PROJECT}" --location="${GCP_LOCATION}" 2>/dev/null || echo "  (audio bucket already exists)"

# Public preview bucket for audio renditions — dashboard plays from here via
# https://storage.googleapis.com/<bucket>/<id>/audio_master.m3u8. Renditions only,
# no source masters. Uniform bucket-level access + allUsers:objectViewer so the
# HLS manifest opens without signing.
AUDIO_PUBLIC_BUCKET="${AUDIO_PUBLIC_BUCKET:-chai-q-audio-public}"
gcloud storage buckets create "gs://${AUDIO_PUBLIC_BUCKET}" \
  --project="${GCP_PROJECT}" --location="${GCP_LOCATION}" \
  --uniform-bucket-level-access 2>/dev/null || echo "  (audio public bucket already exists)"
gcloud storage buckets add-iam-policy-binding "gs://${AUDIO_PUBLIC_BUCKET}" \
  --member="allUsers" --role="roles/storage.objectViewer" --quiet >/dev/null

echo "[1c] Creating GCP service account..."
gcloud iam service-accounts create "${GCP_SA_NAME}" \
  --project="${GCP_PROJECT}" 2>/dev/null || echo "  (service account already exists)"

gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
  --member="serviceAccount:${GCP_SA_EMAIL}" \
  --role="roles/transcoder.admin" --quiet

gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
  --member="serviceAccount:${GCP_SA_EMAIL}" \
  --role="roles/storage.admin" --quiet

if [[ -n "${GCP_SECRET_ARN_FOR_TF}" ]]; then
  echo "[1d] Using existing GCP secret from .env.deploy (GCP_CREDENTIALS_SECRET_ARN); skipping new key upload."
  echo "  Secret ARN: ${GCP_SECRET_ARN_FOR_TF}"
else
  echo "[1d] Creating service account key and storing in AWS Secrets Manager..."
  KEY_FILE="/tmp/gcp-key-$$.json"
  gcloud iam service-accounts keys create "${KEY_FILE}" \
    --iam-account="${GCP_SA_EMAIL}"

  SECRET_ARN=$(aws secretsmanager create-secret \
    --name "chai-q-gcp-credentials" \
    --secret-string "file://${KEY_FILE}" \
    --region "${AWS_REGION}" \
    --query 'ARN' --output text 2>/dev/null || \
    aws secretsmanager put-secret-value \
    --secret-id "chai-q-gcp-credentials" \
    --secret-string "file://${KEY_FILE}" \
    --region "${AWS_REGION}" && \
    aws secretsmanager describe-secret \
    --secret-id "chai-q-gcp-credentials" \
    --region "${AWS_REGION}" \
    --query 'ARN' --output text)

  rm -f "${KEY_FILE}"
  GCP_SECRET_ARN_FOR_TF="${SECRET_ARN}"
  echo "  Secret ARN: ${GCP_SECRET_ARN_FOR_TF}"
fi

# Terraform reads gcp_credentials_secret_arn from terraform.tfvars, not from
# this variable. On an existing stack the secret is stable and they already
# agree; this only bites when the secret is recreated with a new ARN.
TFVARS_ARN=$(grep -E '^[[:space:]]*gcp_credentials_secret_arn' "${SCRIPT_DIR}/aws-infra/terraform.tfvars" 2>/dev/null | cut -d'"' -f2 || true)
if [[ -n "${GCP_SECRET_ARN_FOR_TF}" && -n "${TFVARS_ARN}" && "${TFVARS_ARN}" != "${GCP_SECRET_ARN_FOR_TF}" ]]; then
  echo ""
  echo "  WARNING: terraform.tfvars gcp_credentials_secret_arn does not match the ARN above."
  echo "    tfvars: ${TFVARS_ARN}"
  echo "    actual: ${GCP_SECRET_ARN_FOR_TF}"
  echo "    Terraform will use the tfvars value. Update terraform.tfvars before continuing."
fi

echo ""
echo "========================================"
echo "STEP 2: Terraform Apply"
echo "========================================"

cd aws-infra

echo "[2a] Building Lambda layers if missing (pymongo, gcp deps)..."
if [ ! -d .pymongo-layer ]; then
  mkdir -p .pymongo-layer/python
  docker run --rm --platform linux/amd64 --entrypoint pip \
    -v "$(pwd)/.pymongo-layer/python:/out" \
    public.ecr.aws/lambda/python:3.11 \
    install "pymongo[srv]==4.6.1" -t /out --quiet
fi
if [ ! -d .gcp-layer ]; then
  mkdir -p .gcp-layer/python
  docker run --rm --platform linux/amd64 --entrypoint pip \
    -v "$(pwd)/.gcp-layer/python:/out" \
    public.ecr.aws/lambda/python:3.11 \
    install "google-cloud-video-transcoder>=1.0.0" "google-cloud-storage>=2.0.0" "pymongo[srv]==4.6.1" "requests>=2.31.0" -t /out --quiet
fi

terraform init -upgrade

# Variables come from aws-infra/terraform.tfvars, which Terraform loads
# automatically. Do NOT pass them with -var from the shell: an unset shell
# variable expands to "" and an explicit -var OUTRANKS terraform.tfvars, so a
# missing .env.deploy entry silently blanks the value instead of failing. That
# is how `-var="mongo_uri=${MONGO_URI}"` can wipe MONGO_URI from all 10
# resources that consume it — including the App Runner dashboard. The
# validation blocks in variables.tf now reject empty values at plan time, but
# the flags themselves are the bug, so they are gone.
terraform apply -auto-approve

echo ""
echo "========================================"
echo "STEP 3: Push Research Worker Image"
echo "========================================"

cd ..

aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_BASE}"

docker build --platform linux/amd64 -f research-worker/Dockerfile -t chai-q-worker .
docker tag chai-q-worker:latest "${ECR_BASE}/chai-q-worker:latest"
docker push "${ECR_BASE}/chai-q-worker:latest"

echo ""
echo "========================================"
echo "STEP 4: Push Dashboard Image"
echo "========================================"

docker build --platform linux/amd64 -f dashboard/Dockerfile -t chai-q-dashboard .
docker tag chai-q-dashboard:latest "${ECR_BASE}/chai-q-dashboard:latest"
docker push "${ECR_BASE}/chai-q-dashboard:latest"

echo ""
echo "========================================"
echo "DEPLOYMENT COMPLETE"
echo "========================================"
echo ""
echo "Dashboard URL:"
cd aws-infra && terraform output dashboard_url
cd ..
echo ""
echo "Next: Open the dashboard → pick an episode → Run Lab (21 jobs) → Run GCP"
