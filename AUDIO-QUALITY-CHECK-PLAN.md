# Audio Quality Check (ViSQOL) — Plan

A per-episode **"Calculate"** button on the `/audio` dashboard that measures the
perceptual quality of the **already-encoded** 64k HE-AAC rendition against the
source, using **ViSQOL** (the open-source, full-band audio analogue of VMAF).

**Purpose = quality verification, NOT re-encoding.** We do not re-transcode anything.
We read the rendition that already exists in the public bucket, score it against
the source master, and surface the MOS so an operator can confirm the single 64k HE-AAC
rung is good enough for spoken word (≈4.7 = transparent) — and catch any episode where it
isn't. (The ladder was cut to a single 64k rung on the strength of these scores; the
worker still scores every rung the master lists, so it keeps working if the ladder is ever
widened again.)

This is the audio counterpart to the video VMAF research worker (`research-worker/`), but
**on-demand and measurement-only** — no bitrate search, no Step Functions, no re-encode.

---

## 0. Decisions locked

- **Button = "Calculate"**, per episode, on `/audio`. Scores the existing rendition; never re-encodes.
- **Metric = ViSQOL, audio mode (48 kHz full-band).** NOT speech mode (16 kHz narrowband would
  ignore exactly the high-frequency detail AAC trades away). Chosen over POLQA (licensed,
  telephony-tuned, ~14 kHz ceiling) and PEAQ. ViSQOL is free, full-band, built for codec-vs-source
  fidelity — the exact question here.
- **Execution = AWS Batch**, the same primitive the video research worker uses
  (`search_orchestrator.py:451` `submit_job`). ViSQOL + ffmpeg decode is too heavy/slow for a
  Next.js App Runner route or a Lambda.
- **Inputs fetched over plain HTTPS, no GCP creds.** Source = `podcast_showcache.episodes[].audio_url`
  (public CloudFront). Renditions = the public bucket copy made by `_publish_to_public_bucket`
  (`gcp_check_audio_status.py:40-44`), which copies the **whole** `output/<id>/` set (master +
  variant playlists + every `.m4s`). Verified the segments are public, so ffmpeg can decode the
  variant `.m3u8` directly.
- **Coverage default = a middle ~180s window** (`VISQOL_SEGMENT=mid-180s`), env-overridable to
  full file. ViSQOL on a full 1-hour podcast is slow and memory-heavy; for consistent
  spoken word a middle window tracks the whole episode. Episodes shorter than the window are
  scored in full.
- **ViSQOL runs on mono 48 kHz.** Both source and rendition are downmixed to mono before scoring
  (see §6, Gap G2). Acceptable for spoken word; stereo-image differences are not measured.
- **Source format is auto-detected per episode (`.wav` or `.mp3`).** The worker `ffprobe`s the
  source, records `source_codec`/`source_sr`, and decodes whichever it is to the common mono-48 kHz
  reference. **An MP3 source is a *lossy reference*** — the AAC renditions are scored against an
  already-lossy master, so absolute MOS is bounded by the MP3 and the score is flagged accordingly
  (see §6, Gap G8). The score stays useful as a relative read either way.
- **ViSQOL binary = built from source (Bazel), pinned, in a Dockerfile build stage** (no official
  prebuilt image). Pin the release + similarity model for reproducible scores (Q-Q1 resolved).
- **No re-encode, no ladder change applied automatically.** The button produces data; humans
  decide the ladder.

---

## 1. End-to-end flow

```
[Calculate] button (per episode, dashboard/app/audio/page.js)
   │  enabled only when episode.public === true (a real https master URL exists)
   │  POST /api/audio/visqol { episodeId }
   ▼
API route (dashboard/app/api/audio/visqol/route.js)
   │  read chai_q_lab.audio_episodes.public_master_url   (the https master)
   │  read master.podcast_showcache.episodes[].audio_url (the source)
   │  stamp audio_episodes.visqol.status = "CALCULATING"
   │  Batch SubmitJob (audio-visqol job-def, existing queue) with env overrides
   ▼
audio-visqol-worker (AWS Batch container)
   1. fetch master.m3u8 (https) → parse #EXT-X-MEDIA:TYPE=AUDIO URIs → {64} (every rung listed)
   2. ffmpeg decode source audio_url        → ref.wav   (mono, 48k, windowed)
   3. ffmpeg decode each variant .m3u8      → deg_<k>.wav(mono, 48k, windowed)
   4. trim AAC encoder delay so lengths align
   5. ViSQOL audio mode (one run per rung) → MOS-LQO per rung
   6. write scores → audio_episodes.visqol + audio_visqol_research; status="DONE"
      (any failure → status="FAILED" + error)
   ▼
dashboard polls /api/audio/episodes → renders the score:
   64k (HE-AAC) 4.69 MOS
```

No Step Functions changes. No re-transcode. No GCP credentials in the worker.

---

## 2. Components to build

