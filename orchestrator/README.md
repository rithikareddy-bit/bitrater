# Bitrater Orchestrator - Current End-to-End Flow

This README explains the current working flow from source video to final CDN HLS URL, including:

- what VMAF means in this project,
- which files are responsible for each stage,
- which code points are important to read first,
- how to run locally,
- how to deploy based on what changed.

---

## 1) What this system does

Bitrater has two connected pipelines:

1. **Research pipeline (AWS)**  
   Runs many encode jobs, measures quality with VMAF, and writes "golden recipes" (best bitrate choice per resolution/codec) to MongoDB.

2. **Production pipeline (AWS -> GCP -> CDN)**  
   Uses those golden recipes to run GCP Transcoder, generates HLS, copies output to CDN storage, injects subtitles, and saves final `.m3u8` URLs in MongoDB.

The dashboard controls both and shows per-codec status (`h264`, `h265`) for each episode.

---

## Full end-to-end flowchart

The diagram below is in the same box-and-branch style you shared, with explicit **H264** and **H265** paths from Lab complete to GCP final URL.

```mermaid
flowchart TD
    START[Episode in dashboard<br/>from master.showcache] --> LABDECIDE{Run Lab for which codec?}

    LABDECIDE -->|H264| LABH264[POST /api/push<br/>codec=h264]
    LABDECIDE -->|H265| LABH265[POST /api/push<br/>codec=h265]

    LABH264 --> SFNH264[Step Function from SFN_ARN_H264]
    LABH265 --> SFNH265[Step Function from SFN_ARN_H265]

    SFNH264 --> BATCH264[AWS Batch research jobs<br/>libx264 ladder]
    SFNH265 --> BATCH265[AWS Batch research jobs<br/>libx265 ladder]

    BATCH264 --> VMAF[(chai_q_lab.video_vmaf_research)]
    BATCH265 --> VMAF

    VMAF --> AGG[aggregator.py<br/>writes golden_recipes + lab_status_*]
    AGG --> EPDB[(chai_q_lab.video_episodes)]

    SFNH264 -->|error| LABFAIL[mark_lab_failed.py<br/>lab_status_h264=FAILED]
    SFNH265 -->|error| LABFAIL2[mark_lab_failed.py<br/>lab_status_h265=FAILED]
    LABFAIL --> EPDB
    LABFAIL2 --> EPDB

    EPDB --> GCPBTN[User clicks Run GCP]
    GCPBTN --> GCPSEL{Codec selected in UI}

    GCPSEL -->|H264| APIGCP264[/api/gcp route.js<br/>validates h264 recipes]
    GCPSEL -->|H265| APIGCP265[/api/gcp route.js<br/>validates h265 recipes]

    APIGCP264 -->|missing selected codec recipe| ERR264[400: missing h264 golden recipe]
    APIGCP265 -->|missing selected codec recipe| ERR265[400: missing h265 golden recipe]

    APIGCP264 --> GCPSFN264[GCP-Orchestrator SFN<br/>codec=h264]
    APIGCP265 --> GCPSFN265[GCP-Orchestrator SFN<br/>codec=h265]

    subgraph GCP_H264["GCP path (H264 run)"]
      direction TB
      C264[gcp_copy_s3_to_gcs.py] --> T264[gcp_transcoder.py<br/>build h264-only job]
      T264 --> P264[gcp_check_status.py loop]
      P264 --> D264{state}
      D264 -->|FAILED| F264[JobFailed + gcp_error_h264]
      D264 -->|SUCCEEDED| Z264[gcp_finalize_hls.py<br/>writes h264_master_m3u8_url]
    end

    subgraph GCP_H265["GCP path (H265 run)"]
      direction TB
      C265[gcp_copy_s3_to_gcs.py] --> T265[gcp_transcoder.py<br/>build h265-only job]
      T265 --> P265[gcp_check_status.py loop]
      P265 --> D265{state}
      D265 -->|FAILED| F265[JobFailed + gcp_error_h265]
      D265 -->|SUCCEEDED| Z265[gcp_finalize_hls.py<br/>writes h265_master_m3u8_url]
    end

    GCPSFN264 --> C264
    GCPSFN265 --> C265

    Z264 --> CDN[(cdn.chaishots.in<br/>h264 master + segments + subtitles)]
    Z265 --> CDN2[(cdn.chaishots.in<br/>h265 master + segments + subtitles)]

    CDN --> DONE[Playback ready]
    CDN2 --> DONE
```

### Legend (quick read)

- Lab and GCP are both **codec-specific runs**.
- `/api/gcp` checks only the **selected codec** recipe (`h264` or `h265`), then starts one GCP execution.
- `gcp_finalize_hls.py` updates only that codec URL field in `video_episodes`.

