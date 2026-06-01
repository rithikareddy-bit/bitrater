# Audio CDN Delivery — Plan (private buckets, CDN-served, UNSIGNED)

> **Goal:** serve audio like video does — renditions in a **private** bucket, played in the browser
> via the `cdn.chaishots.in` CDN — but **without signing** (per decision). Then make the
> `chai-q-audio-*` buckets private.
>
> Status: **PLAN ONLY — nothing implemented.** Every fact below was verified against the live
> CDN / Mongo / buckets on 2026-06-01 (not assumed).

---

## 0. Confirmed facts (live, verified)

### CDN routing — `gcloud edge-cache services describe chai-shorts-media-cdn`
Host `cdn.chaishots.in` → `path-matcher-0`, rules evaluated by priority:

| Priority | Match rule | Signing | Verified |
|---|---|---|---|
| 1 | `pathTemplateMatch: /{ep}/{file}` (**exactly 2 path segments**) | **DISABLED** | — |
| 2 | `prefixMatch: /hls/` | **DISABLED** | `/hls/…m3u8` → HTTP **200** unsigned ✅ |
| 3 | `prefixMatch: /` (catch-all) | **REQUIRE_SIGNATURES** (keyset `chaishots-playback-keyset`) | `/<id>/<ts>/…_h264.m3u8` → **403** "Unsigned request rejected" ✅ |

Origin for all rules = `edgeCacheOrigins/chai-shots-manifests`.

**Implication:** to serve audio **unsigned**, its URLs must match rule **1** (2-segment `/<x>/<file>`)
or rule **2** (`/hls/...`). A 3-segment path that isn't under `/hls/` falls to rule 3 → signature required.

**Deep-path verified:** `/hls/audio/<x>/<y>/audio_master.m3u8` → HTTP **404** (unsigned route, file
not found) — *not* 403. Confirms rule 2's prefix covers arbitrary depth, so `/hls/audio/<id>/<ts>/...`
is unsigned. (Control: a 3-segment root path `/<x>/<ts>/x.m3u8` → **403**, signed.)

### Current audio data model (verified)
- Renditions: `gs://chai-q-audio-transcoder/output/<id>/` (private working bucket) → copied to
  `gs://chai-q-audio-public/<id>/` (public) by `gcp_check_audio_status._publish_to_public_bucket`.
- **Subtitles live ONLY in `chai-q-audio-public`:** after the output→public copy, `publish_subtitles`
  uploads `subtitle_*.vtt` + `subtitle_*.m3u8` to `chai-q-audio-public/<id>/` **and patches the master
  there** (`audio_subtitle_publish.py` → `AUDIO_PUBLIC_BUCKET`). `output/<id>/` has the *un-patched*
  master and **no** subtitle files. → **The CDN copy must source from the public bucket, not `output/`.**
- Playback URL stored at **`chai_q_lab.audio_episodes.public_master_url`** =
  `https://storage.googleapis.com/chai-q-audio-public/<id>/audio_master.m3u8` (direct GCS, unsigned).
