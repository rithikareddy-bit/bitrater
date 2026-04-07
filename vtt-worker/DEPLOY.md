# vtt-worker — build & deploy (Cloud Run)

Use **build context `vtt-worker/`** (not repo root).

Replace `PROJECT_ID`, `REGION` (e.g. `asia-south1`), and repository name as needed.

## 1. Local build (sanity check)

```bash
cd /path/to/bitrater
docker build -f vtt-worker/Dockerfile -t vtt-worker:local vtt-worker
```

## 2. GCP: configure CLI once

```bash
gcloud config set project PROJECT_ID
gcloud auth login
gcloud services enable run.googleapis.com artifactregistry.googleapis.com
```

## 3. Artifact Registry repository (one-time)

```bash
gcloud artifacts repositories create vtt-docker \
  --repository-format=docker \
  --location=REGION \
  --description="VTT worker images" \
  2>/dev/null || true
```

## 4. Configure Docker for Artifact Registry

```bash
gcloud auth configure-docker REGION-docker.pkg.dev
```

## 5. Build for linux/amd64 (recommended for Cloud Run)

```bash
cd /path/to/bitrater
docker build --platform linux/amd64 -f vtt-worker/Dockerfile -t REGION-docker.pkg.dev/PROJECT_ID/vtt-docker/vtt-worker:latest vtt-worker
```

## 6. Push image

```bash
docker push REGION-docker.pkg.dev/PROJECT_ID/vtt-docker/vtt-worker:latest
```

## 7. Deploy to Cloud Run

Attach a service account that can **write** to `VTT_GCS_BUCKET` (and read Mongo from Atlas).

```bash
gcloud run deploy vtt-worker \
  --image REGION-docker.pkg.dev/PROJECT_ID/vtt-docker/vtt-worker:latest \
  --region REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 4Gi \
  --timeout 900 \
  --set-env-vars "MONGO_URI=YOUR_ATLAS_URI,VTT_GCS_BUCKET=media-cdn-poc-466009-sprites,VTT_GCS_PREFIX=output/webp/"
```

Add `VTT_WORKER_SECRET=...` to `--set-env-vars` if you use auth. **Do not** put `VTT_GOOGLE_APPLICATION_CREDENTIALS` in Cloud Run — use **Service account** on the Cloud Run service instead.

## 8. Get the URL (for dashboard `VTT_WORKER_URL`)

```bash
gcloud run services describe vtt-worker --region REGION --format 'value(status.url)'
```

Set that value as **`VTT_WORKER_URL`** (and matching **`VTT_WORKER_SECRET`** on dashboard + worker if used) where the Next.js app runs.

## 9. Dashboard

`deploy.sh` does **not** deploy this service. Set **`VTT_WORKER_URL`** in your dashboard container / hosting env separately.
