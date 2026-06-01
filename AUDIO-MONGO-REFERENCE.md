# Audio Pipeline — Where URLs Live in Mongo (Reference)

> **Purpose:** a single, verified source of truth for *where audio URLs are stored* and how
> they differ from the video pipeline. Written to stop recurring confusion. Every field below
> was confirmed by querying the live DB (not assumed).

---

## TL;DR

- **Audio playback URL is stored in `chai_q_lab.audio_episodes.public_master_url`.**
- It is an **unsigned, public** URL: `https://storage.googleapis.com/chai-q-audio-public/<episode_id>/audio_master.m3u8`.
- The audio playback URL is **NOT written to `master.podcast_showcache`** (showcache only holds the
  *source* `audio_url`). This is **different from video**, which writes a signed URL to `master.showcache`.

---

## 1. `chai_q_lab.audio_episodes`  ← the audio tracking + results collection

Keyed by **`episode_id`** (the podcast episode UUID). One doc per episode. Written by the audio
Lambdas (`gcp_audio_transcoder.py`, `gcp_check_audio_status.py`) and the ViSQOL worker.

| Field | Meaning |
|---|---|
| `episode_id` | episode UUID (the key) |
| `audio_url` | the **source** audio (copied from podcast_showcache; normalized to `https://`) |
| `gcp_job_status` | `COPYING` → `RUNNING` → `SUCCEEDED` \| `FAILED` |
| `gcp_job_name`, `gcp_started_at`, `gcp_finished_at` | GCP Transcoder job + timestamps |
| `ladder` | rungs produced, e.g. `[64]` |
| `lufs`, `language_code` | loudness target (−16), BCP-47 lang (e.g. `te`) |
| `output_uri` | **private** working bucket: `gs://chai-q-audio-transcoder/output/<id>/` |
| **`public_master_url`** | **THE PLAYBACK URL** → `https://storage.googleapis.com/chai-q-audio-public/<id>/audio_master.m3u8` (public, unsigned) |
| `visqol` | ViSQOL "Calculate" result summary: `{status, scores:{"64":x.xxx}, source_codec, computed_at, ...}` |
| `subtitle_tracks` | advertised subtitle tracks (best-effort) |
| `publish_error` / `subtitle_publish_error` | set only if the best-effort public copy / subtitle publish failed |

**The dashboard `/audio` page + the ViSQOL Calculate button read `public_master_url` from here.**

---

## 2. `chai_q_lab.audio_visqol_research`  ← per-rung ViSQOL history

One doc **per rung per Calculate run** (history for aggregation). Written by the ViSQOL worker.

`{ episode_id, rung_kbps, codec, visqol_mos, mode, segment, source_codec, source_sr, timestamp }`

- `codec` is **detected from the actual stream via ffprobe** (e.g. `aac-he`), not assumed.

---

## 3. `master.podcast_showcache.episodes[]`  ← the SOURCE side only

Episode object keys (verified): `id, title, episode_number, is_premium, is_active, emoji, audio_url, duration`.

- **`audio_url`** = the **source** master (`.wav`/`.mp3`, sometimes stored *without* a scheme,
  e.g. `d27vk6lpclibck.cloudfront.net/...`). This is the input the pipeline transcodes.
- **There is NO audio playback / signed URL field here.** Do not look for the rendition URL in
  showcache — it lives in `chai_q_lab.audio_episodes.public_master_url` (see §1).

---

## 4. The three buckets (so they're never conflated)

| Bucket | Role | Public? |
|---|---|---|
| `chai-q-audio-transcoder` | working bucket: `input/source.*` + `output/<id>/` renditions | private/internal |
| `chai-q-audio-public` | **preview/playback** bucket (what `public_master_url` points to) | **public, unsigned** |
| `chai-shots-manifests` | the **video** Media CDN origin (`cdn.chaishots.in`) | private; **path-based** signing (see §6) |

Audio currently uses **`chai-q-audio-public`** only. It does **not** use `chai-shots-manifests`.

---

## 5. Contrast with VIDEO (the source of past confusion)

Video stores URLs in **different** places, and signing works differently:

| | Video | Audio |
|---|---|---|
| Per-codec master URLs | `chai_q_lab.video_episodes.h264_master_m3u8_url` / `h265_master_m3u8_url` (**unsigned, internal records — not playable directly**) | n/a (single rung, no per-codec split) |
| Viewer playback URL | `master.showcache.episodes[].signed_playback_url` = the `_combined.m3u8` | `chai_q_lab.audio_episodes.public_master_url` |
| Signed? | the combined URL is signed (URL-prefix signing; child/segment signatures are baked **inside the .m3u8 files on GCS**, not in Mongo) | **unsigned** (served from a public bucket) |
| Stored in showcache? | yes (`master.showcache`) | **no** (only the source `audio_url` is in `podcast_showcache`) |

> Note: in `master.showcache`, the field is named `signed_playback_url` but **may hold an unsigned
> URL** for older content (e.g. `cdn.chaishots.in/hls/...` paths) — the name does not guarantee a signature.

---

## 6. Media CDN signing is PATH-BASED (verified, not host-wide)

On `cdn.chaishots.in`:
- **`/hls/...`** (older video content) → **served UNSIGNED** (verified: HTTP 200 with no signature).
- **`/<id>/<ts>/..._combined.m3u8`** (newer versioned content) → **signature REQUIRED** (verified: HTTP 403 "Unsigned request rejected" without a signature).

So "on the CDN ⇒ must be signed" is **false** — enforcement depends on the path prefix. (A static
config backup at `aws-infra/cdn-backups/cdn-fullenforce-*.yaml` shows `prefixMatch: /` with
`REQUIRE_SIGNATURES`, but the **live** routing serves some prefixes unsigned. Always check the live
`EdgeCacheService`, not the backup.)

**Implication:** audio *could* be served unsigned from `cdn.chaishots.in` by placing it under an
unsigned path prefix — no audio signer required. (Not implemented today; audio uses `chai-q-audio-public`.)

---

_Last verified: 2026-06-01 against the live `prodcluster` Mongo (`master` + `chai_q_lab` DBs) and the live CDN._
