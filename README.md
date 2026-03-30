# Bitrater — Video Transcoding Optimization System

## What is this project?

Bitrater is a system that automatically finds the **best way to compress a video** without sacrificing visible quality, then produces the final streaming-ready video files for a CDN.

Instead of guessing "what bitrate should this video be at 1080p?", Bitrater runs many test encodes, measures the quality of each one with a score called VMAF, and picks the lowest bitrate that still looks good enough. This saves bandwidth and storage while keeping quality high.

Once the best settings are found, Bitrater uses Google Cloud's video transcoder to produce the final HLS (streaming) files and pushes them to a CDN so viewers can watch.

---

## The two pipelines at a glance

```
[Source Video on S3]
        │
        ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  PIPELINE 1 — Research / Lab  (runs on AWS)                     │
  │                                                                  │
  │  Test many bitrates at 1080p / 720p / 480p for H.264 and H.265  │
  │  Measure quality of each encode with VMAF                        │
  │  Pick the winner (lowest bitrate that meets quality threshold)   │
  │  Save the "golden recipe" to MongoDB                             │
  └─────────────────────────────────────────────────────────────────┘
        │
        ▼  (golden recipe is now in MongoDB)
        │
  ┌─────────────────────────────────────────────────────────────────┐
  │  PIPELINE 2 — Production / GCP  (runs on Google Cloud)          │
  │                                                                  │
  │  Copy source video from S3 → Google Cloud Storage               │
  │  Run GCP Transcoder using the golden recipe settings             │
  │  Copy HLS output to CDN                                          │
  │  Inject subtitles                                                │
  │  Save final .m3u8 URL to MongoDB                                 │
  └─────────────────────────────────────────────────────────────────┘
        │
        ▼
  [Video is live on CDN — ready to stream]
```

Both pipelines run **separately for H.264 and H.265**. A user can run either or both codecs.

---

## How the lab finds the best bitrate (adaptive binary search)

This is the core intelligence of Bitrater. The lab does **not** blindly test every possible bitrate. Instead it uses a smart search that starts with a few strategic probes and narrows down to the answer, terminating early as soon as it is confident — and cancelling any running jobs that are no longer needed.

### The bitrate candidate space

Each resolution has a fixed list of candidate bitrates and a small set of "initial probes":

| Codec | Resolution | All candidates (kbps) | Initial probes |
|-------|------------|-----------------------|----------------|
| H.264 | 1080p | 1800, 2000, 2300, 2500, 2700, 3000, 3300, 3600, 3900, 4200 | 2300, 3000, 3900 |
| H.264 | 720p  | 700, 900, 1100, 1300, 1500, 1700, 1900 | 1100, 1700 |
| H.264 | 480p  | 200, 300, 400, 500, 600 | **400 only** |
| H.265 | 1080p | 800, 1000, 1200, 1500, 1800, 2100, 2300, 2600, 2900, 3200 | 1200, 2100, 2900 |
| H.265 | 720p  | 500, 700, 900, 1200, 1350, 1500, 1650 | 900, 1500 |
| H.265 | 480p  | 100, 200, 300, 400, 500 | **300 only** |

The initial probes are spread across low, mid, and high bitrates to quickly reveal the shape of the VMAF curve for that video.

### The three phases

Each resolution independently moves through these phases:

```
PROBING  ──► LOWER_SEARCH  ──► FINAL
         └─► HIGHER_SEARCH ──► FINAL
```

---

#### Phase 1 — PROBING

The search starts by submitting only the initial probes. When results come back, the orchestrator looks at the **lowest submitted bitrate** first:

**Case A: The lowest probe PASSES the VMAF threshold**

The video looks good even at a low bitrate. The answer might be even lower, so the system moves to `LOWER_SEARCH`.

**Special case — instant termination:** If the lowest probe passes *and* there are no lower candidates in the list, the search is done immediately with just that one job. Example: H.264 480p starts with a single probe at 400 kbps. If it passes, 480p is finalized with 1 encode job total — no further testing needed.

**Case B: The lowest probe FAILS and a higher probe PASSES**

Now we know the winner is somewhere between a known fail and a known pass. The system moves to `HIGHER_SEARCH` with a bracket `[low_fail, high_pass]`.

**Case C: All probes fail**

The system submits the next higher candidate one at a time until something passes, or exhausts all candidates and picks the best available.

---

#### Phase 2a — LOWER_SEARCH (searching downward)

