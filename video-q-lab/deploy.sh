#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Transcoding Optimization — Full Deployment Script
# ============================================================
# Run from: video-q-lab/
# Prerequisites: gcloud, aws cli, docker, terraform all installed
#
# Secrets are NOT in this repo. Either:
#   • Create .env.deploy (gitignored): cp deploy.env.example .env.deploy
#   • Or: export MONGO_URI='...' before running
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env.deploy" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/.env.deploy"
  set +a
fi
if [[ -z "${MONGO_URI:-}" ]]; then
  echo "ERROR: MONGO_URI is not set."
  echo "  Copy deploy.env.example → .env.deploy and set MONGO_URI, or export MONGO_URI."
  exit 1
fi

# Optional — pass empty string if not set so Terraform uses the default.
ALERT_EMAIL="${ALERT_EMAIL:-}"

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

echo "[1c] Creating GCP service account..."
gcloud iam service-accounts create "${GCP_SA_NAME}" \
  --project="${GCP_PROJECT}" 2>/dev/null || echo "  (service account already exists)"

gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
  --member="serviceAccount:${GCP_SA_EMAIL}" \
  --role="roles/transcoder.admin" --quiet

gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
  --member="serviceAccount:${GCP_SA_EMAIL}" \
  --role="roles/storage.admin" --quiet

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
echo "  Secret ARN: ${SECRET_ARN}"

echo ""
echo "========================================"
echo "STEP 2: Terraform Apply"
echo "========================================"

cd aws-infra

echo "[2a] Creating Terraform remote state bucket (idempotent)..."
# us-east-1 is the default S3 region and must NOT specify LocationConstraint.
aws s3api create-bucket \
  --bucket "chai-q-terraform-state-${AWS_ACCOUNT}" \
  --region "${AWS_REGION}" \
  2>/dev/null || true
aws s3api put-bucket-versioning \
  --bucket "chai-q-terraform-state-${AWS_ACCOUNT}" \
  --versioning-configuration Status=Enabled 2>/dev/null || true
aws s3api put-bucket-encryption \
  --bucket "chai-q-terraform-state-${AWS_ACCOUNT}" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' \
  2>/dev/null || true

echo "[2b] Creating DynamoDB lock table (idempotent)..."
aws dynamodb create-table \
  --table-name chai-q-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "${AWS_REGION}" \
  2>/dev/null || true

echo "[2c] Cleaning old Lambda layers (will be rebuilt via Docker for Linux x86_64)..."
rm -rf .pymongo-layer .pymongo-layer.zip .gcp-layer .gcp-layer.zip

terraform init -upgrade

TF_VARS=(
  -var="mongo_uri=${MONGO_URI}"
  -var="gcp_project=${GCP_PROJECT}"
  -var="gcp_location=${GCP_LOCATION}"
  -var="gcs_input_bucket=${GCS_INPUT_BUCKET}"
  -var="gcs_output_bucket=${GCS_OUTPUT_BUCKET}"
  -var="gcp_credentials_secret_arn=${SECRET_ARN}"
  -var="alert_email=${ALERT_EMAIL}"
)

echo "[2d] Running terraform plan..."
terraform plan -out=tfplan "${TF_VARS[@]}"

echo ""
echo "Review the plan above."
echo "Applying in 10 seconds — press Ctrl-C to abort."
sleep 10

terraform apply tfplan
rm -f tfplan

echo ""
echo "========================================"
echo "STEP 3: Push Research Worker Image"
echo "========================================"

cd ..

aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ECR_BASE}"

# Both Dockerfiles use paths relative to the project root (e.g. COPY research-worker/...,
# COPY dashboard/..., COPY configs/...), so the build context must be video-q-lab/.
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
echo ""
echo "Note: sync_subs_step_4.py and sync_cache_step_5.py are manual utilities for"
echo "batch subtitle migration workflows. The GCP Lambda pipeline (gcp_finalize_hls)"
echo "handles subtitle upload and sync automatically per-episode via S3_SUBTITLES_BUCKET."
echo "To use them manually: python3 sync_subs_step_4.py <show-slug>"
