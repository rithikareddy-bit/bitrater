# Audio Pipeline — Plan

Take a podcast audio source (`podcast_showcache.episodes[].audio_url`) and produce a single
**HLS HE-AAC** rendition (64k). The pipeline is **100% GCP for processing** — GCP
Transcoder does both **loudness normalization** and the **AAC/HLS encode** in one managed job.
No ffmpeg, no Cloud Run worker. AWS provides only orchestration (Step Functions + Lambdas) and
the dashboard.

**Current scope = generate-only.** Renditions land in the audio bucket
(`gs://chai-q-audio-transcoder/output/<id>/`). Copying to the CDN bucket and Media-CDN
**signing are deliberately NOT built yet** (see §9 Deferred).

Decisions locked with the operator:
- **No MP3 fallback.** AAC in HLS plays on every targeted device.
- **Ladder = single 64k rung, HE-AAC v1 (mp4a.40.5)**, static (no per-source probe).
  (96k/128k dropped — ViSQOL showed 64k HE-AAC is already good enough for spoken word, so one
  rung keeps storage/bandwidth minimal; there is nothing to adapt between.)
- **48 kHz stereo**, loudness **−16 LUFS** (podcast standard).
- **GCP Transcoder does everything** (normalize + encode) — confirmed it supports LUFS via
  `Input.preprocessing_config.audio.lufs`. So **no ffmpeg/loudnorm step at all**.

---

## 1. Source & data model

Mongo (same `MONGO_URI`), DB `master`, collection **`podcast_showcache`** (verified live):
```
{ _id, id, title, slug, language,
  episodes: [ { id (UUID), title, episode_number, audio_url }, ... ] }   // audio_url = SOURCE
```
- **Read source** from `episodes[].audio_url` — a **public CloudFront HTTPS URL**
  (`d27vk6lpclibck.cloudfront.net/uploads/...`), not `s3://`. Verified fetchable (HTTP 200, no creds).
- Key all writes off **`episodes.id`** (UUID), like video's `showcache.episodes.id`.
- **Tracking collection:** `chai_q_lab.audio_episodes`, keyed by `episode_id` — holds
  `gcp_job_status`, `gcp_job_name`, `output_uri`, `ladder`, `lufs`, errors.
- **Never write to Sanity** (monitor-only). When signing is added later, the playback URL goes
  to `podcast_showcache.episodes[].signed_playback_url`.

---

## 2. Bitrate ladder (static — no probe)

- **`64k` only**, fixed from `AUDIO_LADDER_KBPS`. Every episode gets one rung (64k HE-AAC v1).
- **No ffprobe / no upsample-cap** (we removed ffmpeg entirely). A low-bitrate MP3 source still
  gets the 64k rung — no quality gain, no probe needed. Acceptable since masters are typically
  WAV / ≥64k. Re-introducing a cap later would need a GCP-native probe (input-info after submit)
  — deferred, not worth it now.
- 64k HE-AAC = transparent-enough for spoken word **and** a low-bandwidth floor in one rung.
  ViSQOL on a clean WAV source put 64k HE-AAC at ~4.69 MOS, so a second rung earns no audible
  gain. No rung above 64k.

---

## 3. State machines

Two Step Functions: a **per-show parent** (batch/concurrency) fanning out to the **per-episode
child** (the actual conversion). **No lab / no `golden_recipes`** — the ladder is fixed, so none
of the video research/quality-checker machinery is forked.

### 3.0 Per-show parent (`gcp_audio_show_batch_def.json`) — sliding window of 30
```
StartAt: ListEpisodes
  ListEpisodes -> ConvertAll
ConvertAll = Map:
  ItemsPath:      $.episodes              # [{episode_id, audio_url}, ...]
  MaxConcurrency: 30                      # 30 in flight; refills as each finishes
  ToleratedFailurePercentage: 100         # one bad episode never aborts the show
  ItemProcessor: ONE Task → states:startExecution.sync:2 of the §3.1 child
```
`Map` + `MaxConcurrency: 30` = the sliding window: 30 episodes at once, next starts as one
finishes, until the show is done. **The iterator starts the child as a *nested execution***
(not inlined) so the child's `Wait→Check` polling history doesn't blow the parent's 25k-event
limit on a large show.

`ListEpisodes` (Lambda) reads the show's `episodes[]` and emits `{episode_id, audio_url}`,
**skipping** episodes with no `audio_url` and those already **`SUCCEEDED` or in-flight**
(`COPYING/RUNNING`) unless `force=true` — so re-pressing "Run pipeline" mid-batch
never double-processes.

> **Concurrency note:** 30 concurrent episodes = up to 30 concurrent **GCP Transcoder jobs**
> (shared project quota with video). Verify the `asia-south1` concurrent-job quota ≥ 30 + video
> load, or lower `MaxConcurrency` in the SF JSON (it is hardcoded there, not env-driven).

