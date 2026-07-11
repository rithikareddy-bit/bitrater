# Tokenized Playback URLs — What We Built (LIVE)

**Status:** LIVE in production since **2026-07-12**. Master-only token enforcement on all combined
playback masters, caching preserved. (Dual-token / segment propagation was explored and **deliberately
not implemented** — see "Deliberately not done".)

---

## Goal (achieved)
Put a **rotating, expiring token** on every combined playback master so URLs can't be freely shared,
**without breaking CDN caching**. The token is on the **master only**; children, segments, audio, and
legacy stay open. No cookies, no manifest baking, no dual-token.

---

## How it works
- **Token format:** Media CDN signed *token* (`REQUIRE_TOKENS`), **Ed25519**, **FullPath**-scoped, carried
  in the `edge-cache-token` query param:
  `…/x_combined.m3u8?edge-cache-token=FullPath~Expires=<unix>~Signature=<web-safe-b64, unpadded>`
- **Keyset:** `chaishots-playback-keyset` (holds the Ed25519 public key the edge validates against).
- **Rotation:** every **2h**; **TTL 10h** → 8h overlap so a URL never dies mid-play.
- **Scope:** combined masters only (`*_combined.m3u8`, episodes + trailers). 3,498 URLs.
- **Signing path:** **Mongo-only.** The resign Lambda writes the token onto the master URL in
  `master.showcache`. It never rewrites GCS manifests (that path caused the old 900s timeout + `no-store`
  caching break).

---

## CDN config (live) — `aws-infra/cdn-backups/cdn-combined-token.yaml`
Three routes on `chai-shorts-media-cdn`:

| Priority | Matches | Mode | Result |
|---|---|---|---|
| 1 | combined masters — `/*_combined.m3u8` … `/*/*/*/*_combined.m3u8` (per-depth) | **`REQUIRE_TOKENS`** | valid token → 200; missing/expired/tampered → 403 |
| 2 | `/hls/…` (audio + legacy video) | `DISABLED` | open — no token needed |
| 3 | `/` catch-all (child playlists, segments) | `DISABLED` | open — no token needed |

Route 1 also sets `signedRequestKeyset: chaishots-playback-keyset`,
`signedTokenOptions: { tokenQueryParameter: edge-cache-token, allowedSignatureAlgorithms: [ED25519] }`,
and `cacheKeyPolicy.excludeQueryString: true`. `edgeSslCertificates: media-cdn-ssl` kept byte-for-byte.

---

## Components
- **Signer:** `orchestrator/media_cdn_signer.py::sign_token_fullpath` (the older `sign_url` signature
  function is retained; `SIGNING_MODE` selects which).
- **Lambda:** `chai-q-resign-playback-urls` — env `SIGNING_MODE=token`, `TOKEN_QUERY_PARAM=edge-cache-token`,
  `SIGNED_URL_TTL_SECONDS=36000`, `SIGNING_ENABLED=true`. Handler branches in `_sign`.
- **Cron:** EventBridge `chai-q-resign-playback-urls`, `rate(2 hours)` → full sweep (bulkWrite, ~15s).
- **Dashboard:** `dashboard/app/api/signing/status/route.js` shows token status (projection bug fixed so
  `latest_run_started_at` populates).

---

## What we did, in order (all verified)
1. **Built** `sign_token_fullpath`; local crypto self-test passed (format, signature verify, tamper reject,
   path-binding).
2. **Wired** `SIGNING_MODE` flag (default `signature`, so deploying the code is inert until flipped) +
   terraform env.
3. **Deployed** (`terraform apply`) → Lambda in token mode. CDN still `DISABLED`.
4. **Paused cron**, **tokened one episode** (oh-my-dog ep 1), smoke-tested (tokened master 200 + cache +
   dashboard recognized it + **played in the app**).
5. **Full sweep** → all 3,498 masters tokened (`updated 3498, skipped 0, errors 0`, ~15s); **re-enabled cron**.
6. **Cache check** — master + child `.m3u8` + `.m4s` init/media segments all 200 + `max-age=2592000` + hit.
   No regression.
7. **Canary** — imported `REQUIRE_TOKENS` on ep 1 only. Gates **G1–G5 pass**: valid token 200 + cache;
   no token 403; tampered token 403; children/segments (no token) 200; **plays on iOS + Android**. Then
   **reverted** to all-`DISABLED`.
8. **Catalog-wide flip** (2026-07-12, low traffic): backup → import `cdn-combined-token.yaml` → poll op to
   done → verify → spot-check across **5 different shows** (token 200, no-token 403, audio/child/segment
   open). **LIVE.**

---

## Current live behavior
- **Combined master, valid token** → 200 + 30-day cache hit.
- **Combined master, no/expired/tampered token** → 403.
- **Audio, legacy `/hls/`, child playlists, segments** (no token) → 200/206 (open, unaffected).
- Tokens rotate every 2h; the app swaps in a fresh URL each cycle.

Note: under enforcement the master response is `Cache-Control: private, max-age=2592000` (Media CDN marks
signed responses `private`) — **the edge still caches it 30 days**; segments stay `public`. Caching is intact.

---

## Rollback
Re-import the pre-flip backup → all routes `DISABLED` → poll op to done. **CDN-first, always.**
```
gcloud edge-cache services import chai-shorts-media-cdn \
  --source=aws-infra/cdn-backups/cdn-backup-20260712-024532.yaml --project=media-cdn-poc-466009
```
(Only after the CDN is DISABLED, if you also want to stop token generation: set `signing_mode=signature`,
redeploy, re-sweep.)

---

## Key facts (grounded — don't relearn the hard way)
- **Matcher:** per-depth `*`-per-segment (`/*/*/*_combined.m3u8`). `**` + a literal suffix
  (`/**_combined.m3u8`) is **INVALID** on Media CDN (no literal text after `**`). All masters are depth-3.
- **Token param default IS `edge-cache-token`** — matches what the Lambda writes, so no mismatch.
- **`excludeQueryString: true`** strips the rotating token from the cache key → the master caches by its
  **bare path**, shared across users; rotation never fragments the cache.
- **Transition:** clients holding stale *signature*-format URLs 403 until they refetch (self-heals on
  relaunch) — that's why the flip ran at low-traffic night.

---

## Deliberately not done (scope)
- **Segment-level protection (dual-token / token propagation):** NOT implemented. Segments are open, so
  master-only stops **link-sharing** (the master expires) but not someone extracting the raw segment URLs.
  Adding it would require `REQUIRE_TOKENS` with `GENERATE`/`PROPAGATE` on separate routes **and** a caching
  measurement (propagation rewrites manifests). Only pursue if raw-segment protection becomes a real need.
- **Legacy `/hls/` + audio:** stay open/unsigned (audio must play token-free; legacy masters aren't
  path-separable from their children, so they can't be master-only enforced without re-encoding to combined).

---

## Files
- **Code** (committed earlier): `orchestrator/media_cdn_signer.py`, `orchestrator/resign_playback_urls.py`,
  `aws-infra/lambda.tf`, `aws-infra/variables.tf`, `aws-infra/terraform.tfvars`,
  `dashboard/app/api/signing/status/route.js`.
- **CDN configs** (committed `f883dee`): `cdn-canary-token.yaml`, `cdn-combined-token.yaml`,
  `cdn-revert-alldisabled.yaml`, `cdn-backup-20260711-145145.yaml`, `cdn-backup-20260712-024532.yaml`.