Goal: find the absolute minimum bitrate that still passes.

- The current passing bitrate becomes the "anchor".
- The orchestrator picks 1–2 candidates below the anchor (the lowest and the middle of the remaining space).
- If a lower bitrate passes → it becomes the new anchor, and the search goes even lower.
- If all lower candidates fail → the anchor is the winner. Done.
- Any PENDING jobs above the current winner are **cancelled immediately** (AWS Batch `terminate_job`).

```
Candidates: [1800, 2000, 2300, 2500, 2700, 3000]
Anchor = 2300 (PASS)
           ↓
Submit 1800 and 2000
1800 FAIL, 2000 PASS → new anchor = 2000
           ↓
Submit 1800 (already failed) — no lower candidates
Winner = 2000 kbps ✓
```

---

#### Phase 2b — HIGHER_SEARCH (binary search within a bracket)

Goal: find the lowest passing bitrate within a known fail-pass bracket.

The orchestrator picks the **middle** untested candidate between `[low_fail, high_pass]` — classic binary search. Each test tightens the bracket.

```
Bracket: [2300 FAIL, 3900 PASS]
Candidates between: 2500, 2700, 3000, 3300, 3600
Pick middle → submit 3000

3000 PASS → bracket becomes [2300, 3000]
Pick middle → submit 2700

2700 FAIL → bracket becomes [2700, 3000]
Pick middle → submit 2900 (if available, else gap is done)
...
```

**Early termination conditions in HIGHER_SEARCH:**

1. **Gap is small enough**: If `high_pass − low_fail ≤ 100 kbps` AND the winning VMAF is within 3 points of the threshold → close enough, stop immediately.
2. **No candidates left between bracket**: The boundary is already as precise as the candidate list allows.
3. **Max tests reached**: If 10 jobs have been run for this resolution, the best result found so far wins.

---

### Job cancellation (discard)

Whenever the search makes a decision, pending jobs that are no longer relevant are **actively cancelled**:

- When lowest probe passes → all higher-bitrate pending jobs are discarded.
- When LOWER_SEARCH finds a new lower winner → all pending jobs above it are discarded.
- When HIGHER_SEARCH tightens its bracket → jobs outside the new bracket are discarded.

This is done via `_discard_jobs()` which calls AWS Batch `terminate_job` for each pending job, then marks it as `DISCARDED` in the search state so it is never counted or waited on again.

---

### The polling loop (Step Function)

The search runs inside a polling Step Function (`step_function_def_search.json`):

```
InitSearch (submit initial probes)
     │
     ▼
  Wait 15s (first 3 polls) / 25s (after)
     │
     ▼
CheckAndDecide (resolve pending, decide next jobs)
     │
     ├─ all_done = true ──► CalculateGoldenRecipe ──► END
     │
     ├─ poll_count < 600 ──► (loop back to Wait)
     │
     └─ poll_count ≥ 600 ──► SetTimeoutError ──► MarkLabFailed
```

Each `CheckAndDecide` invocation:
1. Checks AWS Batch job statuses for all PENDING bitrates.
2. Reads VMAF results from MongoDB for completed jobs.
3. Runs `_decide_resolution()` for each resolution that is not yet FINAL.
4. Submits new jobs and cancels irrelevant ones.
5. Returns `all_done = true` when all three resolutions are FINAL.

The maximum wall-clock time is capped at 600 poll cycles × ~25 seconds ≈ ~4 hours.

---

### End-to-end example: what actually runs for one episode

For H.264, in the best case (fast video with predictable quality curve):

| Resolution | Jobs run | Jobs cancelled | Total |
|------------|----------|----------------|-------|
| 480p  | 1 (only probe passes immediately) | 0 | **1** |
| 720p  | 2–4 (probes + a few refinements) | 0–2 | ~3 |
| 1080p | 3–6 (probes + binary search) | 1–4 | ~5 |

In the worst case (VMAF jumps unpredictably): up to 10 jobs per resolution = 30 total.

Compare this to the old approach: always 21 fixed jobs per codec, regardless of the video.

---

## Concepts you need to know

### VMAF
VMAF (Video Multi-Method Assessment Fusion) is a quality score that compares an encoded video to the original. A higher score means the encoded version looks closer to the source.

This project uses VMAF to decide which bitrate is "good enough":

| Resolution | Minimum VMAF score required |
|------------|----------------------------|
| 1080p      | 88                         |
| 720p       | 75                         |
| 480p       | 48                         |