---

## 2) VMAF in simple words

**VMAF** (Video Multi-Method Assessment Fusion) is a quality score used to compare encoded output to source quality.

- Score range is usually interpreted like: higher = closer to source quality.
- This project computes VMAF for each test encode in research.
- Aggregation logic picks the **lowest bitrate that still meets threshold quality**.
- Thresholds currently used in `orchestrator/aggregator.py`:
  - `1080p`: `88`
  - `720p`: `75`
  - `480p`: `48`

If no bitrate crosses threshold, the fallback is: choose the candidate with highest VMAF.

---

## 3) Current flow (seamless step-by-step)

### A. Lab / Research flow

Trigger options:

- S3 upload trigger via `orchestrator/lambda_trigger.py` (legacy entry path), or
- dashboard API `dashboard/app/api/push/route.js` (main operational path now, per codec).

Main sequence:

1. Dashboard calls `/api/push` with `episodeId`, `s3Url`, and `codec` (`h264` or `h265`).
2. `/api/push` starts codec-specific Step Function ARN (`SFN_ARN_H264` or `SFN_ARN_H265`).
3. Step Function runs map/batch encoding jobs.
4. Batch worker writes VMAF rows into `chai_q_lab.video_vmaf_research`.
5. `orchestrator/aggregator.py` selects winners and updates `chai_q_lab.video_episodes.golden_recipes`.
6. If failed, `orchestrator/mark_lab_failed.py` updates failure fields (codec-specific when codec exists).

Step Function files:

- `orchestrator/step_function_def.json`
- `orchestrator/step_function_def_h264.json`
- `orchestrator/step_function_def_h265.json`

### B. GCP production flow

Trigger:

- dashboard API `dashboard/app/api/gcp/route.js` with `episodeId` and `codec`.

Main sequence (`orchestrator/gcp_step_function_def.json`):

1. `gcp_copy_s3_to_gcs.py` - streams source from S3 to `gs://{GCS_INPUT_BUCKET}/{episode_id}/source.mp4`.
2. `gcp_transcoder.py` - builds codec-specific job config and submits GCP Transcoder job.
3. `gcp_check_status.py` - polls status until terminal.
4. `gcp_finalize_hls.py` - clears old codec files, copies output to CDN bucket, injects subtitles, patches master manifest, saves final URL in Mongo.

Output URLs stored in `chai_q_lab.video_episodes`:

- `h264_master_m3u8_url`
- `h265_master_m3u8_url`

---

## 4) Files you should know first

### Orchestrator core

- `orchestrator/aggregator.py`  
  Golden recipe logic and VMAF threshold decision.

- `orchestrator/mark_lab_failed.py`  
  Failure state writing (`lab_status_h264` / `lab_status_h265` or generic fallback).

- `orchestrator/gcp_transcoder.py`  
  Codec-specific GCP job config (`h264` only or `h265` only).

- `orchestrator/gcp_finalize_hls.py`  
  CDN copy + subtitle upload + manifest patch + final URL updates.

- `orchestrator/step_function_def*.json` and `orchestrator/gcp_step_function_def.json`  
  The workflow structure itself.

### Dashboard APIs that drive orchestration

- `dashboard/app/api/push/route.js`  
  Starts lab by codec, sets `lab_status_*`, stores execution ARN.

- `dashboard/app/api/status/[id]/route.js`  
  Computes progress from VMAF documents + status fields.

- `dashboard/app/api/gcp/route.js`  
  Starts GCP pipeline by codec, validates golden recipes exist.

- `dashboard/app/api/gcp-status/[id]/route.js`  
  Reads and normalizes GCP execution/job status.

---

## 5) Important code points (quick navigation)

These are the first lines/areas to inspect when debugging.

### Lab start and state machine selection

- `dashboard/app/api/push/route.js`
  - codec validation (`h264`/`h265`)
  - Step Function ARN pick:
    - `SFN_ARN_H264`
    - `SFN_ARN_H265`
  - writes:
    - `lab_status_${codec} = RUNNING`
    - `lab_execution_arn_${codec}`

### Golden recipe selection logic

- `orchestrator/aggregator.py`
  - `VMAF_THRESHOLDS`
  - `find_winner(subset, threshold)`
  - update keys:
    - `golden_recipes.resolutions.<res>.<codec>`
    - `lab_status_<codec> = COMPLETE`
    - `efficiency_gain`

### Lab fail path

- `orchestrator/mark_lab_failed.py`
  - if codec present:
    - `lab_status_h264` / `lab_status_h265`
    - `lab_error_h264` / `lab_error_h265`
  - else fallback:
    - `lab_status`
    - `lab_error`

