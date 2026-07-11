# Signing — Next Steps Once All Episodes Are Combined

*What to do after the catalog is uniform (`*_combined.m3u8` everywhere). This is the "clean end state" for the signing system.*

---

## Where we are today (mixed catalog)

Verified in `master.showcache` (2026-07-07): the play-out surface has **three delivery types**, and signing only cleanly covers one of them.

| Type | Count | Route / status | Signed? |
|---|---|---|---|
| **Combined** `*_combined.m3u8` (`.m4s`) + trailers | 2,986 + 31 | enforced route | ✅ signed |
| **Legacy `/hls/`** (`.ts`), 45 shows | 682 | `/hls/` open passthrough | ❌ unsigned (can't master-only sign — master/child indistinguishable by path) |
| **Mux** (`stream.mux.com`), 23 inactive shows | 223 | off-CDN | ❌ unsigned (not on our CDN at all) |

So today, **combined is protected; legacy `/hls/` and Mux are not** — they stay on open routes so they keep playing. That's an accepted interim gap.

---

## The end state we want

**Every active playback URL is a `*_combined.m3u8` on our CDN.** Then one rule (`REQUIRE_SIGNATURES` on `*_combined.m3u8`) protects 100% of active content, the special-case routes go away, and Mux can be dropped entirely.

---

## What to do — in order

### 1. Migrate legacy `/hls/` (682) → combined

Re-encode each legacy episode through the **existing combined pipeline** — nothing new to build:

```
gcp_transcoder → gcp_finalize_hls → gcp_create_combined_master  (writes combined_master_m3u8_url)
   → sync-showcache-episode  →  resign Lambda signs it → master.showcache.signed_playback_url
```

- Enumerate the 682 from Mongo: `signed_playback_url` under `/hls/`, not `_combined.m3u8`, not `stream.mux.com`.
- Drive them through re-encode → combine → sync. Each result **auto-signs** (the resign Lambda) and is **auto-enforced** (matches the combined rule) — no per-episode routing.
- Batch + idempotent; track progress by counting legacy `/hls/` URLs in showcache trending toward **0**.

### 2. Migrate Mux (223, 23 inactive shows) → combined — or confirm dead

These are inactive shows. Either:
- Re-encode them into the combined pipeline (same as §1) so they're on-CDN + signed, **or**
- Confirm they're truly retired and leave them (they stay unsigned/off-CDN; harmless if never played).

Once done, **no active URL is unsigned.**

### 3. Simplify the CDN routes

After legacy `/hls/` **video** is gone, the route config collapses:
- **Combined master** (`*_combined.m3u8`) → `REQUIRE_SIGNATURES` — now covers the whole active catalog.
- **`/hls/` route** → keep **only** if audio still serves from `/hls/audio/` (keep it `DISABLED` = open for audio). If audio is moved/retired, drop the `/hls/` rule entirely.
- **`/` catch-all** → stays `DISABLED` (children/segments open — master-only enforcement, unchanged).
- Always: export → edit → import, keep `name` + `edgeSslCertificates` (per `LESSONS_LEARNED.md`).

### 4. Decide on audio

Audio (`master.podcast_showcache`, `/hls/audio/…/audio_master.m3u8`) is currently **unsigned**. Decide:
- Leave unsigned (keep the `/hls/audio/` open route), or
- Sign it too — add an audio-master rule (`/hls/audio/**/audio_master.m3u8` → `REQUIRE_SIGNATURES`) and extend the resign Lambda to sign `chai_q_lab.audio_episodes.public_master_url` (CDN URLs only).

### 5. Decommission Mux (once §2 is done)

Mux is still wired even though it's inactive:
- `SrollsServer/backend/app/core/config.py` **requires** `MUX_TOKEN_ID/SECRET/SIGNING_KEY/SIGNING_KEY_SECRET` to boot.
- The Mux refresh job (`backend/app/scripts/refresh_signed_playback_urls.py`) is CI/CD'd and writes `signed_playback_url` for episodes that still have a `signed_playback_id`.

Once no active content is on Mux:
- Stop/retire the Mux refresh job (and its EventBridge/Batch schedule).
- Remove the Mux settings from `config.py` (make them optional or delete).
- Note: 182 combined episodes still carry a `signed_playback_id`. As long as the Mux job never runs they're fine, but for cleanliness the resign Lambda could clear `signed_playback_id` when it writes a combined URL — removes the latent conflict permanently.

### 6. Retire the one-time cleanup scaffolding

- The manifest-strip scripts (`strip_manifest_params.py`, `batch_strip_manifests.py`, `run_batch_cleanup.sh`) were one-time; they're done. Keep for reference or delete.
- Update `DEPLOY-SECRETS.md` §4 — its phased rollout documents the **old catch-all** approach; point it at `RUNBOOK-enable-combined-signing.md` (the master-only approach) so nobody follows the old one.

---

## Verification (end state)

- `master.showcache`: **0** episode URLs under `/hls/` or `stream.mux.com` (all `_combined.m3u8`).
- CDN: one `REQUIRE_SIGNATURES` rule on the combined pattern; catch-all `DISABLED`; `/hls/` rule only if audio still needs it; `edgeSslCertificates` present.
- Spot-check: signed combined master → 200 (+ 30d cache hit); unsigned → 403; a child/segment with no token → 200/206.
- Resign sweep still completes in seconds (bulkWrite) and re-signs 100% of the catalog.