If no candidate bitrate meets the threshold, the one with the highest VMAF is chosen as a fallback.

### HLS
HLS (HTTP Live Streaming) is a video format used for streaming on the web and mobile. The final output is a `.m3u8` playlist file that links to short video segments. The CDN hosts these files and a player fetches them.

### Codec
A codec is the algorithm used to compress video. This project supports:
- **H.264 (libx264)** — widely compatible, larger file size
- **H.265 (libx265)** — better compression, smaller file size, newer hardware required

### Golden Recipe
The output of the lab pipeline. It stores the winning bitrate for each resolution and codec:
```json
{
  "resolutions": {
    "1080p": { "h264": { "bitrate_kbps": 3200, "vmaf_attained": 90.1 } },
    "720p":  { "h264": { "bitrate_kbps": 1800, "vmaf_attained": 78.4 } },
    "480p":  { "h264": { "bitrate_kbps": 900,  "vmaf_attained": 52.0 } }
  }
}
```

---

## Repository structure

```
bitrater/
├── dashboard/          # Next.js web UI + all API routes
│   └── app/api/
│       ├── push/       # Starts the lab (research) pipeline
│       ├── gcp/        # Starts the GCP (production) pipeline
│       ├── status/     # Lab progress for an episode
│       ├── gcp-status/ # GCP job progress for an episode
│       ├── shows/      # Lists shows and episodes
│       └── stop-lab/   # Cancels a running lab
│
├── orchestrator/       # Python Lambda functions that do the actual work
│   ├── aggregator.py           # Reads VMAF results and picks winners
│   ├── mark_lab_failed.py      # Writes failure state to MongoDB
│   ├── gcp_copy_s3_to_gcs.py  # Copies source from S3 to Google Cloud Storage
│   ├── gcp_transcoder.py       # Submits GCP Transcoder job
│   ├── gcp_check_status.py     # Polls GCP Transcoder until done
│   ├── gcp_finalize_hls.py     # Copies output to CDN, injects subtitles, saves URL
│   ├── search_orchestrator.py  # Search pipeline orchestrator
│   ├── step_function_def_h264.json   # AWS Step Function definition for H.264 lab
│   ├── step_function_def_h265.json   # AWS Step Function definition for H.265 lab
│   └── gcp_step_function_def.json    # AWS Step Function definition for GCP pipeline
│
├── research-worker/    # Docker container that runs one encode+VMAF job
│   ├── worker.py       # Downloads source, encodes with FFmpeg, measures VMAF, writes to MongoDB
│   ├── Dockerfile      # Container image for AWS Batch
│   └── requirements.txt
│
├── configs/            # FFmpeg encoding parameters per codec
│   ├── h264_heavy.json
│   └── h265_heavy.json
│
├── aws-infra/          # Terraform — defines all AWS infrastructure
│   ├── main.tf         # Provider and core config
│   ├── batch-job.tf    # AWS Batch compute environment and job queues
│   ├── lambda.tf       # All Lambda functions
│   ├── apprunner.tf    # Dashboard hosting (App Runner)
│   ├── ecr.tf          # Container image registries
│   ├── iam_roles.tf    # Permissions
│   └── variables.tf    # Input variables (MONGO_URI, GCP settings, etc.)
│
├── deploy.sh           # Full deployment script (GCP setup + Terraform + images)
├── deploy.env.example  # Template for local secrets (copy to .env.deploy)
└── DEPLOY-SECRETS.md   # What to do if credentials are leaked
```

---

## Full end-to-end flow (detailed)

### Step 1 — User opens the dashboard

The dashboard (Next.js, hosted on AWS App Runner) shows a list of shows and episodes fetched from `master.showcache` in MongoDB. Each episode has a source video file stored on S3.

### Step 2 — User clicks "Run Lab" for a codec (H.264 or H.265)

The UI calls `POST /api/push` with:
```json
{ "episodeId": "abc123", "s3Url": "https://...", "codec": "h264" }
```

The API:
1. Validates that a lab isn't already running for this codec.
2. Clears any previous VMAF results and golden recipe for this codec in MongoDB.
3. Sets `lab_status_h264 = RUNNING` in the episode document.
4. Starts the codec-specific AWS Step Function (`SFN_ARN_H264` or `SFN_ARN_H265`).

### Step 3 — AWS Step Function runs an adaptive binary search

The Step Function (defined in `step_function_def_search.json`) does **not** run all possible bitrates upfront. It runs a smart search loop managed by `orchestrator/search_orchestrator.py`.