### 2.1 `audio-visqol-worker/` (new) — worker.py + Dockerfile
Modeled on `research-worker/`. Same static-ffmpeg Lambda/Batch base image **plus a ViSQOL stage**.
- **Env in:** `EPISODE_ID`, `MASTER_URL`, `SOURCE_URL`, `MONGO_URI`, optional `VISQOL_SEGMENT`
  (default `mid-180s`), optional `VISQOL_MODE` (`audio`).
- **Writes:** `chai_q_lab.audio_episodes.visqol` (summary for the UI) and
  `chai_q_lab.audio_visqol_research` (one doc per rung per run, history for aggregation).
- **Self-stamps** `CALCULATING`→`DONE`/`FAILED`; wraps the whole body in try/except so a crash
  still records `FAILED` + message (mirrors `_stamp_failed` in the audio Lambdas).

### 2.2 `aws-infra/batch-job.tf` — new job definition
`aws_batch_job_definition` `audio-visqol` pointing at the new image, **reusing the existing
job queue / compute environment**. Size memory generously (ViSQOL is memory-heavy; see G5).

### 2.3 `dashboard/app/api/audio/visqol/route.js` (new)
Mirror `convert/route.js`, but use `@aws-sdk/client-batch` `SubmitJobCommand` instead of
`StartExecutionCommand`. Resolve `public_master_url` (must be set) + `audio_url`; stamp
`visqol.status="CALCULATING"`; submit with `containerOverrides.environment`. Reject with a clear
error if `public_master_url` is empty (publish hasn't run — see G1).

### 2.4 `dashboard/app/api/audio/episodes/route.js` (edit)
Add `visqol: byId[e.id]?.visqol || null` to the per-episode payload. No new endpoint needed for display.

### 2.5 `dashboard/app/audio/page.js` (edit)
- **Calculate** button per episode, **disabled unless `episode.public === true`** (tooltip:
  "publish the public copy first").
- On click → POST `/api/audio/visqol`; show spinner while `visqol.status === "CALCULATING"`;
  poll the episodes endpoint; render the per-rung MOS score(s); show `FAILED` + error inline.

---

## 3. Master-playlist parsing (the URL the operator sees)

Input master (relative URIs, resolved against the master URL's directory):
```
#EXT-X-MEDIA:TYPE=AUDIO,...,NAME="Audio 64k",...,URI="audio_64k.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,...                       ← ignored
#EXT-X-STREAM-INF:...  audio_64k.m3u8                 ← ignored
```
Rules:
- Read **only `#EXT-X-MEDIA:TYPE=AUDIO`** lines; take each `URI=`.
- **Ignore `TYPE=SUBTITLES` and all `EXT-X-STREAM-INF`** lines → "sometimes without subtitles"
  is a non-issue; we never touch subtitle entries.
- Rung number from the **filename** (`audio_(\d+)k\.m3u8`), not the `NAME` label (robust to label edits).
- Resolve relative URIs against the master URL directory; fetch each variant + segments over HTTPS.

---

## 4. Data model

```js
// chai_q_lab.audio_episodes  (UI summary; one per episode)
visqol: {
  status: "DONE",                                   // CALCULATING | DONE | FAILED
  mode: "audio",
  segment: "mid-180s",
  scores: { "64": 4.69 },                           // MOS-LQO per rung (one rung = 64k)
  source_codec: "pcm_s16le", source_sr: 48000,      // caveat surface (lossy source caps MOS)
  computed_at: "2026-05-29T...",
  error: null,
  batch_job_id: "..."                               // for debugging a stuck CALCULATING
}

// chai_q_lab.audio_visqol_research  (history; one per rung per run → enables aggregation, §6 G6)
{ episode_id, rung_kbps, codec, visqol_mos, mode, segment,
  source_codec, source_sr, batch_job_id, timestamp }
```

---

## 5. ViSQOL correctness rules (baked into the worker)

1. **Audio mode, 48 kHz both sides** — never `--use_speech_mode`. Resample the source to 48 kHz
   (renditions are already 48 kHz).
2. **Mono** — downmix source and rendition to one channel; ViSQOL audio mode scores a single channel.
3. **Trim AAC encoder delay** — AAC adds priming (~2112 samples for LC) + padding, so the decoded
   rendition is shifted/longer than the source. Trim the leading delay and match durations before
   scoring, else alignment degrades the MOS artificially.
4. **64k rung is HE-AAC v1 (SBR)** — decoding reconstructs full band; the score is valid. Record
   `codec: "aac-he"` for the 64k rung (`aac-lc` for any rung above 64k if the ladder is widened).
5. **Pin the ViSQOL version + similarity model** in the image so scores are comparable across
   episodes and over time.
6. **Auto-detect the source codec** (`ffprobe`) — `.wav` or `.mp3`. Decode either to the common
   mono-48 kHz reference; record `source_codec`. If MP3, the reference is lossy → flag the score
   (Gap G8); the score is still useful as a relative read.

---

## 6. Gaps & risks (found in the end-to-end review) + mitigations

| # | Gap / risk | Mitigation |
|---|------------|------------|
| **G1** | `public_master_url` is **best-effort** (`gcp_check_audio_status.py:97-99`). If publish failed, it's empty and the episodes route falls back to a `gs://` path the worker can't fetch over HTTPS. | **Gate the button on `episode.public === true`.** API route rejects if `public_master_url` is empty. Surface "publish first". |
| **G2** | ViSQOL audio mode is **mono**; renditions are stereo (`channel_count=2`). Feeding stereo silently mis-scores or errors. | **Downmix both sides to mono 48 kHz.** Documented limitation: stereo-image differences not measured (irrelevant for podcasts). |
| **G3** | **AAC encoder delay / length mismatch** between source and rendition degrades alignment → artificially low MOS. | Trim leading priming + match durations before ViSQOL (§5.3). |
| **G4** | **ViSQOL build** (Bazel) is heavy/fragile; missing model file → runtime failure. | Pin a known-good ViSQOL release + model in a Dockerfile build stage; verify `visqol --help` in CI/build. Or use a vetted prebuilt image. |
| **G5** | **Memory / time** — a full 1-hr file can OOM or run long on the shared Batch compute env. | Default `mid-180s` window; size the `audio-visqol` job-def memory above the video worker (8192 MB); full-file behind an explicit env flip. |
| **G6** | **Single-episode scores don't decide a ladder** — the ladder choice needs a distribution across many episodes. | `audio_visqol_research` history collection accumulates per-run scores; a future aggregate view (mean/percentile per rung across a show) is the actual decision surface. Per-episode button is the data-gathering tool. |
| **G7** | **Stuck `CALCULATING`** if the container is OOM-killed before it can stamp `FAILED`. | Store `batch_job_id` + `computed_at` on submit; UI treats a `CALCULATING` older than a threshold as stale and re-enables the button. Worker wraps body in try/except for the common failure path. |
| **G8** | **MP3 source = lossy reference.** When `audio_url` is `.mp3`, AAC renditions are scored against an already-lossy master; absolute MOS is capped by the MP3 and can read misleadingly "high" (AAC faithfully reproduces a degraded source). | Auto-detect via `ffprobe`; store `source_codec`; **flag MP3-sourced scores in the UI** (e.g. "vs MP3 source — relative only"). Treat absolute MOS cautiously; the score is still a useful relative read. |

Residual (accepted): audio QC jobs **share the Batch queue** with video research jobs and compete
for slots; acceptable given on-demand, low frequency.

---

## 7. IAM / deploy / config

- **IAM (new):** the App Runner role currently has only `states:StartExecution` (used by
  `convert`/`run-show`). Add **`batch:SubmitJob`** (scoped to the audio-visqol job-def + queue).
- **App Runner env (new):** `BATCH_JOB_QUEUE_ARN` (reuse video's), `AUDIO_VISQOL_JOB_DEFINITION_ARN`.
- **Worker env:** `MONGO_URI`, `EPISODE_ID`, `MASTER_URL`, `SOURCE_URL`, `VISQOL_SEGMENT`,
  `VISQOL_MODE` — all passed as Batch `containerOverrides.environment` (no secrets; HTTPS-only inputs).
- **Build/deploy:** new image to ECR; `terraform apply` for the job-def + IAM; dashboard image
  rebuild (App Runner auto-redeploys). Fits the existing `deploy.sh` flow.
- **No GCP credentials** in the worker — both inputs are public HTTPS.

---

## 8. Build order

1. **Worker + Dockerfile** (`audio-visqol-worker/`) — core logic. **Testable standalone**: run the
   container against one episode's real `public_master_url` + `audio_url`, print the score.
   Validate the 64k rung lands ~4.5–4.7 for clean (WAV-sourced) speech before any infra.
2. **Batch job-def + IAM** (`aws-infra/batch-job.tf`) — `audio-visqol` def, `batch:SubmitJob` on App Runner role.
3. **API route** (`/api/audio/visqol`) — SubmitJob + `CALCULATING` stamp + `public` guard.
4. **Episodes route** — surface `visqol`.
5. **Frontend** — Calculate button (gated on `public`), spinner/poll, MOS score, error inline.
6. *(later, optional)* **Aggregate view** over `audio_visqol_research` for the actual ladder decision (G6).

---

## 9. Open questions — RESOLVED

- **Q-Q1 (ViSQOL binary):** ✅ Build from source via Bazel, pinned, in a Dockerfile build stage
  (no prebuilt image). Pin release + model (§5.5).
- **Q-Q2 (source format):** ✅ Source is **either `.wav` or `.mp3`** — auto-detect per episode via
  `ffprobe`, record `source_codec`, flag MP3 (lossy reference) in the UI (Gap G8, §5.6).
- **Q-Q3 (coverage):** ✅ Default `mid-180s` window, env-overridable to full file (G5).

All three resolved → no blockers to building the worker (§8 step 1).
