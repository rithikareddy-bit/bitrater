# Playback URL Cleanup — End to End (Params Strip → 30-Day Cache)

> One document covering both cleanup jobs that ran over `gs://chai-shots-manifests`
> (served as `cdn.chaishots.in`): **(1)** stripping leftover signing params baked into
> manifest text, and **(2)** normalizing `Cache-Control` to 30 days. Written 2026-07-07.

---

## TL;DR — current state

| Layer | Signing params in manifests | Cache-Control |
|---|---|---|
| **Origin (GCS)** | ✅ stripped — all 3017 combined masters clean | ✅ 30 days on all active-show playback files |
| **Edge (CDN)** | ✅ serving clean (no params) | ⚠️ manifests 30d; some `.m4s` segments still serve **1-year from pre-patch cache** |

- **Params strip:** DONE (2026-07-06) — 2491 cleaned, 526 already-clean, 0 failed.
- **Cache-control fix:** DONE (2026-07-06) — 22,146 files fixed (604 empty + 11,667 no-store + 9,875 1-year → 30d), 75,125 already-30d, 0 errors, across 2,960 active-show episode folders.
- **Open item:** CDN edge still serves `max-age=31536000` on formerly-1-year segments that were cached *before* the patch. Self-heals over up to ~1 year, or instantly via CDN invalidation. **Playback is unaffected** (segment content is immutable) — this is purely a cache-duration mismatch. Decision pending.

---

## Background — two independent problems

### Problem 1: signing params baked into manifest *text*
Playback URLs used to be signed (`?URLPrefix=…&Expires=…&KeyName=…&Signature=…`).
Signing was turned **off** at the edge on 2026-06-10 (`signedRequestMode: DISABLED`
on all routes; cache key has `excludeQueryString: true`). The resign Lambda only
rewrote Mongo's `signed_playback_url`; it never touched the **contents** of the
`.m3u8` files in GCS, where child/segment URLs still had the params baked in as text.
Harmless (edge ignores query strings) but cosmetic clutter — and confusing.

### Problem 2: Cache-Control regression + legacy inconsistency
Two things left playback files not at the intended 30-day cache:
1. **`no-store` regression** — the *first* version of the strip tool called
   `blob.download_as_text()`, which **overwrites `blob.cache_control` in memory**
   with the download-response header (`no-cache, no-store, max-age=0, …`). When it
   re-uploaded the stripped manifest it wrote that back, flipping ~2,491 cleaned
   manifests from 30-day → `no-store`. (Root-caused + fixed; see below.)
2. **Legacy `1-year` segments** — older `.m4s` segments were packaged with
   `max-age=31536000` (1 year), never 30 days.
3. **Empty** — 604 segments had no `Cache-Control` at all.

---

## Infra facts you need

- **Bucket:** `gs://chai-shots-manifests` → served as `https://cdn.chaishots.in/`.
- **Edge:** Google Media CDN, `signedRequestMode: DISABLED` on all routes since
  2026-06-10 → query-string signatures are ignored; expired sigs still return 200/206.
- **Prod SA:** `chai-q-transcoder@media-cdn-poc-466009.iam.gserviceaccount.com`
  — has bucket write + CDN invalidate + edge describe.
  - Loaded **in-memory** from AWS Secrets Manager via `--from-secret <ARN>`.
  - **ARN:** `arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd`
  - ⚠️ **NEVER write the prod SA key to disk.** Always use `--from-secret`.
  - The local `testing-gcp` SA can write the bucket but **cannot** invalidate the CDN — don't use it for these jobs.
- **Source of truth for episodes:** `master.showcache` in Mongo.
  - `active: true` (176 shows) vs `false` (39). Scoping uses **`episodes[].signed_playback_url`** (combined `_combined.m3u8` only) — not trailers.
  - ⚠️ Caveat: `showcache` has **duplicate show docs** with the same title but
    different slugs and conflicting `active` values. Scoping trusts this flag; since
    both jobs only ever *set* safe values, a wrong flag can't break anything.