**First iteration:** Submits only the "initial probes" — 1 to 3 strategic bitrate samples per resolution (e.g., just 1 job for 480p, 2 for 720p, 3 for 1080p). Total initial jobs: roughly 6 instead of all candidates.

**Each subsequent poll (every 15–25 seconds):** Checks which jobs finished, reads their VMAF scores, and decides what to do next — submit more targeted jobs, tighten a bracket, or declare a winner and cancel the rest.

The search terminates a resolution as soon as it is confident. Running jobs that are no longer useful are actively cancelled via AWS Batch `terminate_job`.

Each job runs the **research-worker** Docker container.

See the **"How the lab finds the best bitrate"** section above for the full algorithm detail.

### Step 4 — Research worker encodes and measures VMAF

For each job, `research-worker/worker.py`:

1. Downloads the source video from S3 (`source.mp4`).
2. Runs a **two-pass FFmpeg encode** at the assigned bitrate and resolution.
3. Runs **FFmpeg + libvmaf** to compare the encoded output to the original and produce a VMAF score.
4. Writes the result to MongoDB `chai_q_lab.video_vmaf_research`:
   ```json
   {
     "episode_id": "abc123",
     "codec": "libx264",
     "resolution": "1080p",
     "bitrate_kbps": 3200,
     "vmaf_score": 90.1,
     "vmaf_timeline": [88.2, 91.5, ...]
   }
   ```

### Step 5 — Aggregator picks the golden recipe

After all batch jobs finish, the Step Function calls `orchestrator/aggregator.py` as a Lambda. It:

1. Reads all VMAF results for the episode and codec from MongoDB.
2. For each resolution, finds the **lowest bitrate that meets the VMAF threshold** (or the best available if none meet it).
3. Saves the winning bitrate as the **golden recipe** in `chai_q_lab.video_episodes`.
4. Calculates efficiency gain (how much smaller H.265 is vs H.264, when both are available).
5. Sets `lab_status_h264 = COMPLETE`.

If the Step Function fails, `mark_lab_failed.py` sets `lab_status_h264 = FAILED` and records the error.

### Step 6 — User clicks "Run GCP" to produce the final video

Once the lab is complete, the dashboard shows a "Run GCP" button. The UI calls `POST /api/gcp` with the episode ID and codec.

The API:
1. Checks that a golden recipe exists for the requested codec.
2. Starts the GCP Step Function (`GCP_SFN_ARN`).

### Step 7 — GCP pipeline produces HLS files

The GCP Step Function (`gcp_step_function_def.json`) runs four Lambda functions in sequence:

**7a. `gcp_copy_s3_to_gcs.py`**
- Streams the source video from S3 to Google Cloud Storage at:
  `gs://chai-q-transcoder-input/{episode_id}/source.mp4`

**7b. `gcp_transcoder.py`**
- Reads the golden recipe from MongoDB.
- Builds a GCP Transcoder job config with one stream per resolution/bitrate from the recipe.
- Submits the job to GCP Transcoder API.
- Sets `gcp_job_status_h264 = RUNNING` in MongoDB.

**7c. `gcp_check_status.py`**
- Polls the GCP Transcoder job status until it reaches a terminal state (SUCCEEDED or FAILED).

**7d. `gcp_finalize_hls.py`**
- Deletes any old HLS files for this codec from the CDN bucket.
- Copies the transcoded HLS segments and manifests from GCS output bucket to the CDN bucket (`chai-shots-manifests`).
- Fetches subtitle VTT files from a subtitles database (`gld2sqs.subtitles`), uploads them to GCS, and generates subtitle playlists.
- Patches the master `.m3u8` manifest to include subtitle track entries.
- Saves the final CDN URL to MongoDB:
  - `h264_master_m3u8_url = "https://cdn.chaishots.in/..."`
- Sets `gcp_job_status_h264 = SUCCEEDED`.

### Step 8 — Video is live

The CDN URL is stored in MongoDB and shown in the dashboard. A video player can fetch `https://cdn.chaishots.in/{show}/{episode}/h264_master.m3u8` to start streaming.

---

## Full flow diagram

