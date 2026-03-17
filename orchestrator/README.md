# Bitrater / Chai-Q Lab — Full Process Guide

This document explains the **entire video pipeline** from raw upload to final HLS URLs. It is written so that even a beginner can follow the flow, find the important code, and understand how each piece fits together.

---

## Table of Contents

1. [What This Project Does](#what-this-project-does)
2. [Prerequisites](#prerequisites)
3. [High-Level Architecture](#high-level-architecture)
4. [Pipeline 1: Research (VMAF Lab)](#pipeline-1-research-vmaf-lab)
5. [Pipeline 2: GCP Transcoder (Production HLS)](#pipeline-2-gcp-transcoder-production-hls)
6. [Important Code Reference](#important-code-reference)
7. [Environment Variables & Secrets](#environment-variables--secrets)
8. [Deployment](#deployment)
9. [How to Verify Everything Works](#how-to-verify-everything-works)

---

## What This Project Does

- **Input:** A source video file (e.g. MP4) uploaded to an S3 bucket (or an episode chosen from the dashboard).
- **Research pipeline (VMAF lab):** Runs **21 encoding jobs in parallel** (different codecs, bitrates, resolutions). Each job computes VMAF quality scores. An **aggregator** picks the best bitrate per resolution/codec that meets quality thresholds and saves **golden recipes** to MongoDB.
- **GCP pipeline:** Uses those **golden recipes** to run **Google Cloud Transcoder** and produce HLS (`.m3u8` + segments). Output is copied to a CDN bucket, subtitles are injected, and final manifest URLs are written to MongoDB.

So: **Research finds the best encoding settings; GCP turns the same source into production-ready HLS using those settings.**

---

## Prerequisites

- **AWS:** Account, CLI configured, Terraform.
- **GCP:** Project, `gcloud` CLI, Transcoder API enabled, GCS buckets.
- **Docker:** For building Lambda layers (Linux x86_64) and worker/dashboard images.
- **MongoDB:** Two databases used:
  - `chai_q_lab` — episode state, golden recipes, VMAF results, final HLS URLs.
  - `gld2sqs` (subtitle DB) — VTT file URLs for subtitles (optional).

---

## High-Level Architecture

```
                    ┌─────────────────────────────────────────────────────────────────┐
                    │                         AWS                                       │
                    │  ┌──────────────┐     ┌──────────────────────────────────────┐   │
                    │  │ S3 Raw Input │     │ Step Function: Chai-Q-Orchestrator   │   │
                    │  │ (upload)    │────▶│ (Research pipeline)                  │   │
                    │  └──────┬───────┘     │  • GenerateLadder → 21 items         │   │
                    │         │             │  • ParallelResearch → Map → Batch    │   │
                    │         │             │  • CalculateGoldenRecipe → Lambda    │   │
                    │         ▼             └──────────────────┬───────────────────┘   │
                    │  ┌──────────────┐                         │                      │
                    │  │ Lambda       │ StartExecution           │                      │
                    │  │ (S3 trigger) │─────────────────────────┘                      │
                    │  └──────────────┘                                                │
                    │         │                                                        │
                    │         │  Golden recipes in MongoDB (chai_q_lab.video_episodes)│
                    │         │                                                        │
                    │  ┌──────▼───────────────────────────────────────────────────┐  │
                    │  │ Dashboard (App Runner)                                     │  │
                    │  │ • Start Research SFN  • Start GCP SFN  • List Batch jobs  │  │
                    │  └──────┬───────────────────────────────────────────────────┘  │
                    │         │ StartExecution(GCP-Orchestrator)                      │
                    │         ▼                                                      │
                    │  ┌──────────────────────────────────────────────────────────┐  │
                    │  │ Step Function: GCP-Orchestrator                          │  │
                    │  │  1. CopySourceToGCS (Lambda)  S3 → GCS                   │  │
                    │  │  2. SubmitGCPJob (Lambda)     Create Transcoder job       │  │
                    │  │  3. Wait 60s → CheckJobStatus (Lambda) → Choice           │  │
                    │  │  4. SUCCEEDED → FinalizeHLS (Lambda) → CDN + subtitles    │  │
                    │  └──────────────────────────────────────────────────────────┘  │
                    └─────────────────────────────────────────────────────────────────┘
                                         │
                                         │  GCP Transcoder API
                                         ▼
                    ┌─────────────────────────────────────────────────────────────────┐
                    │  GCP                                                             │
                    │  • Transcoder job: 6 video streams (H.264 + H.265 × 3 res)     │
                    │  • Output: gs://GCS_OUTPUT_BUCKET/{episode_id}/                  │  │
                    │  • FinalizeHLS copies to CDN bucket, patches m3u8, writes URLs  │  │
                    └─────────────────────────────────────────────────────────────────┘
```

---

## Pipeline 1: Research (VMAF Lab)

**Purpose:** Find the best bitrate per resolution and codec (H.264 / H.265) that meets VMAF quality thresholds.

**Trigger:**  
- **Option A:** Upload a video to the S3 raw-input bucket → S3 event invokes the trigger Lambda → Lambda starts the Research Step Function.  
- **Option B:** From the dashboard, start the Research pipeline for an episode (same Step Function, different input source).

**Definition file:** `orchestrator/step_function_def.json`

### Flow (step by step)

| Step | State name           | What happens |
|------|----------------------|--------------|
| 1    | **GenerateLadder**   | Pass state that outputs a fixed array of **21 items**. Each item has `codec`, `bitrate`, `resolution` (e.g. `libx265`, `1000`, `1080`). |
| 2    | **ParallelResearch** | **Map** state over that array. Each iteration runs one **AWS Batch** job via `batch:submitJob.sync` (so Step Functions waits for the job to finish). |
| 3    | (Map) **RunBatchJob** | Submits one Batch job with env vars: `BITRATE`, `CODEC`, `RESOLUTION`, `S3_URL`, `EPISODE_ID`. The Batch job runs the research worker container (FFmpeg + VMAF), writes results to MongoDB. |
| 4    | **CalculateGoldenRecipe** | After all 21 jobs complete, a **Lambda** (aggregator) runs. It reads VMAF results from MongoDB, applies thresholds (e.g. 1080p ≥ 88, 720p ≥ 75, 480p ≥ 48), picks the lowest bitrate that meets the threshold per resolution/codec, and writes **golden_recipes** to `video_episodes`. |
| 5    | On error              | **MarkLabFailed** Lambda updates `video_episodes` with `lab_status: FAILED`, then **LabExecutionFailed** (Fail state). |

**Concurrency:** The Map state has `MaxConcurrency: 0` (unlimited). So **all 21 jobs run in parallel**. The Batch compute environment has `max_vcpus = 84` and each job uses 4 vCPUs, so 21 jobs can run at once. Total pipeline time is roughly the duration of the **slowest** job (~1–2 hours), not 21 × that.

### Important code (Research)

**1. S3 trigger — start Research execution**

- File: `orchestrator/lambda_trigger.py`
- On S3 upload, build `s3_url` and `episode_id`, then start the Research Step Function:

```python
response = sfn.start_execution(
    stateMachineArn=os.environ['STATE_MACHINE_ARN'],
    input=json.dumps({
        "s3_url": s3_url,
        "episode_id": episode_id,
        "timestamp": datetime.now(timezone.utc).isoformat()
    })
)
```

**2. Ladder definition (21 jobs)**

- File: `orchestrator/step_function_def.json` — `GenerateLadder` state `Result` array. Example entries:

```json
{"codec": "libx265", "bitrate": "1000", "resolution": "1080"},
{"codec": "libx264", "bitrate": "2000", "resolution": "1080"},
…
```

**3. Aggregator — golden recipe calculation**

- File: `orchestrator/aggregator.py`
- Reads from `db.video_vmaf_research` for the episode, applies thresholds, picks winner per resolution/codec:

```python
VMAF_THRESHOLDS = { "1080p": 88, "720p": 75, "480p": 48 }
RESOLUTIONS = ["1080p", "720p", "480p"]
CODECS = ["libx265", "libx264"]

# For each resolution/codec: lowest bitrate >= threshold, or highest VMAF below threshold
def find_winner(subset, threshold): ...
# Then: db.video_episodes.update_one(..., { "$set": { "golden_recipes": { "resolutions": resolutions_data }, ... } })
```

**4. Mark lab failed (on Map or aggregator error)**

- File: `orchestrator/mark_lab_failed.py`
- Updates `video_episodes` with `lab_status: "FAILED"` and `lab_error: cause` so the API/dashboard can show failure and allow retries.

---

## Pipeline 2: GCP Transcoder (Production HLS)

**Purpose:** Take the source video and **golden recipes** from the research pipeline, run GCP Transcoder to produce HLS (H.264 and H.265 master playlists), then copy to CDN, inject subtitles, and write final URLs to MongoDB.

**Trigger:** Started from the dashboard (or any client that can call `states:StartExecution` on the GCP-Orchestrator). Input must include `episode_id`, `s3_url`, and `golden_recipes` (from research).

**Definition file:** `orchestrator/gcp_step_function_def.json`

### Flow (step by step)

| Step | State name         | What happens |
|------|--------------------|--------------|
| 1    | **CopySourceToGCS**| Lambda streams the source from S3 to GCS: `gs://GCS_INPUT_BUCKET/{episode_id}/source.mp4`. Avoids Lambda /tmp 512MB limit by streaming. |
| 2    | **SubmitGCPJob**  | Lambda builds a Transcoder JobConfig from `golden_recipes` (6 video streams: 3 resolutions × 2 codecs, 1 audio stream, 2 HLS manifests), creates the job, writes `gcp_job_name` and `RUNNING` to MongoDB. |
| 3    | **WaitForJob**    | Wait 60 seconds. |
| 4    | **CheckJobStatus**| Lambda calls GCP Transcoder `get_job`, returns `gcp_job_state` (e.g. `SUCCEEDED`, `RUNNING`, `FAILED`). On `FAILED`, updates MongoDB with error and goes to JobFailed. |
| 5    | **IsComplete**    | Choice: if `SUCCEEDED` → **FinalizeHLS**; if `FAILED` → **JobFailed**; else → **WaitForJob** (loop). |
| 6    | **FinalizeHLS**   | Lambda: (1) Copy transcoder output from GCS output bucket to CDN bucket, (2) Fetch subtitle VTT URLs from subtitle MongoDB, download, upload to GCS, (3) Generate subtitle `.m3u8` playlists, (4) Patch `h264_master.m3u8` and `h265_master.m3u8` with subtitle tracks, (5) Write `h264_master_m3u8_url`, `h265_master_m3u8_url` and status to MongoDB. |
| 7    | **JobFailed**     | Fail state (GCP Transcoder job failed). |

### Important code (GCP pipeline)

**1. Copy S3 → GCS**

- File: `orchestrator/gcp_copy_s3_to_gcs.py`
- Parse S3 URL, get object stream, upload to GCS (no full file in /tmp):

```python
obj = s3.get_object(Bucket=s3_bucket, Key=s3_key)
# ...
blob.upload_from_file(obj["Body"], content_type="video/mp4")
# Returns: gcs_input_uri, episode_id, golden_recipes
```

GCP credentials come from AWS Secrets Manager: `GCP_CREDENTIALS_SECRET_ARN`.

**2. Submit GCP Transcoder job**

- File: `orchestrator/gcp_transcoder.py`
- Builds `JobConfig` from `golden_recipes["resolutions"]`: for each of 1080p/720p/480p, adds H.264 and H.265 elementary streams and mux streams, one shared AAC audio stream, and two manifests (`h264_master.m3u8`, `h265_master.m3u8`):

```python
output_uri = f"gs://{gcs_output_bucket}/{episode_id}/"
job_config = _build_job_config(gcs_input_uri, golden_recipes, output_uri)
response = client.create_job(parent=parent, job=job)
# DB: gcp_job_status=RUNNING, gcp_job_name=...
```

**3. Check job status**

- File: `orchestrator/gcp_check_status.py`
- Gets job from GCP, returns `gcp_job_state`. On `FAILED`, updates MongoDB with `gcp_job_status`, `gcp_error`, `gcp_finished_at`.

**4. Finalize HLS (copy to CDN, subtitles, patch manifests)**

- File: `orchestrator/gcp_finalize_hls.py`
- Copy: list blobs under `{episode_id}/` in output bucket, copy each to CDN bucket.
- Subtitles: read VTT URLs from subtitle MongoDB → download → upload to GCS CDN bucket as `subtitle_{lang}.vtt` and create `subtitle_{lang}.m3u8` playlists.
- Patch: for `h264_master.m3u8` and `h265_master.m3u8`, inject `#EXT-X-MEDIA:TYPE=SUBTITLES,...` and add `SUBTITLES="subtitles"` to `#EXT-X-STREAM-INF` lines.
- MongoDB update: `gcp_job_status: SUCCEEDED`, `h264_master_m3u8_url`, `h265_master_m3u8_url`, `subtitles_injected`, `gcp_finished_at`.

```python
# CDN URLs
h264_url = f"{CDN_BASE}/{gcs_prefix}/h264_master.m3u8"
h265_url = f"{CDN_BASE}/{gcs_prefix}/h265_master.m3u8"
db.video_episodes.update_one({"episode_id": episode_id}, {"$set": { ... }})
```

---

## Important Code Reference

| What | File | Entry / key lines |
|------|------|--------------------|
| S3 → start Research | `orchestrator/lambda_trigger.py` | `handler`: `sfn.start_execution(..., input=json.dumps({s3_url, episode_id}))` |
| Research state machine | `orchestrator/step_function_def.json` | GenerateLadder → ParallelResearch (Map) → CalculateGoldenRecipe |
| Batch job submission | `orchestrator/step_function_def.json` | `RunBatchJob`: `arn:aws:states:::batch:submitJob.sync` with `ContainerOverrides` for BITRATE, CODEC, RESOLUTION, S3_URL, EPISODE_ID |
| Golden recipe aggregation | `orchestrator/aggregator.py` | `handler`: read `video_vmaf_research`, `find_winner`, write `video_episodes.golden_recipes` |
| Mark lab failed | `orchestrator/mark_lab_failed.py` | `handler`: `video_episodes` update `lab_status: FAILED`, `lab_error` |
| GCP state machine | `orchestrator/gcp_step_function_def.json` | CopySourceToGCS → SubmitGCPJob → WaitForJob → CheckJobStatus → IsComplete (Choice) → FinalizeHLS or JobFailed or loop |
| S3 → GCS copy | `orchestrator/gcp_copy_s3_to_gcs.py` | `handler`: parse S3 URL, `get_object`, `blob.upload_from_file(obj["Body"])` |
| GCP job config & submit | `orchestrator/gcp_transcoder.py` | `_build_job_config`, `client.create_job`, update DB with `gcp_job_name`, RUNNING |
| Poll GCP job | `orchestrator/gcp_check_status.py` | `client.get_job(name=gcp_job_name)`, return `gcp_job_state`; on FAILED update DB |
| Finalize HLS | `orchestrator/gcp_finalize_hls.py` | Copy to CDN bucket, subtitle pipeline, patch master m3u8, set CDN URLs in MongoDB |
| GCP credentials | All GCP Lambdas | `GCP_CREDENTIALS_SECRET_ARN` → Secrets Manager → `service_account.Credentials.from_service_account_info(info)` |

---

## Environment Variables & Secrets

**Lambda / App Runner (set in Terraform or deploy):**

| Variable | Used by | Meaning |
|----------|--------|---------|
| `STATE_MACHINE_ARN` | S3 trigger Lambda | Research Step Function ARN |
| `MONGO_URI` | Aggregator, mark_lab_failed, all GCP Lambdas | MongoDB connection string (chai_q_lab) |
| `GCP_PROJECT` | GCP Lambdas | GCP project ID |
| `GCP_LOCATION` | GCP Transcoder Lambda | e.g. `us-central1`, `asia-south1` |
| `GCS_INPUT_BUCKET` | Copy Lambda | GCS bucket for source video |
| `GCS_OUTPUT_BUCKET` | Transcoder, CheckStatus, Finalize | GCS bucket for Transcoder output |
| `GCP_CREDENTIALS_SECRET_ARN` | All GCP Lambdas | AWS Secrets Manager ARN for GCP service account JSON |
| `SUBTITLE_MONGO_URI` | FinalizeHLS | MongoDB for subtitle VTT URLs (optional) |

**Terraform variables (e.g. `terraform.tfvars`):**  
`mongo_uri`, `gcp_project`, `gcp_location`, `gcs_input_bucket`, `gcs_output_bucket`, `gcp_credentials_secret_arn`, `subtitle_mongo_uri`.

---

## Deployment

From project root (`bitrater/`):

1. **Secrets:** Set `MONGO_URI` (and optionally other vars). Either copy `deploy.env.example` to `.env.deploy` or `export MONGO_URI='...'`.
2. **One-time GCP:** Run the GCP section of `deploy.sh` (or equivalent): enable Transcoder API, create GCS buckets, create service account, create key and store it in AWS Secrets Manager as `chai-q-gcp-credentials`, note the Secret ARN.
3. **Terraform:**  
   `cd aws-infra`  
   `terraform init -upgrade`  
   `terraform apply -auto-approve -var="mongo_uri=..." -var="gcp_project=..." ... -var="gcp_credentials_secret_arn=..."`
4. **Images:** Build and push research worker and dashboard to ECR (see `deploy.sh` steps 3 and 4).

Full script:

```bash
# From bitrater/
./deploy.sh
```

`deploy.sh` sources `.env.deploy` for `MONGO_URI`, does GCP setup, Terraform apply, then pushes worker and dashboard images.

---

## How to Verify Everything Works

**Research pipeline (21 jobs in parallel):**

- **Total time:** Should be ~1–2 hours (duration of slowest job). If it were sequential, it would be ~21× longer.
- **Step Functions:** Open an execution of **Chai-Q-Orchestrator**. The Map state should show 21 branches with start times close together.
- **AWS Batch:** In the Batch console, the run should show 21 jobs with similar start times and overlapping run times.
- **MongoDB:** After success, `chai_q_lab.video_episodes` for that `episode_id` should have `lab_status: COMPLETE` and `golden_recipes.resolutions` populated.

**GCP pipeline:**

- **Step Functions:** Start **GCP-Orchestrator** with input `{ "episode_id": "...", "s3_url": "s3://...", "golden_recipes": { "resolutions": { ... } } }`. Execution should go CopySourceToGCS → SubmitGCPJob → WaitForJob → CheckJobStatus (possibly multiple times) → FinalizeHLS.
- **MongoDB:** `video_episodes` should get `gcp_job_status: SUCCEEDED`, `h264_master_m3u8_url`, `h265_master_m3u8_url`.
- **CDN:** The returned URLs should serve the master playlists and segments (and subtitles if configured).

**End-to-end (beginner path):**

1. Upload a test video to the S3 raw-input bucket (or use the dashboard to start Research for an episode).
2. Wait for Research to complete; confirm `golden_recipes` in MongoDB.
3. From the dashboard, start the GCP pipeline for that episode.
4. When GCP-Orchestrator finishes, open the HLS URLs from MongoDB or the dashboard and play in an HLS-capable player.

---

*This README covers the full process: flow, important code lines, environment variables, deployment, and verification, so even a beginner can follow and run the pipeline.*