- **HLS shape (modern combined episodes):**
  - `…_combined.m3u8` (master) → **absolute** child URLs → each rendition is a
    child `.m3u8` → segments are **fMP4 single-file byterange** `.m4s`
    (one `.m4s` per rendition, all segments as byte-ranges inside).
  - **8 renditions** = 3 video h265 + 3 video h264 + 2 audio → **8 `.m4s`** per episode.
  - Subtitles = `subtitle_*.vtt`. Sprite/thumbnail VTTs live **elsewhere** (not in these episode folders).
  - Legacy `/hls/` shows use classic `.ts` (one file per ~2s segment).

---

## Phase 1 — Strip signing params from manifests

**Goal:** remove `?URLPrefix…&Signature…` from the *text* of every `.m3u8`.

**Tools**
- `strip_manifest_params.py` — the actor. Walks master → children → subs, strips
  params, re-uploads, invalidates CDN. Dry-run by default; `--apply`.
  - Flags: `--apply`, `--backup` (writes `<path>.bak`), `--force`, `--from-secret`,
    `--invalidation-delay`, `--no-invalidate`.
  - **Self-guard:** reads live edge signing state via the SA API; **refuses `--apply`
    unless every route is `DISABLED`.** `--force` overrides only an *unknown* read,
    never a confirmed-enforcing edge.
- `batch_strip_manifests.py` — batch wrapper. Enumerates showcache combined masters,
  processes in paced chunks, per-prefix CDN invalidation. JSONL resume state + file log.
  Exit codes: `0` done, `2` edge enforcing (hard stop), `5` transient/unknown (auto-resume).
- `run_batch_cleanup.sh` — resilient loop around the batch (handles rc=5 resume,
  aborts after `MAX_STUCK=3` no-progress passes).
- `aws-infra/verify-cdn-signing.sh` — optional bash gate (needs `gcloud auth`); fail-closed.
- `RUNBOOK-strip-manifest-params.md`, `VM-SETUP-batch-cleanup.md` — process docs.

**How it was run**
```bash
cd orchestrator
set -a; . ../.env.deploy; set +a
ARN="arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd"
# pilot one episode
python3 strip_manifest_params.py <master_url> --apply --backup --from-secret "$ARN"
# full catalog (paced, resumable, self-invalidating)
./run_batch_cleanup.sh          # wraps batch_strip_manifests.py --from-secret "$ARN"
```

**Result (2026-07-06 18:30 UTC):** all **3017** combined masters — **2491 cleaned**
(had params → rewritten + invalidated), **526 already-clean**, **0 failed**.
Spot-checked cleaned URLs serve 200 with `Signature=` gone.

**Pending:** `.bak` backups still in the bucket. Manual cleanup after final sign-off:
```bash
gsutil -m rm gs://chai-shots-manifests/**/*.bak
```

---

## Phase 2 — Normalize Cache-Control to 30 days

**The bug that made this necessary.** `blob.download_as_text()` (used in v1 of the
strip tool to read the manifest) **silently overwrites `blob.cache_control`** with the
download-response header. Re-uploading then persisted `no-store`. **Fix:** capture the
original `cache_control` *before* download and restore it on upload:
```python
blob = bucket.get_blob(path)          # get_blob populates generation + cache_control
orig_cache_control = blob.cache_control
text = blob.download_as_text()        # (this clobbers blob.cache_control in memory)
...
blob.cache_control = orig_cache_control or M3U8_CACHE_CONTROL
blob.upload_from_string(stripped, content_type=ctype, if_generation_match=gen)
```

**Tool:** `patch_gcs_cache_control.py` — sets `Cache-Control: public, max-age=2592000`
(30 days) on playback blobs that aren't already at that value. Metadata-only
(`blob.patch()`); `.bak` skipped; idempotent (never re-touches an already-30d file).

Key flags:
- `--active-only` — scope to episodes of **active** shows (from `signed_playback_url`);
  lists just those UUID folders (needs `MONGO_URI`). Far faster than a whole-bucket scan.
- `--only-broken` — fix **only** `no-store` + `1-year`; leave everything else (used for
  the initial regression fix). **Omit** it to force *any* non-30d value → 30d
  (including the 604 empty segments) — this is what the final run did.
- `--exts` — default covers **all** playback types: `.m3u8 .m4s .vtt .ts .mp4`.
- `--from-secret <ARN>`, `--prefix <uuid>/`, `--dry-run`, `--workers`.