```mermaid
flowchart TD
    START[Episode in dashboard] --> LABDECIDE{Run Lab — which codec?}

    LABDECIDE -->|H264| LABH264[POST /api/push codec=h264]
    LABDECIDE -->|H265| LABH265[POST /api/push codec=h265]

    LABH264 --> SFNH264[Step Function SFN_ARN_H264]
    LABH265 --> SFNH265[Step Function SFN_ARN_H265]

    SFNH264 --> BATCH264[21 AWS Batch jobs — libx264 ladder]
    SFNH265 --> BATCH265[21 AWS Batch jobs — libx265 ladder]

    BATCH264 --> VMAF[(chai_q_lab.video_vmaf_research)]
    BATCH265 --> VMAF

    VMAF --> AGG[aggregator.py — pick winners]
    AGG --> EPDB[(chai_q_lab.video_episodes\ngolden_recipes + lab_status = COMPLETE)]

    SFNH264 -->|error| FAIL[mark_lab_failed.py\nlab_status = FAILED]
    SFNH265 -->|error| FAIL
    FAIL --> EPDB

    EPDB --> GCPBTN[User clicks Run GCP]
    GCPBTN --> APIGCP[POST /api/gcp\nvalidate golden recipe exists]

    APIGCP --> GCPSFN[GCP Orchestrator Step Function]

    GCPSFN --> COPY[gcp_copy_s3_to_gcs.py\nS3 → GCS input bucket]
    COPY --> TRANSCODE[gcp_transcoder.py\nsubmit GCP Transcoder job]
    TRANSCODE --> POLL[gcp_check_status.py\npoll until SUCCEEDED or FAILED]
    POLL -->|FAILED| GCPFAIL[JobFailed + gcp_error saved]
    POLL -->|SUCCEEDED| FINALIZE[gcp_finalize_hls.py]

    FINALIZE --> CDN[(cdn.chaishots.in\nHLS segments + master + subtitles)]
    CDN --> DONE[URL saved in MongoDB\nPlayback ready]
```

---

## Database (MongoDB)

### `master.showcache`
Show and episode catalog. Contains the S3 URL for each episode's source file. This is the starting point — the dashboard reads from here to list episodes.

### `chai_q_lab.video_vmaf_research`
One document per encode job. Stores the VMAF score, bitrate, resolution, and codec for every test run by the research worker.

### `chai_q_lab.video_episodes`
The main state document per episode. Updated throughout both pipelines:

| Field | What it means |
|-------|--------------|
| `lab_status_h264` / `lab_status_h265` | `RUNNING`, `COMPLETE`, or `FAILED` |
| `lab_execution_arn_h264` | ARN of the running Step Function execution |
| `lab_error_h264` | Error message if lab failed |
| `golden_recipes.resolutions` | Winning bitrate per resolution and codec |
| `efficiency_gain` | How much smaller H.265 is vs H.264 per resolution |
| `gcp_job_status_h264` / `gcp_job_status_h265` | `RUNNING`, `SUCCEEDED`, or `FAILED` |
| `gcp_job_name_h264` | GCP Transcoder job name |
| `gcp_error_h264` | Error if GCP job failed |
| `h264_master_m3u8_url` | Final CDN URL for H.264 HLS stream |
| `h265_master_m3u8_url` | Final CDN URL for H.265 HLS stream |

### `gld2sqs.subtitles`
Optional. Subtitle VTT source URLs per episode. Read by `gcp_finalize_hls.py` to inject subtitles into the HLS master manifest.

---

## Infrastructure (AWS + GCP)

### AWS (managed by Terraform in `aws-infra/`)

| Resource | Purpose |
|----------|---------|
| **App Runner** | Hosts the Next.js dashboard |
| **ECR** | Container image registry (dashboard + research worker) |
| **AWS Batch** | Runs research worker containers for encode jobs |
| **Lambda** | Runs orchestrator Python functions (aggregator, mark_lab_failed, all GCP steps) |
| **Step Functions** | Orchestrates the lab and GCP pipelines |
| **Secrets Manager** | Stores GCP service account credentials |
| **IAM** | Permissions for all of the above |

### Google Cloud

| Resource | Purpose |
|----------|---------|
| **Cloud Storage** (`chai-q-transcoder-input`) | Receives source video copied from S3 |
| **Cloud Storage** (`chai-q-transcoder-output`) | Receives transcoded HLS output from GCP Transcoder |
| **Cloud Storage** (`chai-shots-manifests`) | CDN origin bucket — serves HLS to viewers |
| **Transcoder API** | Does the actual H.264/H.265 encoding at production quality |
| **Service Account** (`chai-q-transcoder`) | GCP identity used by all Lambda functions |

