# Resync Subtitles — On-Demand Subtitle Injection

A button-driven flow for adding subtitles to an episode's combined HLS
manifest **without re-running the GCP Transcoder**. Replaces the previous
ad-hoc `backfill_subtitles.py` script.

## Why this exists

`gcp_finalize_hls` injects subtitles when it runs, but only if VTT files
already exist in the subtitle Mongo at that moment. When translations land
later, episodes get stuck without subs — and re-running the full GCP
pipeline just to attach subs is wasteful (segments + per-codec masters are
already correct).

This flow lets a dashboard user trigger subtitle injection per-episode or
show-wide, touches only `.m3u8` and `.vtt` files in GCS, and produces a
fresh signed URL in `master.showcache` automatically.

## What was added / changed

### New
- **`orchestrator/resync_subtitles.py`** — single-episode Lambda handler.
- **`dashboard/app/api/resync-subtitles/route.js`** — Next.js route exposing
  POST (per-episode sync, per-show async fan-out) and GET (eligibility
  checks for button enable state).
- **Per-episode "Resync Subtitles" button** — added to `GCPStatus.js`,
  enabled iff `combined_master_m3u8_url` exists AND
  `subtitles_injected ∈ {0, null}`.
- **Show-wide "Resync Subtitles (N pending)" button** — added to
  `app/show/page.js`, enabled iff at least one episode in the show is
  eligible.

### Modified
- **`orchestrator/gcp_create_combined_master.py`** — also writes
  `subtitles_injected: 0` when generating a fresh combined master, so the
  button auto-re-enables after combined regen.
- **`aws-infra/lambda.tf`** — declares `chai-q-resync-subtitles` Lambda;
  bundles `resync_subtitles.py` + `gcp_finalize_hls.py` (helpers) +
  `media_cdn_signer.py` (pre-signing).
- **`aws-infra/iam_roles.tf`** — grants the GCP-Lambda role permission to
  invoke the resign Lambda. (Signing-key Secrets-Manager access was already
  on the role.)
- **`aws-infra/apprunner.tf`** — exposes `RESYNC_SUBTITLES_LAMBDA_ARN` env
  to App Runner; adds the new ARN to the dashboard role's invoke list.

### Removed
- **`orchestrator/backfill_subtitles.py`** — superseded by the Lambda + UI.

## End-to-end flow (per episode)

```
[Dashboard click]
       │
       ▼
[POST /api/resync-subtitles {episodeId}]
       │   (sync invoke, AppRunner edge waits ~30–60s)
       ▼
[Lambda: chai-q-resync-subtitles]
   │
   ├─ 1. Read combined_master_m3u8_url from chai_q_lab.video_episodes
   │     (exit if absent → status: skipped no-combined-master)
   │
   ├─ 2. Pull VTT URLs from gld2sqs.subtitles by episode_id
   │     (exit if no record / no langs → status: skipped no-vtts-available)
   │
   ├─ 3. Fetch video_duration from master.showcache.episodes
   │     (used to inject end-of-stream gap separator into VTT)
   │
   ├─ 4. Download each VTT, inject hash-separator gap cues, upload
   │       gs://chai-shots-manifests/{prefix}/subtitle_<lang>.vtt
   │       gs://chai-shots-manifests/{prefix}/subtitle_<lang>.m3u8
   │     (per-language failures logged, others continue)
   │
   ├─ 5. Pre-sign each subtitle_<lang>.m3u8's bare .vtt URI in place
   │     (closes the race window before resign runs)
   │
   ├─ 6. Patch combined master in place with ABSOLUTE pre-signed
   │       URI="{CDN_BASE}/{prefix}/subtitle_<lang>.m3u8?Sig..."
   │     entries; dedupe by LANGUAGE (idempotent on re-run);
   │     append SUBTITLES="subtitles" only to STREAM-INF lines that lack it
   │
   ├─ 7. Invoke chai-q-resign-playback-urls synchronously with
   │       {episode_id, canonical_url}
   │     → re-signs master + every absolute child .m3u8 (incl. our subs)
   │     → signs the bare .vtt URI inside subtitle_<lang>.m3u8
   │     → writes fresh signed_playback_url + expiry into master.showcache
   │
   ├─ 8. POST Media CDN edgeCacheServices :invalidateCache
   │       pathMatcher: /{prefix}/*
   │     (logs failure, doesn't abort — no-store headers cover us)
   │
   └─ 9. Stamp chai_q_lab.video_episodes:
           subtitles_injected: <n_tracks>
           subtitles_resynced_at: <iso utc>
```

Show-wide POST `{showId}` does the same per episode but uses Lambda
**Event** invocation (fire-and-forget) so a 100-episode show doesn't time
out at the App Runner edge. UI polls GET `?showId=` every 15s for the
eligible-count to drop, stopping early when it hits 0.

## Why playback is never affected

The HLS contract: a player loads a master `.m3u8`, parses it once, then
fetches segment files (`.m4s` / `.ts`) referenced inside per-codec child
playlists. Subtitle tracks are entirely separate sidecar resources.