### 3.1 Per-episode child (`gcp_audio_step_function_def.json`)
```
StartAt: CopyAudioToGCS
  CopyAudioToGCS -> SubmitAudioJob        # stream CloudFront → GCS
  SubmitAudioJob -> WaitForJob            # GCP Transcoder: lufs=-16 + AAC HLS
  WaitForJob     -> CheckJobStatus
  CheckJobStatus -> IsComplete (Choice)
      SUCCEEDED -> GenerateDone (Succeed)
      FAILED    -> JobFailed (Fail)
      else      -> WaitForJob
```
Three states + poll loop. No normalize state (Transcoder does loudness), no finalize, no sign.
`GenerateDone` = renditions are in the audio bucket; that's the current end of the line.

---

## 4. Lambdas (`orchestrator/`)

### 4.1 `gcp_copy_audio_to_gcs.py` (CopyAudioToGCS)
- Input `{ episode_id, audio_url }`. Stamps `audio_episodes` status `COPYING`.
- **Streams the CloudFront URL over HTTPS straight to GCS** — `requests.get(stream=True)` →
  `blob.upload_from_file(resp.raw, ...)` with `blob.chunk_size = 8 MiB` (resumable, non-seekable
  stream, no `/tmp`, no AWS creds). Writes `gs://chai-q-audio-transcoder/input/<id>/source.<ext>`.
- Clears stale `output/<id>/` first. On non-200 / error → stamps `FAILED` and raises (batch
  continues via `ToleratedFailurePercentage=100`).
- Returns `{ episode_id, gcs_input_uri, source_ext }`. **No ffmpeg/ffprobe** — ladder is static (§2).

### 4.2 `gcp_audio_transcoder.py` (SubmitAudioJob)
- Stamps `RUNNING`. Builds an **audio-only `JobConfig`** and submits to GCP Transcoder
  (`GCP_LOCATION=asia-south1`). Reads the raw `source.<ext>` directly.
- **Loudness normalization by the Transcoder** — on the input:
  ```python
  types.Input(
      key="input0", uri=gcs_input_uri,
      preprocessing_config=types.PreprocessingConfig(
          audio=types.PreprocessingConfig.Audio(lufs=-16),   # range -24..0
      ),
  )
  ```
  (`Input.preprocessing_config` + `PreprocessingConfig.Audio.lufs` verified in the Python client.)
- Per rung `kbps` in the ladder: distinct keys — elementary `es_audio_{k}k` (HE-AAC v1 at the
  64k rung, AAC-LC if the ladder is ever widened above 64k; `bitrate_bps=k*1000`,
  `channel_count=2`, `sample_rate_hertz=48000`) and fMP4 mux `audio_{k}k` (`segment_duration=6s`).
  One HLS manifest `audio_master.m3u8` listing the rung mux stream.
- Output `gs://chai-q-audio-transcoder/output/<id>/`. Writes `gcp_job_name`, `ladder`, `lufs`.

### 4.3 `gcp_check_audio_status.py` (CheckJobStatus)
- Polls `client.get_job`; on `SUCCEEDED` stamps `SUCCEEDED` + `output_uri`, on `FAILED` stamps
  the error. Returns state to the `IsComplete` Choice.

### 4.4 `list_audio_episodes.py` (parent ListEpisodes)
- Reads `podcast_showcache` by `slug`; emits items, applying the skip filters in §3.0.

Status lifecycle across the run: **`COPYING → RUNNING → SUCCEEDED | FAILED`** (copy + transcoder
+ check each stamp `audio_episodes`).

---

## 5. Audio overview page (no upload)

`dashboard/app/audio/page.js` + `app/api/audio/{episodes,run-show,convert}`:
- Lists podcasts from `podcast_showcache`; expand → episodes with read-only `audio_url` + status.
- **Per-show "Run pipeline"** (primary) → `POST /api/audio/run-show {slug}` → starts the parent
  batch SF (30-wide). Per-episode **"Convert"** (secondary) → `POST /api/audio/convert
  {episodeId}` → starts the child for one episode.
- Shows per-episode status, ladder, errors, and the generated **master playlist path**
  (`gs://chai-q-audio-transcoder/output/<id>/audio_master.m3u8`) with a Copy button — a `gs://`
  path, not a playable link (no signing yet). Show progress = "N of M done".
- No upload UI, no presign routes. The dashboard reaches the SFNs via `AUDIO_SFN_ARN` /
  `AUDIO_SHOW_BATCH_SFN_ARN` (App Runner env).

---