---

## Prerequisites

Before running anything you need:

- **AWS CLI** configured with credentials for account `107647021172`
- **Google Cloud CLI** (`gcloud`) authenticated to project `media-cdn-poc-466009`
- **Docker** (for building container images)
- **Terraform** (for managing AWS infrastructure)
- **Node.js** (for running the dashboard locally)
- **MongoDB Atlas** connection string (URI)

---

## First-time setup and deployment

### 1. Set up secrets

```bash
cp deploy.env.example .env.deploy
```

Edit `.env.deploy` and fill in your MongoDB URI:
```
MONGO_URI='mongodb+srv://USER:PASSWORD@cluster.mongodb.net/master?retryWrites=true&w=majority'
```

Never commit `.env.deploy` — it is gitignored.

### 2. Run full deployment

```bash
./deploy.sh
```

This script does everything in order:

| Step | What happens |
|------|-------------|
| 1a | Enables GCP Transcoder API |
| 1b | Creates GCS input and output buckets |
| 1c | Creates GCP service account with Transcoder + Storage permissions |
| 1d | Creates GCP service account key and stores it in AWS Secrets Manager |
| 2 | Builds Lambda layers (pymongo, google-cloud libs) and runs `terraform apply` |
| 3 | Builds and pushes the research worker Docker image to ECR |
| 4 | Builds and pushes the dashboard Docker image to ECR |

At the end it prints the dashboard URL.

---

## Running the dashboard locally (development)

```bash
cd dashboard
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

You need these environment variables set locally (in a `.env.local` file inside `dashboard/`):

```
MONGO_URI=...
AWS_REGION=us-east-1
SFN_ARN_H264=arn:aws:states:...
SFN_ARN_H265=arn:aws:states:...
GCP_SFN_ARN=arn:aws:states:...
```

---

## Deploying after making changes

| What you changed | Command to run |
|-----------------|----------------|
| Dashboard UI or API only | `./dashboard/deploy.sh` |
| Orchestrator Python, Step Functions, or Terraform | `./deploy.sh` (full deploy) |
| Terraform only (`aws-infra/`) | `cd aws-infra && terraform apply -auto-approve -var="mongo_uri=..."` |
| Research worker only (`research-worker/`) | `./deploy.sh` or rebuild and push the worker image manually |

---

## How to use the dashboard (normal day-to-day flow)

1. Open the dashboard URL.
2. Select a show, then an episode.
3. Click **Run Lab — H264** (or H265) to start research.
   - The dashboard shows per-resolution progress as batch jobs complete.
   - Status moves from `RUNNING` → `COMPLETE` (or `FAILED`).
4. Once lab is complete, click **Run GCP — H264** to produce the final video.
   - Status shows `RUNNING` then `SUCCEEDED`.
5. The final CDN URL appears in the dashboard. The video is ready to stream.

You can run H264 and H265 labs in parallel — they are independent.

---

## Verification checklist

### After a lab run
- Episode status in dashboard shows `COMPLETE` for the codec.
- `chai_q_lab.video_vmaf_research` has rows for that episode and codec.
- `chai_q_lab.video_episodes.golden_recipes.resolutions` has entries for the codec at 1080p, 720p, and 480p.

### After a GCP run
- `gcp_job_status_h264` (or `h265`) is `SUCCEEDED`.
- `h264_master_m3u8_url` exists in `video_episodes`.
- Opening the URL loads an HLS playlist with segments served from `cdn.chaishots.in`.
- Subtitles appear in the player if subtitle records were available.

---

## Debugging guide

When something breaks, check in this order:

1. **Dashboard API response** — does `/api/push` or `/api/gcp` return an error? The JSON body usually explains what is missing.
2. **Step Function execution history** — open AWS Console → Step Functions → find the execution → check which state failed and what the error was.
3. **Lambda / Batch job logs** — CloudWatch logs for the failing Lambda or the AWS Batch job container.
4. **MongoDB state** — check `video_episodes` for error fields like `lab_error_h264` or `gcp_error_h265`.
5. **GCS / CDN output** — if the GCP job succeeded but the video doesn't play, check whether `.m3u8` and segment files exist in the CDN bucket (`chai-shots-manifests`).

---

## Security notes

- Never commit `.env.deploy` or any file with real credentials.
- GCP service account credentials live in AWS Secrets Manager (not in code).
- If a credential leaks, see `DEPLOY-SECRETS.md` for the rotation procedure.
