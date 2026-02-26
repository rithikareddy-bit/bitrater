#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../aws-infra"

echo "==> Getting Amplify app ID from Terraform outputs..."
APP_ID=$(terraform -chdir="$INFRA_DIR" output -raw amplify_app_id)
echo "    App ID: $APP_ID"

echo "==> Installing dependencies..."
cd "$SCRIPT_DIR"
npm ci

echo "==> Building Next.js app..."
npm run build

echo "==> Creating deployment zip..."
ZIP_PATH="/tmp/chai-q-dashboard-$(date +%s).zip"
zip -r "$ZIP_PATH" .next public package.json next.config.js jsconfig.json 2>/dev/null || true
echo "    Zip: $ZIP_PATH ($(du -sh "$ZIP_PATH" | cut -f1))"

echo "==> Creating Amplify deployment..."
RESPONSE=$(aws amplify create-deployment \
  --region us-east-1 \
  --app-id "$APP_ID" \
  --branch-name main \
  --output json)

UPLOAD_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['zipUploadUrl'])")
JOB_ID=$(echo "$RESPONSE"    | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")
echo "    Job ID: $JOB_ID"

echo "==> Uploading build artifacts..."
curl -s -T "$ZIP_PATH" "$UPLOAD_URL"
echo "    Upload complete."

echo "==> Starting deployment..."
aws amplify start-deployment \
  --region us-east-1 \
  --app-id "$APP_ID" \
  --branch-name main \
  --job-id "$JOB_ID" \
  --output json > /dev/null

DEFAULT_DOMAIN=$(aws amplify get-app \
  --region us-east-1 \
  --app-id "$APP_ID" \
  --query 'app.defaultDomain' \
  --output text)

echo ""
echo "Deployed! Job $JOB_ID is running."
echo "URL: https://main.$DEFAULT_DOMAIN"
echo "(Check status: aws amplify get-job --app-id $APP_ID --branch-name main --job-id $JOB_ID)"

rm -f "$ZIP_PATH"
