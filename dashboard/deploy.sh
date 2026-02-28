#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../aws-infra"

echo "==> Getting ECR URL from Terraform outputs..."
ECR_URL=$(terraform -chdir="$INFRA_DIR" output -raw dashboard_ecr_url)
echo "    ECR: $ECR_URL"

echo "==> Authenticating Docker to ECR..."
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin "$ECR_URL"

echo "==> Building dashboard image (linux/amd64)..."
cd "$SCRIPT_DIR"
docker build --platform linux/amd64 -t chai-q-dashboard .

echo "==> Pushing to ECR..."
docker tag chai-q-dashboard:latest "$ECR_URL:latest"
docker push "$ECR_URL:latest"

echo ""
echo "Pushed! App Runner will redeploy automatically (check AWS Console for status)."

DASHBOARD_URL=$(terraform -chdir="$INFRA_DIR" output -raw dashboard_url 2>/dev/null || echo "")
if [ -n "$DASHBOARD_URL" ]; then
  echo "URL: $DASHBOARD_URL"
fi
