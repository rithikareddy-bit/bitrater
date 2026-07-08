# Runbook — Enable rotating signed tokens on combined masters

Puts a rotating signed token (2 h rotation, 10 h TTL) on every combined
playback master (`*_combined.m3u8` — episodes + trailers). Only the master is
enforced; child playlists + segments stay open so native players keep working.
Legacy `/hls/`, audio, and Mux stay unsigned.

**Golden rules** (see `LESSONS_LEARNED.md`):
- Never write a CDN import YAML from scratch — start from a live export.
- Every import YAML must include `name` + `edgeSslCertificates` (a dropped cert
  caused the 2026-06-10 SSL outage). The prepared YAMLs here already do.
- `gcloud edge-cache services import` **replaces** the whole config; any field
  absent from the file is deleted.
- Never enforce signatures on child playlists/segments — that forces manifest
  baking + `no-store` (the original bug). Only `*_combined.m3u8` is enforced.
- **`import` is ASYNC. One driver, one import at a time, and POLL the operation
  to `done:True` before you touch the service again.** See the callout below —
  this caused a real race on 2026-07-07.

Service: `chai-shorts-media-cdn` · Project: `media-cdn-poc-466009` ·
Keyset: `chaishots-playback-keyset`

---

## ⚠️ CRITICAL: CDN imports are asynchronous — poll before the next step

`gcloud edge-cache services import` **kicks off a background operation** on
Google's side that takes ~1–2 min to apply and propagate. **The client command
returning (or timing out) does NOT mean the change is finished.**