- `master.podcast_showcache.episodes[].audio_url` = the **source** only (no playback URL there).
- Audio master uses **RELATIVE** child URIs (`URI="audio_64k.m3u8"`, segment `audio_64k…m4s`) — so a
  plain folder copy works in any location **without URL rewriting** (unlike video's absolute-URL master).

### Who depends on `chai-q-audio-public` today (would break if it goes private with no replacement)
- **ViSQOL Calculate worker** — fetches `MASTER_URL` (= `public_master_url`) + segments over **plain
  HTTPS, no signing**.
- **Dashboard "Open" link** — opens `public_master_url` in the browser.
- No end-user playback depends on it yet (audio is generate-only today).

---

## 1. Chosen approach — **Option B (versioned, unsigned, `/hls/audio/` prefix)** ✅ LOCKED

**Copy `output/<id>/*` → `chai-shots-manifests/hls/audio/<id>/<ts>/*`, and serve via the CDN.**

- Path `/hls/audio/<id>/<ts>/audio_master.m3u8` is under the **`/hls/` prefix → rule 2 → DISABLED (unsigned)**. **No CDN config change.**
- **Versioned** (`<ts>` = per-run timestamp folder), exactly like video → each re-transcode writes a
  fresh path, so **no stale CDN cache** and old versions stay reachable.
- Playback URL becomes `https://cdn.chaishots.in/hls/audio/<id>/<ts>/audio_master.m3u8`.
- Relative child URIs resolve inside the same `<ts>` folder (all under `/hls/`) → all unsigned. **No rewriting, no signing.**
- **The URL changes on every transcode** (timestamp in path). Consumers always read the current one
  from `chai_q_lab.audio_episodes.public_master_url`, updated each run — same model as video's `signed_playback_url`.

### Why B over A / C (decision locked)
| Option | Path | Unsigned via | Versioned? | CDN change? | Verdict |
|---|---|---|---|---|---|
| A | `/<id>/audio_master.m3u8` | rule 1 (`/{ep}/{file}`) | ❌ flat | none | stable URL, but **stale-cache risk on re-transcode** (`excludeQueryString:true` blocks cache-busting) |
| **B ✅ CHOSEN** | `/hls/audio/<id>/<ts>/...` | rule 2 (`/hls/`) | ✅ yes | **none** | unsigned + versioned (no stale cache) + no CDN change — behaves like video |
| C | `/audio/<id>/<ts>/...` | needs new rule | ✅ yes | **yes (risk)** | cleanest URL, but a CDN routing change we chose to avoid |

> ⚠️ Do **not** use a 3-segment non-`/hls/` path (e.g. `<id>/<ts>/...` at the root) — it hits rule 3 and 403s without a signature. The `/hls/` prefix is what keeps B unsigned.

---

## 2. Implementation steps (in order — DO NOT make buckets private first)

1. **Add a CDN-copy step in `gcp_check_audio_status.py`**, running **AFTER `publish_subtitles`**:
   - Build a per-run timestamp `ts` (e.g. `%d%m%Y_%H%M%S`, same format as `gcp_finalize_hls`).
   - ⚠️ **Source from `chai-q-audio-public/<id>/*`, NOT `output/<id>/*`.** The subtitle `.vtt` + subtitle
     playlists, **and the subtitle-patched master**, only exist in the public bucket — `publish_subtitles`
     writes/patches them there (`audio_subtitle_publish.py` targets `AUDIO_PUBLIC_BUCKET`, patches
     `<id>/audio_master.m3u8` there). Copying from `output/` would ship audio with **no subtitles**.
   - `copy_blob` each `chai-q-audio-public/<id>/*` → `chai-shots-manifests/hls/audio/<id>/<ts>/*` (server-side).
   - Set cache headers like video: `.m3u8` → `Cache-Control: no-store`; segments → `public, max-age=31536000`.
   - Verify byte size after copy (partial-copy guard), same as `gcp_finalize_hls._copy_to_cdn_bucket`.
   - **Best-effort & gated:** run only if the public copy succeeded (i.e. `public_master_url` was set). A
     subtitle failure is OK — copy whatever is in the public folder (audio without subs still ships).
2. **Repoint the playback URL**: write `public_master_url = https://cdn.chaishots.in/hls/audio/<id>/<ts>/audio_master.m3u8`
   (the env already has `CDN_BASE`). Keep the field name for now to avoid touching the dashboard/route.
3. **Keep the `chai-q-audio-public` copy during transition** so ViSQOL/dashboard keep working until step 5.
4. **Verify end-to-end**: master + segments load from `cdn.chaishots.in/<id>/...` (HTTP 200, unsigned);
   run one **Calculate** against the CDN URL to confirm the worker fetches it fine over plain HTTPS.
5. **Then flip buckets private**:
   - ⚠️ **Migrate existing episodes FIRST.** The 9 already-published episodes have
     `public_master_url` = a **direct GCS** `storage.googleapis.com/chai-q-audio-public/...` URL.
     The moment that bucket goes private, those URLs **403** (preview + ViSQOL break for them) until
     they're re-published to the CDN. So before flipping: **re-run the publish/CDN-copy for all
     existing episodes** (re-transcode, or a one-off backfill that copies their public folder → CDN
     `<ts>` and repoints `public_master_url`). Don't flip private until every live episode points at a CDN URL.
   - `chai-q-audio-public` → **make private but KEEP it.** It stays the **subtitled staging bucket**
     that the CDN-copy reads from (server-side `copy_blob` works fine on a private bucket using the
     GCP creds). Do **not** stop publishing to it — the CDN copy sources from it. (Browser/ViSQOL no
     longer hit it directly; they use the CDN URL.)
   - `chai-q-audio-transcoder` → confirm private (working bucket).
   - Confirm `chai-shots-manifests` is readable by the Media CDN service agent (already is, for video).

---

## 3. Explicit decisions
- **No signing for audio** (per operator). Audio served via the unsigned CDN route only.
- **No URL rewriting** needed (audio manifests use relative URIs).
- **Ordering is mandatory**: CDN delivery + URL repoint **before** making buckets private — otherwise
  ViSQOL Calculate + dashboard preview break (they read the public GCS bucket directly).

## 4. Risks / rollback
- If ViSQOL must keep working: it reads whatever `public_master_url` holds — pointing it at the
  unsigned CDN URL is fine (the worker uses plain HTTPS; rule 1/2 paths need no signature).
- Rollback = repoint `public_master_url` back to `storage.googleapis.com/chai-q-audio-public/...` and
  re-open that bucket. The CDN copy is additive (versioned-free flat copy; re-running overwrites).
- Option C only: a CDN route change must be surgical (new rule above the catch-all) so it can't
  affect video signing — validate `/<id>/<ts>/..._combined.m3u8` still requires a signature after.

---

_Verified 2026-06-01 against live `chai-shorts-media-cdn` EdgeCacheService, `prodcluster` Mongo, and the live buckets. See also `AUDIO-MONGO-REFERENCE.md`._