### GCP job submission

- `orchestrator/gcp_transcoder.py`
  - `_build_job_config(..., codec)` chooses only one codec branch.
  - updates:
    - `gcp_job_status_${codec} = RUNNING`
    - `gcp_job_name_${codec}`

### GCP completion + URLs

- `orchestrator/gcp_finalize_hls.py`
  - codec-specific cleanup in CDN bucket
  - manifest patch for `${codec}_master.m3u8`
  - updates:
    - `${codec}_master_m3u8_url`
    - `gcp_job_status_${codec} = SUCCEEDED`
    - `gcp_finished_at_${codec}`

---

## 6) Data model essentials (MongoDB)

### `master.showcache`

- show catalog + episode metadata
- contains episode `s3_url`
- consumed by dashboard APIs

### `chai_q_lab.video_vmaf_research`

- each research encode output row
- used by aggregator for winner selection

### `chai_q_lab.video_episodes`

Main state document per episode:

- lab states: `lab_status_h264`, `lab_status_h265`, `lab_error_*`, `lab_execution_arn_*`
- recipe: `golden_recipes.resolutions`
- gcp states: `gcp_job_status_*`, `gcp_job_name_*`, `gcp_error_*`
- outputs: `h264_master_m3u8_url`, `h265_master_m3u8_url`

### `gld2sqs.subtitles` (optional)

- subtitle VTT source URLs used during finalize stage.

---

## 7) Run locally

### A. Dashboard local run

From `dashboard/`:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Required environment for dashboard APIs (in local env file):

- Mongo + AWS credentials + SFN ARNs for lab/GCP
- keys commonly used by code:
  - `AWS_REGION`
  - `SFN_ARN_H264`
  - `SFN_ARN_H265`
  - `GCP_SFN_ARN`

### B. Orchestrator local function testing (optional)

You can invoke Python handlers directly with test events, but they require:

- AWS credentials (Step Functions, Secrets Manager, S3 access),
- Mongo URI access,
- GCP credentials secret configured in AWS.

For real end-to-end behavior, use deployed infra and trigger from dashboard.

---

## 8) Deployment guide by change type

Use this section to decide the fastest safe deploy path.

### If you changed dashboard UI/API only

Use:

```bash
./dashboard/deploy.sh
```

What it does:

- gets dashboard ECR repo from Terraform output,
- builds dashboard image,
- pushes image to ECR,
- App Runner redeploys automatically.

### If you changed orchestrator Python, Step Functions, infra vars, or worker

Use full deploy:

```bash
./deploy.sh
```

What it does:

1. One-time/managed GCP setup steps
2. Terraform apply in `aws-infra`
3. Push research worker image
4. Push dashboard image

### If you changed only Terraform (`aws-infra/*`)

You may run only infra apply:

```bash
cd aws-infra
terraform init -upgrade
terraform apply -auto-approve -var="mongo_uri=..."
```

But if image tags or runtime behavior also changed, follow with relevant image deploy.

### If you changed only `research-worker/*`

Rebuild and push worker image (or run full `./deploy.sh` to keep everything consistent).

---

## 9) Required env/secrets (runtime)

Core runtime variables used across orchestrator/dashboard:

- `MONGO_URI`
- `GCP_PROJECT`
- `GCP_LOCATION`
- `GCS_INPUT_BUCKET`
- `GCS_OUTPUT_BUCKET`
- `GCP_CREDENTIALS_SECRET_ARN`
- `SUBTITLE_MONGO_URI` (optional for subtitles)
- `AWS_REGION`
- `SFN_ARN_H264`, `SFN_ARN_H265` (dashboard -> lab)
- `GCP_SFN_ARN` (dashboard -> GCP)

Do not commit real secrets to repo files.

---

## 10) Quick verification checklist

### After lab run

- In dashboard, codec status moves `RUNNING -> COMPLETE` (or `FAILED`).
- `video_vmaf_research` has rows for that episode+codec.
- `video_episodes.golden_recipes.resolutions` contains expected codec entries.

### After GCP run

- `gcp_job_status_<codec>` ends `SUCCEEDED`.
- `${codec}_master_m3u8_url` exists in `video_episodes`.
- URL opens and playlist/segments load from CDN.
- Subtitles appear if subtitle records were available.

---

## 11) Practical debugging order

When something breaks, check in this order:

1. Dashboard trigger API (`/api/push` or `/api/gcp`) response.
2. Step Function execution history.
3. Lambda logs for failing state.
4. Mongo `video_episodes` status/error fields.
5. GCS/CDN output objects for missing manifests/segments.

This sequence usually finds root cause fastest.