**How the final run was done**
```bash
cd orchestrator
set -a; . ../.env.deploy; set +a
ARN="arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd"
# force everything non-30d → 30d, active shows only:
python3 patch_gcs_cache_control.py --active-only --from-secret "$ARN"
```

**Result (2026-07-06):** across **2,960** active episode folders, **97,271** files
(`.m3u8` 53,899 · `.m4s` 28,000 · `.vtt` 15,192 · `.ts` 180):
- **Patched 22,146** → `{empty: 604, no-store: 11,667, 1-year: 9,875}`
- **Already 30 days (skipped): 75,125** (incl. all 15,192 subtitle `.vtt`)
- **Left untouched: 0 · Errors: 0**

**Verify:** the check pattern is one `list_blobs(prefix=<episode_dir>)` per episode —
GCS's list API returns full blob metadata (incl. `cache_control`) for every object under
the prefix in one call, so no per-file download is needed — parallelized across episodes
with a thread pool. Independent re-scans confirmed 100% 30d at origin for combined
episodes. (Verification was run ad-hoc; no verifier script is committed here.)

---

## Phase 3 — CDN edge (the remaining gap)

Origin is 30-day everywhere, but the **edge** can still serve the *old* header for
objects it cached **before** the patch — because it won't re-fetch origin until the
cached entry's TTL expires.

**Proof (one segment):**
```
ORIGIN (GCS)  : public, max-age=2592000   (30d)   updated 2026-07-06 (patch)
EDGE   (CDN)  : public, max-age=31536000  (1yr)   cached 2026-07-05, Age ~116,516s
```

**Which files are affected:**
- **`no-store` manifests** → were **never cached** at the edge, so the edge already
  refetched and serves **30-day**. ✅ No invalidation needed.
- **`1-year` segments (~9,875)** → **were** cached at the edge with a 1-year TTL, so the
  edge keeps serving `max-age=31536000` until that TTL expires (up to ~1 year) or the
  entry is evicted under cache pressure. ⚠️ Invalidation needed to fix *now*.

**Does it matter?** Functionally **no** — `.m4s` segment content is immutable, segments
serve `206 OK`, video plays identically. It's only the cache-*duration* label that
lingers. If exact 30-day policy at the edge is required, run a CDN invalidation over the
active prefixes (same mechanism the strip job used). Otherwise it self-heals slowly.

---

## File inventory (all standalone manual tools — NOT part of deploy)

None of these are packaged into any Lambda (`archive_file` lists sources explicitly)
or Docker image (`.dockerignore` excludes `orchestrator/`; Dockerfiles copy only their
own service). They run by hand with `--from-secret`.

| File | Role |
|---|---|
| `strip_manifest_params.py` | Strip signing params from one manifest tree (actor) |
| `batch_strip_manifests.py` | Batch the strip across all showcache masters (resumable) |
| `run_batch_cleanup.sh` | Resilient loop wrapper for the batch |
| `patch_gcs_cache_control.py` | Set 30-day Cache-Control on playback blobs |
| `aws-infra/verify-cdn-signing.sh` | Bash gate: confirm edge signing is DISABLED |
| `RUNBOOK-strip-manifest-params.md` | Strip-job runbook |
| `VM-SETUP-batch-cleanup.md` | Running the batch detached / on a VM |
| `PLAYBACK-URL-CLEANUP.md` | **This document** |

Runtime artifacts (`batch_strip_manifests.log`, `batch_strip_state.jsonl`,
`wrapper.out`) are **gitignored** — logs/state, not source.

---

## Open items / next steps

1. **CDN invalidation** on active prefixes — to make the edge serve 30-day on the
   formerly-1-year segments immediately (else self-heals over ≤1 year). *Decision pending.*
2. **`.bak` cleanup** — `gsutil -m rm gs://chai-shots-manifests/**/*.bak` after sign-off.
3. **Inactive shows (39)** — deliberately out of scope; their files may still be
   `no-store`/`1-year`. Re-run `patch_gcs_cache_control.py` without `--active-only`
   (or with a broadened scope) if any get reactivated.
