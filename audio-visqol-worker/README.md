# audio-visqol-worker

On-demand **Check Quality** worker — scores the already-encoded 64k HE-AAC rendition of one
episode against its source with **ViSQOL** (audio mode, 48 kHz). Measurement-only; no re-encode.
See `../AUDIO-QUALITY-CHECK-PLAN.md` for the full design.

## Files
- `worker.py` — fetch master → parse `TYPE=AUDIO` URIs → decode source + renditions to mono/48 kHz
  (mid-window) → ViSQOL per rung → write `chai_q_lab.audio_episodes.visqol` + `audio_visqol_research`.
- `Dockerfile` — multi-stage: builds ViSQOL (Bazel) then a slim runtime with static ffmpeg.
- `requirements.txt` — `pymongo`, `requests`.

## Inputs (env, supplied via Batch `containerOverrides`)
| var | meaning |
|-----|---------|
| `EPISODE_ID` | episode UUID (Mongo key) |
| `MASTER_URL` | public `audio_master.m3u8` (`public_master_url`) |
| `SOURCE_URL` | source `audio_url` (`.wav` or `.mp3`, auto-detected) |
| `MONGO_URI` | results sink |
| `VISQOL_SEGMENT` | `mid-180s` (default) or `full` |
| `VISQOL_BIN` / `VISQOL_MODEL` | set by the image; override for local runs |

## Build
```bash
# from repo root (Dockerfile COPYs paths relative to repo root)
docker build -f audio-visqol-worker/Dockerfile -t audio-visqol-worker .
```

## Standalone test (no Mongo, no infra) — validate scores on a real episode
```bash
docker run --rm audio-visqol-worker \
  --no-db \
  --episode-id <id> \
  --master-url "https://storage.googleapis.com/chai-q-audio-public/<id>/audio_master.m3u8" \
  --source-url "<the episode's audio_url>"
```
Expect the 64k rung to land ~4.5–4.7 MOS for clean (WAV-sourced) speech. MP3-sourced episodes
print a lossy-reference warning — treat absolute MOS as relative only.