**What went wrong on 2026-07-07 (don't repeat it):** a canary import and its
rollback were fired back-to-back while each client command timed out at 2 min.
Both operations kept running server-side and **completed out of order** — the
delayed canary import re-applied enforcement *after* the rollback, so the service
looked "rolled back" on one read and "still enforcing" moments later. Only
`oh-my-dog ep1` was affected (scoped canary), but it was avoidable.

**Rules that prevent it:**
1. **One driver.** Never let two people/sessions run imports on this service at
   the same time.
2. **Never fire imports back-to-back.** After every import, wait until it's fully
   done before the next action.
3. **Poll to `done:True`.** After an import, confirm no operation is still
   in-flight, then verify the modes.
4. **Give your shell a generous timeout** (5–8 min), so the command doesn't get
   cut off mid-operation and leave a background op running blind.

**Poll helper — run after EVERY import, before doing anything else:**

```bash
PROJ=media-cdn-poc-466009; SVC=chai-shorts-media-cdn

# 1. Wait until no operation is in-flight (done:false):
until [ -z "$(gcloud edge-cache operations list --project=$PROJ \
  --filter='done=false' --format='value(name)')" ]; do echo "waiting…"; sleep 10; done

# 2. Only now read the applied state:
gcloud edge-cache services describe $SVC --project=$PROJ \
  --format="yaml(edgeSslCertificates, routing.pathMatchers[0].routeRules[].routeAction.cdnPolicy.signedRequestMode)"
```

Every import step in this runbook (canary, catalog-wide, rollback) must be
followed by this poll+verify before the next step.

---

## 0. Pre-flight

```bash
# Backup live config (timestamped).
gcloud edge-cache services export chai-shorts-media-cdn \
  --destination=cdn-backups/cdn-backup-$(date +%Y%m%d-%H%M%S).yaml \
  --project=media-cdn-poc-466009

# Confirm the keyset exists and matches the short name the signer uses.
gcloud edge-cache keysets describe chaishots-playback-keyset \
  --project=media-cdn-poc-466009

# Confirm caching is still 30 d and nothing is no-store (must not regress).
for u in <combined.m3u8> <child.m4s> <legacy.ts>; do curl -sI "$u" | grep -i cache-control; done
# expect: cache-control: public, max-age=2592000   (none no-store / private,max-age=0 / 31536000)
```

Also confirm the Secrets Manager secret `chai-q/media-cdn-signing-key` holds
JSON `{"key_name": "...", "private_key_b64url": "..."}` and that `key_name`
equals `chaishots-playback-keyset` (else the edge returns
`403 signed_request_public_keyset_name_mismatch`).

---

## 1. Deploy the Lambda (routing still DISABLED)

`signing_enabled` / `resign_schedule_enabled` now default to `true` in
`variables.tf`; confirm the deploy host's `terraform.tfvars` doesn't override
them to `false`, then:

```bash
cd aws-infra && terraform apply
```

This ships the re-armed `chai-q-resign-playback-urls` Lambda (env
`SIGNING_ENABLED=true`, `SIGNED_URL_TTL_SECONDS=36000`,
`SIGNING_KEY_SECRET_ID=chai-q/media-cdn-signing-key`) and enables the 2 h cron.
The edge is still DISABLED, so unsigned clients keep playing.

---

## 2. Populate Mongo with signed masters

```bash
aws lambda invoke --function-name chai-q-resign-playback-urls \
  --payload '{}' /dev/stdout | cat
```

Confirm in Mongo (`chai_q_lab.playback_resign_runs`): latest run has
`signing_disabled: false`, a non-zero `updated_count`, and `ttl_seconds: 36000`.
Spot-check a `master.showcache` episode: `signed_playback_url` now ends with
`?Expires=...&KeyName=chaishots-playback-keyset&Signature=...` (full-path token —
no `URLPrefix`) and `signed_playback_expires_at` is set ~10 h out.

The cron (EventBridge `chai-q-resign-playback-urls`, `rate(2 hours)`) re-signs
automatically thereafter. Stop any manifest strip job — it's not needed for
master-only enforcement.

---

## 3. STAGING GATE — one-episode canary (blocks the catalog-wide flip)

Pick one active combined episode `E`. Get its combined master path from Mongo.

```bash
# Edit cdn-canary-combined-signing.yaml: replace REPLACE_EPISODE_ID with E's id,
# and confirm one of its pathTemplateMatch lines matches E's master depth.
cp cdn-backups/cdn-backup-<ts>.yaml cdn-backups/rollback.yaml   # instant-rollback copy
gcloud edge-cache services import chai-shorts-media-cdn \
  --source=cdn-backups/cdn-canary-combined-signing.yaml \
  --project=media-cdn-poc-466009
# ⚠️ ASYNC — POLL before testing (see the CRITICAL callout at the top):
until [ -z "$(gcloud edge-cache operations list --project=media-cdn-poc-466009 --filter='done=false' --format='value(name)')" ]; do sleep 10; done
gcloud edge-cache services describe chai-shorts-media-cdn --project=media-cdn-poc-466009 \
  --format="yaml(edgeSslCertificates,routing.pathMatchers[0].routeRules[].routeAction.cdnPolicy.signedRequestMode)"
```

Run all checks against `E`'s **signed** master (from Mongo). Use
`verify-combined-signing.sh "<signed master URL>"` (walks master → children →
segments):

- **G1** signed master → `200` + `Cache-Control: public, max-age=2592000`
  (NOT `no-store`) + `x-cache-status` hit on the 2nd fetch.
- **G2** master with `?...&Signature=...` stripped → `403`.
- **G3** master with one char of `Signature` altered → `403`.
- **G4 (critical)** every child `.m3u8` + `.m4s` segment fetched **with no
  token** → `200/206`. Any `403` ⇒ STOP: matcher is too broad — re-import
  `rollback.yaml`, narrow the matcher, retry.
- **G5** full playback of `E` on a real **iOS** and **Android** device.
- **G6** after a 2 h cron tick, `E`'s `Expires` advances; a token minted just
  before the tick still plays after (10 h / 2 h overlap).

Any fail ⇒ `gcloud edge-cache services import --source=cdn-backups/rollback.yaml`
(only `E` was affected), fix, retry.

---

## 4. Catalog-wide flip

Only after all six gates pass:

```bash
# Confirm cdn-combined-signing.yaml covers every real combined-master depth.
# VERIFIED 2026-07-07: all combined masters (episodes + trailers) are depth 3
# (/{id}/{ts}/{file}_combined.m3u8 → matched by /*/*/*_combined.m3u8). The 1/2/4
# rules are harmless future-proofing. Add deeper lines only if a new folder shape
# appears.
gcloud edge-cache services import chai-shorts-media-cdn \
  --source=cdn-backups/cdn-combined-signing.yaml \
  --project=media-cdn-poc-466009
# ⚠️ ASYNC — POLL before verifying (see the CRITICAL callout at the top):
until [ -z "$(gcloud edge-cache operations list --project=media-cdn-poc-466009 --filter='done=false' --format='value(name)')" ]; do sleep 10; done
gcloud edge-cache services describe chai-shorts-media-cdn --project=media-cdn-poc-466009 \
  --format="yaml(edgeSslCertificates,routing.pathMatchers[0].routeRules[].routeAction.cdnPolicy.signedRequestMode)"
# expect: route 1 REQUIRE_SIGNATURES, routes 2 & 3 DISABLED, edgeSslCertificates present.
```

Mongo already holds signed combined URLs, so new fetches work immediately; only
clients holding stale unsigned URLs refetch. Legacy `/hls/`, audio, and Mux
keep playing unsigned (their routes stayed DISABLED).

**Post-flip verification**
- Unsigned combined master → `403`; signed master → `200` + cache hit on repeat.
- **Note:** the signed master returns `Cache-Control: private, max-age=2592000`
  (NOT `public`). This is expected — Media CDN rewrites signed responses to
  `private`. The **edge still caches it** (`x-cache-status: …;hit`, 30-day
  max-age preserved), and the **segments stay `public`** (open route), so 30-day
  caching is intact. `private` only affects downstream/client caching of the
  master. Verified on the 2026-07-07 canary.
- A child `.m3u8` / `.m4s` / legacy `.ts` fetched with no token → `200/206`.
- A legacy `/hls/` master and a Mux URL still `200` unsigned.

## Rollback (any time)

**ALWAYS revert the CDN FIRST.** Re-importing the backup sets every route back to
`DISABLED`, so the edge stops enforcing — both signed AND unsigned URLs play
immediately, no 403s:

```bash
gcloud edge-cache services import chai-shorts-media-cdn \
  --source=cdn-backups/rollback.yaml --project=media-cdn-poc-466009
# ⚠️ ASYNC — POLL until the rollback op finishes, THEN verify (do NOT assume it's
# reverted just because the command returned — see the CRITICAL callout up top):
until [ -z "$(gcloud edge-cache operations list --project=media-cdn-poc-466009 --filter='done=false' --format='value(name)')" ]; do sleep 10; done
# verify: all routes DISABLED, edgeSslCertificates present
gcloud edge-cache services describe chai-shorts-media-cdn --project=media-cdn-poc-466009 \
  --format="yaml(edgeSslCertificates,routing.pathMatchers[0].routeRules[].routeAction.cdnPolicy.signedRequestMode)"
```

Only **after** the CDN is DISABLED, if you also want to stop minting tokens, set
`signing_enabled=false` and re-apply — the next sweep rewrites masters to
canonical (unsigned) URLs and clears `signed_playback_expires_at`.

> ⚠️ **ORDER IS CRITICAL. Never set `signing_enabled=false` while the CDN still
> enforces.** Doing so writes UNSIGNED URLs into Mongo that the enforcing edge
> will 403 → platform outage. CDN-to-DISABLED first, signing-off second. Always.