| Step | Touches | Impact on in-flight player |
|---|---|---|
| Upload `subtitle_<lang>.vtt` / `.m3u8` | New files at new GCS paths | None — net-new content nothing references yet. |
| Pre-sign subtitle children | Rewrite the `.m3u8` we just wrote | None — same file, still no other reference. |
| Patch combined master | Add `EXT-X-MEDIA:SUBTITLES` lines + `SUBTITLES="subtitles"` attribute on `STREAM-INF` | Master is `Cache-Control: no-store`, so future fetches see new content. **Existing player sessions already parsed the old master in memory and don't re-fetch for VOD.** Their video/audio segment URLs in per-codec child playlists are unchanged. |
| Resign master + children | Rotate signing qs on every `.m3u8` URI | Existing sessions keep using the old qs which is still valid for the old TTL. New sessions hit the new signed URL from showcache. (Same behavior as the existing scheduled resign sweep — not new risk.) |
| Media CDN invalidation | Evict `.m3u8` only | Segment `.m4s` files untouched, so video bytes are never re-fetched. |
| Mongo write `subtitles_injected` | Field on `video_episodes` | Read-side field for the dashboard button only; not consulted by playback. |

### Failure-mode safety

| Failure point | Effect on playback | Recovery |
|---|---|---|
| Step 4 (upload) fails | Master not patched; players see no subs | `subtitles_injected` not set → button still enabled → re-click |
| Step 6 (patch) fails | Same as above | Re-click; idempotent dedupe avoids double entries |
| Step 7 (resign) fails | Master has subs but new children unsigned; **player ignores broken sub track and keeps playing video/audio normally** (HLS players degrade subs gracefully) | `subtitles_injected` not set → re-click |
| Step 8 (invalidate) fails | `no-store` header still prevents stale serving | Logged; flow continues |
| Step 9 (Mongo write) fails | Everything else succeeded | Button stays enabled; safe re-click is a no-op patch |

The unsigned-children failure is the closest to a user-visible glitch, and
even it can't break video — only subtitles disappear until next click.

### Race window between patch and resign

Without pre-signing, the patched master would briefly reference
unsigned subtitle URIs (~5–15s while resign downloads, signs, and uploads
back). To eliminate this:

1. We pre-sign each subtitle URI before adding it to the master, using the
   same Ed25519 prefix-sig algorithm (`media_cdn_signer.sign_url_prefix`)
   and the same TTL the resign Lambda uses.
2. We pre-sign the bare `.vtt` URI inside each `subtitle_<lang>.m3u8` for
   the same reason.
3. The subsequent resign sweep does `strip_existing_signing_params` →
   re-append, which is idempotent — both signatures are valid; resign's
   wins because it's last.

Result: from the instant the patched master is uploaded, every URI players
might fetch is already signed.

## Eligibility logic

A button is **enabled** when:

- **Per-episode (`GCPStatus.js`)**: `combined_master_m3u8_url` is set AND
  `subtitles_injected` is `0` or null.
- **Show-wide (`show/page.js`)**: at least one episode in
  `master.showcache.episodes` matches the per-episode criteria.

When the button completes (or `gcp_create_combined_master` re-runs), Mongo
state changes drive the eligibility refresh — there's no in-memory state
that can drift out of sync.

## Required environment variables

`chai-q-resync-subtitles` Lambda (set via Terraform from
`local.gcp_lambda_env`):

| Var | Source |
|---|---|
| `MONGO_URI` | `var.mongo_uri` |
| `SUBTITLE_MONGO_URI` | `var.subtitle_mongo_uri` |
| `GCP_CREDENTIALS_SECRET_ARN` | `local.gcp_credentials_secret_arn_effective` |
| `CDN_BASE` | `var.cdn_base` |
| `RESIGN_PLAYBACK_URLS_LAMBDA_ARN` | `aws_lambda_function.resign_playback_urls.arn` |
| `SIGNING_KEY_SECRET_ID` | `var.media_cdn_signing_key_secret_id` |
| `SIGNED_URL_TTL_SECONDS` | `var.signed_url_ttl_seconds` |
| `SIGNING_ENABLED` | `var.signing_enabled` |

Optional overrides: `MEDIA_CDN_PROJECT`, `MEDIA_CDN_SERVICE`,
`MEDIA_CDN_LOCATION`, `SKIP_CDN_INVALIDATION=1`.

## GCP IAM (out-of-band)

The GCP service account stored in `chai-q-gcp-credentials` needs
`networkservices.edgeCacheServices.update` (e.g.
`roles/networkservices.edgeCacheAdmin`) on project
`media-cdn-poc-466009` for cache invalidation. Without it the resync
still completes — the invalidation step logs `[CDN] invalidation FAILED`
but `Cache-Control: no-store` on every uploaded `.m3u8` prevents stale
serving in practice.

## Known limitations

- **Trailers**: per-episode button works (Lambda handles `trailer_<id>_<key>`
  IDs). Show-wide button iterates only `showcache.episodes`, not
  `trailers_playback_urls`.
- **No "force refresh" path**: once `subtitles_injected > 0`, the button is
  disabled until `combined_master_m3u8_url` regenerates. To refresh existing
  subs you must re-create the combined master (which now auto-clears the
  flag).
- **Show-wide failure visibility**: failed Lambdas log to CloudWatch but
  aren't surfaced per-episode in the UI; the eligibility count just stays
  > 0 and the user re-clicks. (Auto-pipeline-style status tracking would be
  the upgrade path.)