## 6. Output structure (in the audio bucket)
```
gs://chai-q-audio-transcoder/
  input/<episode_id>/source.<ext>            # the streamed source
  output/<episode_id>/
    audio_master.m3u8                        # variant playlist: 64 only
    audio_64k.m3u8  + .m4s segments + init   (mp4a.40.5, HE-AAC)
```
Single working bucket, `input/` + `output/` prefixes (Transcoder reads one, writes the other).
A bucket lifecycle rule can auto-delete both prefixes after N days (disposable). **Nothing is
copied to the CDN and nothing is signed yet** (§9).

---

## 7. Playback (once delivery/signing exist — §9)
- HLS single-rung 64k HE-AAC; no bandwidth adaptation (one rung), plays everywhere.
- No MP3 fallback. Quality ceiling: WAV → best 64k HE-AAC; MP3 → bounded by source bitrate.

---

## 8. Deploy / config

Infra: AWS Lambdas + 2 Step Functions via **Terraform** (`aws-infra/audio.tf`), reusing the
`gcp_deps` layer + `gcp_lambda_role` + `step_function_role`. GCP project `media-cdn-poc-466009`,
location **`asia-south1`**, bucket **`chai-q-audio-transcoder`**. `deploy.sh` enables the
Transcoder API, creates the bucket, builds layers, `terraform apply`, and pushes the dashboard
image (App Runner auto-redeploys). **Single `./deploy.sh`** — no separate worker to deploy.

Lambda env (`local.audio_lambda_env` in `audio.tf`):
```
MONGO_URI, GCP_PROJECT, GCP_LOCATION=asia-south1,
GCS_INPUT_BUCKET=GCS_OUTPUT_BUCKET=chai-q-audio-transcoder,
GCP_CREDENTIALS_SECRET_ARN,
AUDIO_SEGMENT_SECONDS=6, AUDIO_LADDER_KBPS=64, AUDIO_LOUDNESS_LUFS=-16
```

**Config to verify before/at deploy:**
- `.env.deploy` needs only `MONGO_URI` (existing repo requirement). No new audio vars.
- **GCP Transcoder concurrent-job quota ≥ 30** in `asia-south1` (or lower the SF `MaxConcurrency`).
- Transcoder access to `chai-q-audio-transcoder` — covered by the SA's project `storage.admin`;
  confirm the Transcoder service agent reaches it like the video buckets.
- IAM: `step_function_role` already grants `lambda:InvokeFunction` + `states:StartExecution` +
  `events:*Rule` on `*` (covers invoking the audio Lambdas and the nested-execution Map). App
  Runner role's StartExecution allowlist includes both audio SFNs.

---

## 9. Deferred (NOT built — by request)

Everything below is intentionally out of current scope; renditions stop in the audio bucket.

- **CDN delivery** — copy `output/<id>/` into the shared `chai-shots-manifests` CDN bucket
  (versioned `<id>/<ts>/`), as a `FinalizeAudioHLS` state forking `gcp_finalize_hls.py`'s
  generic copy/byterange/rename helpers (skip the video-only `_reorder_streams_in_manifest` /
  `_fix_audio_name`). Emit the master as `*_combined.m3u8` with absolute child URLs.
- **Signing** — a **separate, isolated** `resign_audio_playback_urls.py` (copy the manifest
  signing helpers; never touch the video `resign`), sweeping only `podcast_showcache`, writing
  `episodes[].signed_playback_url`. Shares the signing **keyset** (URL-prefix signing is
  per-episode-scoped; `KeyName` = keyset name). Single-episode mode after finalize + full-sweep
  cron for TTL rotation. Own `AUDIO_DRY_RUN` + `AUDIO_SIGNING_ENABLED` kill switches.
- **Quality checks** — optional output validation (bitrate/duration/playability). Loudness is
  handled by the Transcoder `lufs`, so no separate loudnorm verification is needed.
- **No-upsample ladder cap** — would need a GCP-native input probe; skipped (no ffmpeg).

---

## 10. Status / build order

Built & validated (generate-only, all-GCP):
1. ✅ `gcp_copy_audio_to_gcs.py` (HTTPS stream → GCS, status stamping).
2. ✅ `gcp_audio_transcoder.py` (Transcoder `lufs=-16` + single 64k HE-AAC HLS).
3. ✅ `gcp_check_audio_status.py`, `list_audio_episodes.py`.
4. ✅ `gcp_audio_step_function_def.json` (child) + `gcp_audio_show_batch_def.json` (parent Map 30).
5. ✅ `aws-infra/audio.tf` (5 Lambdas → 4 after worker removal + 2 SFNs; reuses gcp_deps layer).
6. ✅ Dashboard `/audio` page + 3 API routes; App Runner env + StartExecution IAM.

To deploy: ensure Transcoder quota, set `MONGO_URI`, run `./deploy.sh`, open `/audio`, Run pipeline.

Open question — **Q-A5:** mono podcasts could emit mono (≈half the bytes/rung) vs. forced
stereo. Default stereo; revisit if voice-only content dominates (GCP `AudioStream.channel_count`).
