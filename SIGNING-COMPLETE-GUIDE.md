# Playback URL Signing — Complete Guide (AWS today, Azure next)

**Written:** 2026-10-23. Checked against the code on branch `azure-migration` (`fd2ea36`).
**Related docs:** `SIGNING-TOKENS-IMPLEMENTED.md` (what went live 2026-07-12), `SIGNING-BEFORE-VS-NOW.md`,
`AZURE-MIGRATION-PLAN.md` (P7 + §10), `AZURE-MIGRATION-HANDOFF.md` (Phase F / G4).

---

## 1. Why signing is important (read this first)

Every combined playback master (`…/<episode>_combined.m3u8`, episodes **and** trailers) is protected at the
Media CDN edge (`chai-shorts-media-cdn`) by **token enforcement** (`REQUIRE_TOKENS`):

- A request for a combined master **without a valid token → 403**.
- The token has an **expiry**. Each signed URL is valid for **10 h** (`SIGNED_URL_TTL_SECONDS=36000`).
- The app does not sign anything itself. It reads the already-signed URL from Mongo
  (`master.showcache`).

**So the resigner cron is a hard dependency of playback.** If it stops:

| Time since last good run | Effect |
|---|---|
| 0–8 h | Nothing visible. Old tokens are still valid. |
| ~10 h | Tokens start expiring. **Every combined episode and trailer returns 403. All users lose playback.** |

This is risk #1 in the migration plan ("Resigner stops or mis-signs → all users, playback 403 within ≤10 h").

What signing gives us:
- URLs can't be shared or hot-linked forever. A copied link dies within 10 h.
- **CDN caching still works.** Only the master URL carries the token. Child playlists, segments, audio and
  legacy files are served open by separate edge routes, so they stay cacheable.

What is **not** signed (by design):
- Child playlists and `.m4s` segments of combined shows (open route).
- Legacy `/hls/` `.ts` shows (~45 shows) and Mux URLs (off-CDN).
- Audio/podcast URLs (no signing yet).

---

## 2. How a token looks

```
https://<CDN_BASE>/…/x_combined.m3u8?edge-cache-token=FullPath~Expires=<unix>~Signature=<web-safe-b64, unpadded>
```

- Algorithm: **Ed25519**, **FullPath**-scoped. The token is valid for that exact master file only, not the
  directory.
- Query param: `edge-cache-token` (`TOKEN_QUERY_PARAM`). It must match the CDN route config.
- Edge keyset: `chaishots-playback-keyset` (holds the public key).
- Private key: secret `chai-q/media-cdn-signing-key` (AWS Secrets Manager). Body:
  `{"key_name": "...", "private_key_b64url": "..."}`. On Azure the same key is in Key Vault as
  `media-cdn-signing-key`.
- Live CDN config: `aws-infra/cdn-backups/cdn-combined-token.yaml`. Rollback copies are in the same folder.

---

## 3. Where the cron is (AWS, live today)

| Item | Value |
|---|---|
| Region / account | `us-east-1` / `107647021172` |
| Scheduler | **EventBridge rule `chai-q-resign-playback-urls`** |
| Schedule | `rate(2 hours)`, **ENABLED**. It fires at **:57** past every even UTC hour (a `rate()` rule counts from when it was created). |
| Target | Lambda **`chai-q-resign-playback-urls`** (python3.11, timeout 900 s, 1769 MB), input `{}` (full sweep) |
| Terraform | `aws-infra/scheduler.tf` (rule + target + invoke permission), `aws-infra/lambda.tf:548-592` (function + zip) |
| Variables | `aws-infra/variables.tf:101-135`, values in `aws-infra/terraform.tfvars` (`resign_schedule_enabled=true`, `signing_enabled=true`, `signing_mode="token"`) |
| IAM | `aws-infra/iam_roles.tf:165-176`: read the signing secret; `resync_subtitles` may invoke the resigner |

**2 h rotation + 10 h TTL = 8 h overlap.** A URL that a player fetched just before the next rotation still
has at least 8 h left, so playback never dies mid-episode, and several runs can fail before users notice.

> ⚠ Do **not** run `terraform apply` in `aws-infra/`. There is no local state file, so it would try to
> recreate prod. To change the live Lambda: `aws lambda get-function` (download the deployed zip),
> apply only your diff, rebuild the zip with the same files as `aws-infra/lambda.tf`, then
> `aws lambda update-function-code --region us-east-1`.

---

## 4. The code

### 4.1 Files

| File | What it does |
|---|---|
| `orchestrator/resign_playback_urls.py` | **The resigner.** Lambda handler. The same code runs on Azure. |
| `orchestrator/media_cdn_signer.py` | Ed25519 signing helpers: `sign_token_fullpath()` (token mode, used in prod), `sign_url()` (old signature mode), `append_signing_params()`, `strip_existing_signing_params()` |
| `orchestrator/resign_guard.py` | **Azure only.** Safety wrapper that runs before the handler (§6.2). |
| `orchestrator/resync_subtitles.py:157-180` | After patching subtitles it re-signs that one episode (Lambda invoke on AWS, in-process on Azure via `RESIGN_INVOKE_MODE=inprocess`). |
| `dashboard/app/signing/page.js` | Dashboard **Signing** page (nav link added 2026-10-23). |
| `dashboard/app/api/signing/resign/route.js` | "Resign now" button: full sweep or one episode. |
| `dashboard/app/api/signing/{status,runs,config,alerts}/route.js` | Page data: last runs, expiry status, config, staleness alerts. |
| `dashboard/app/api/sync-showcache-episode/route.js`, `…-trailer/route.js` | When an episode/trailer is synced to showcache, invoke the resigner for that one item so it gets a token immediately. |
| `dashboard/lib/invoke.js` | Chooses the provider per function (`INVOKE_PROVIDER_RESIGN_PLAYBACK_URLS=aws|azure`). |
| `aws-infra/verify-cdn-signing.sh`, `verify-combined-signing.sh` | Manual curl checks against the edge. |
| `scripts/parity/resign_dryrun_compare.py` | Compares Azure dry runs with prod AWS runs (Gate F). |
| `tests/python/test_resign_guard.py`, `test_resync_resign_invoke.py` | Tests. |

### 4.2 What the resigner does (`resign_playback_urls.handler`)

There are two modes in one handler:

**A. Full sweep (`event == {}`; the cron sends this)**
1. Loads the signing key once (fails fast if the secret is missing or bad).
2. `_collect_sweep_targets`: reads every doc in `master.showcache`:
   - `episodes[].signed_playback_url` containing `_combined.m3u8`
   - `trailers_playback_urls[].gcpUrl` containing `_combined.m3u8` (id = `trailer_<showId>_<_key>`)
   - strips any old `?…` to get the canonical URL.
3. For each target, `_build_write` signs it with expiry = now + 10 h and builds a Mongo update:
   - episode → `$set episodes.$[ep].signed_playback_url` + `signed_playback_expires_at`
   - trailer → `$set trailers_playback_urls.$[t].gcpUrl` + `signed_playback_expires_at`
4. Writes in `bulk_write` batches of 1000 (unordered, so one bad doc can't block the rest).
5. Logs a run doc to **`chai_q_lab.playback_resign_runs`** (`updated_count`, `skipped_count`, `errors`,
   `duration_s`, `ttl_seconds`). The dashboard Signing page reads this.

**B. Single item (`{"episode_id", "canonical_url"}`)**: called by the sync routes, resync-subtitles and the
"resign one" button. Signs and writes only that episode or trailer.

**Rules:**
- It writes **Mongo only**. It never touches GCS manifests and never writes to Sanity.
- Only `_combined.m3u8` URLs get signed. Anything else is written unsigned.

### 4.3 Switches (env vars)

| Env | Prod value | Meaning |
|---|---|---|
| `SIGNING_ENABLED` | `true` | **Kill switch.** `false` writes canonical unsigned URLs and clears the expiry. Only safe if CDN enforcement is also turned off, otherwise everything 403s. |
| `SIGNING_MODE` | **`token`** | ⚠ The code default is `signature`, which the token-enforced CDN rejects with 403. It must be set explicitly. |
| `TOKEN_QUERY_PARAM` | `edge-cache-token` | Must match the CDN route. |
| `SIGNED_URL_TTL_SECONDS` | `36000` | 10 h. |
| `SIGNING_KEY_SECRET_ID` | `chai-q/media-cdn-signing-key` (AWS) / `kv:media-cdn-signing-key` (Azure) | Private key location. |
| `CDN_BASE`, `MONGO_URI` | — | — |

---

## 5. How to check it's healthy

1. **Dashboard → Signing page**: the last run should be under 2 h old with `updated_count` around 3.9k.
2. **Mongo**: `chai_q_lab.playback_resign_runs`, sorted by `started_at` descending.
3. **Edge check**: the signed URL should return 200/206 and the same URL without the token should return
   403 (`aws-infra/verify-combined-signing.sh`).
4. **CloudWatch**: logs for `/aws/lambda/chai-q-resign-playback-urls`.

---

## 6. Azure: what was built

### 6.1 Where the cron is on Azure

| Item | Value |
|---|---|
| Scheduler | **Container Apps Job `acaj-bitrater-<stamp>-resigner`** (in `cae-bitrater`, RG `rg-bitrater-prod`) |
| Schedule | cron **`0 */2 * * *`** (every 2 h). It switches to manual-trigger-only when `resigner.enabled=false`. |
| Runs | jobs image `azure-jobs/Dockerfile` → `python run_job.py resigner` → `resign_guard.run()` → `resign_playback_urls.handler({})` |
| Timeout | 3600 s (no 900 s Lambda ceiling), retry 0, parallelism 1 |
| Terraform | `azure-infra/stamps.tf:505-611` (job + env), switches in `azure-infra/variables.tf:30-66` |
| Key | Key Vault `kv-bitrater-prod` secret `media-cdn-signing-key` (copied by `azure-infra/scripts/copy_secrets_sm_to_kv.sh`) |
| Env | `SIGNING_ENABLED=true`, `SIGNING_MODE=token`, `TOKEN_QUERY_PARAM=edge-cache-token`, `SIGNED_URL_TTL_SECONDS=36000`, `RESIGN_INVOKE_MODE=inprocess`, `DRY_RUN=<resigner.dry_run>` (all set explicitly) |

The sync routes, the "Resign now" button and resync-subtitles go through `invoke.js` and the Azure
Functions handlers (`azure-functions/bitrater_wf/handlers.py`, `/api/invoke/resign-playback-urls`) when the
provider is `azure`. While `resign_invoke = "lambda"`, the Azure side still calls the **AWS Lambda**.

### 6.2 Safety wrapper (`orchestrator/resign_guard.py`)

Before the Azure job writes anything:
1. **Settings check.** The 4 `SIGNING_*` values must be set explicitly and equal prod. Otherwise it logs
   `RESIGN_CONFIG_INVALID` and exits 2. This catches the `signature` default.
2. **Isolation.** A shadow stamp may only dry-run. A real write on a shadow stamp is refused.
3. **Live CDN canary.** It signs 3 real targets (first episode, first trailer, one picked by hash) and requests
   them on the edge. Signed must return 200/206 and unsigned must return 403. Any miss logs
   `RESIGN_CANARY_FAIL` and **writes nothing**.
4. **DRY_RUN (default true).** It builds every write but doesn't flush, and logs `would_update` to
   `<lab>_shadow.playback_resign_runs` with the marker `RESIGN_DRY_RUN_OK`.
5. **Real run.** It calls the handler and logs `RESIGN_OK` (clean) or `RESIGN_PARTIAL` (some errors, exit 1).

### 6.3 Alerts (`azure-infra/monitoring.tf`)

| Alert | Fires when | Mail |
|---|---|---|
| `alert-bitrater-resign-stale-<stamp>` | no `RESIGN_OK` in **3 h** (only when the resigner really writes) | `alert_email` (rithikaabba@chaishots.in) |
| `alert-bitrater-resign-refused-<stamp>` | any `RESIGN_CANARY_FAIL` / `RESIGN_CONFIG_INVALID` | same |

Terraform refuses `dry_run=false` unless `alert_email` is set.

### 6.4 Current state of each stamp

| Stamp | `resign_invoke` | resigner | Meaning |
|---|---|---|---|
| **shadow** | `inprocess` | `enabled=true, dry_run=true, db_master="master"` | Runs every 2 h, **reads prod `master.showcache`, writes nothing to it**, logs to the shadow lab DB |
| **prod** | `lambda` | `enabled=false, dry_run=true` | Prod stamp not created yet (`enabled=false`). **AWS EventBridge + Lambda does all real signing.** |

**Phase F (24 h dry run) PASSED** (2026-10-09): 37/37 canaries OK, target 3979, would_update 3924, the same
as prod AWS `updated 3924`. `resign_dryrun_compare.py`: 23/24 runs matched prod; the one miss was catalog growth between runs.

### 6.5 Live check (2026-10-23)

**Yes, the Azure cron is running, in dry-run mode only. AWS still does all real signing.**

Scheduled jobs in `rg-bitrater-prod` (`az containerapp job list -g rg-bitrater-prod -o table`):

| Job | Trigger | Cron |
|---|---|---|
| `acaj-bitrater-shadow-resigner` | Schedule | `0 */2 * * *` (every 2 h, on the hour) |
| `acaj-bitrater-shadow-watchdog` | Schedule | `*/15 * * * *` |
| `acaj-bitrater-shadow-bcleanup` | Schedule | `30 2 * * *` |
| `acaj-bitrater-shadow-urlhealth` | Manual | — |

Last 8 resigner executions all **Succeeded**, on time every 2 h, 30–50 s each:

| Execution | Start (UTC) | Duration |
|---|---|---|
| `…-29878320` | 2026-10-22 20:00 | 35 s |
| `…-29878440` | 2026-10-22 22:00 | 49 s |
| `…-29878560` | 2026-10-23 00:00 | 53 s |
| `…-29878680` | 2026-10-23 02:00 | 31 s |
| `…-29878800` | 2026-10-23 04:00 | 36 s |
| `…-29878920` | 2026-10-23 06:00 | 35 s |
| `…-29879040` | 2026-10-23 08:00 | 29 s |
| `…-29879160` | 2026-10-23 10:00 | 33 s |

Live job settings: `DRY_RUN=true`, `DB_MASTER=master`, `DB_LAB=chai_q_lab_shadow`, `SIGNING_MODE=token`.
Each run reads prod `master.showcache`, runs the CDN canary and builds every signed URL, but **does not write
to prod**. It only logs the run to `chai_q_lab_shadow.playback_resign_runs`.

### 6.6 End-to-end verification (2026-10-23, all checks passed)

Every link in the chain was checked live:

| # | Check | Result |
|---|---|---|
| 1 | AWS EventBridge `chai-q-resign-playback-urls` | `ENABLED`, `rate(2 hours)`, target = Lambda, input `{}` |
| 2 | AWS Lambda `chai-q-resign-playback-urls` config | python3.11, 900 s, 1769 MB, `SIGNING_MODE=token`, `SIGNING_ENABLED=true`, `SIGNED_URL_TTL_SECONDS=36000`, `TOKEN_QUERY_PARAM=edge-cache-token`, key `chai-q/media-cdn-signing-key` |
| 3 | AWS runs (`chai_q_lab.playback_resign_runs`) | Every 2 h at :57 since at least 00:57 UTC. **updated 3946**, ~20 s each, TTL 36000, signing enabled |
| 4 | Azure dry runs (`chai_q_lab_shadow.playback_resign_runs`) | Every 2 h at :00. target 4001, **would_update 3946**. **Same count as AWS.** |
| 5 | Azure canary (each run) | 3/3 samples: signed **206**, unsigned **403** |
| 6 | Azure logs (Log Analytics) | `RESIGN_DRY_RUN_OK` every 2 h |
| 7 | Azure Key Vault `kv-bitrater-prod` / `media-cdn-signing-key` | present, enabled (copied 2026-09-26 from AWS SM) |
| 8 | Azure alerts | `alert-bitrater-resign-refused-shadow` enabled → action group `ag-bitrater-oncall` (rithikaabba@chaishots.in). `resign-stale` is created only when a stamp really writes (G4). |
| 9 | Prod showcache (active shows) | 3872 combined episodes, **all carry a token, 0 expired**, about 9 h until expiry (fresh from the last AWS run) |
| 10 | CDN, live sample episode | master with token **206**, master without token **403**, child playlist without token **206**, segment without token **206**, `cache-control: public, max-age=2592000`, served from cache (`age` ≈ 2 days) |

What this proves:
- AWS signs every 2 h, so the tokens users get are always fresh.
- The edge rejects unsigned masters and lets children and segments through, so caching still works.
- Azure builds exactly the same writes as AWS with the same key, and its tokens are accepted by the live
  CDN. Azure is ready for G4.

To re-check:
```
# Azure executions
az containerapp job execution list -g rg-bitrater-prod -n acaj-bitrater-shadow-resigner \
  --query "sort_by([], &properties.startTime)[-8:].{name:name,status:properties.status,start:properties.startTime}" -o table
# AWS rule + Lambda
aws events describe-rule --region us-east-1 --name chai-q-resign-playback-urls
aws lambda get-function-configuration --region us-east-1 --function-name chai-q-resign-playback-urls
# AWS vs Azure counts
MONGO_URI=... python scripts/parity/resign_dryrun_compare.py --last 12
```

---

## 7. What's left before Azure signs for real

In order. Each ★ step needs owner approval and a freeze window (see `AZURE-MIGRATION-HANDOFF.md`).

1. **Phase E parity** (shadow): not started. This is not signing work, but it comes before the cutovers.
2. **G1**: create the prod stamp (`stamps.prod.enabled=true` → `publish_functions.sh prod` → `apps=true`).
   This needs the prod Batch account and a quota ticket.
3. **G2 / G3**: dashboard bridge and backends move to Azure. **The resigner stays on the AWS Lambda through
   both** (`resign_invoke="lambda"`). The Azure dashboard's sync routes and "Resign now" button still invoke
   the AWS Lambda during this time.
4. **★ G4: resigner cutover** (the signing step):
   1. Confirm `alert_email` is set (Terraform refuses `dry_run=false` without it).
   2. In `azure-infra/variables.tf` (or tfvars), prod stamp:
      `resign_invoke = "inprocess"`,
      `resigner = { enabled = true, dry_run = false, db_master = "master" }` → `terraform plan` (check that
      only the prod resigner job, dashboard env and alerts change) → apply →
      `publish_functions.sh prod --keys-only`.
   3. Trigger one run by hand and watch it:
      `az containerapp job start -g rg-bitrater-prod -n acaj-bitrater-prod-resigner`. The log must show
      `RESIGN_OK`, and `chai_q_lab.playback_resign_runs` gets a new row with `updated_count` equal to the AWS
      count.
   4. **Run both in parallel for 24 h** (AWS EventBridge still ENABLED). Azure writes at :00 and AWS at :57.
      Both write a valid fresh token, so this is harmless.
5. Then go to §8.

---

## 8. Once you are sure Azure is doing its job

### 8.1 "Sure" means all of these held for 24 h of parallel running

| Check | How |
|---|---|
| 12/12 Azure prod runs `Succeeded` with `RESIGN_OK` (not `RESIGN_PARTIAL`, `RESIGN_CANARY_FAIL` or `RESIGN_CONFIG_INVALID`) | `az containerapp job execution list … -n acaj-bitrater-prod-resigner` + Log Analytics |
| Azure `updated_count` = AWS `updated_count` on matching runs | `chai_q_lab.playback_resign_runs` (Azure rows have `source: azure-resign-guard`) |
| Every active combined master in showcache has a token and none are expired | the showcache check in §6.6 row 9 |
| Live CDN: signed 200/206, unsigned 403 on random episodes | `aws-infra/verify-combined-signing.sh` |
| url-health shows **0 new 403s** on combined URLs | dashboard / url-health results |
| The `resign-stale` alert really mails | Test it once: leave the prod resigner on Manual for one 3 h window **while AWS is still signing** and confirm the mail arrives, then switch it back to Schedule |
| Dashboard "Resign now" (one episode and full) and sync-showcache-episode/trailer work through Azure | Signing page → resign one test episode → its `signed_playback_expires_at` moves forward |

### 8.2 Then switch AWS off (reversible)

1. **Disable (do not delete)** the AWS rule:
   `aws events disable-rule --region us-east-1 --name chai-q-resign-playback-urls`
2. **Keep the Lambda `chai-q-resign-playback-urls` and the secret `chai-q/media-cdn-signing-key`.** They are
   the rollback path.
3. Watch the next 3 Azure runs (6 h). Confirm only Azure rows appear in `playback_resign_runs`, with
   `RESIGN_OK` each time.
4. Record the change (date, last AWS run, first Azure-only run) in `AZURE-MIGRATION-PLAN.md` §10.

### 8.3 Day-to-day after cutover

- **Where it runs:** Container Apps job `acaj-bitrater-prod-resigner`, `0 */2 * * *`. Same code
  (`resign_playback_urls.py` through `resign_guard.py`), same key (Key Vault `media-cdn-signing-key`).
- **Who watches it:** `resign-stale-prod` (no `RESIGN_OK` in 3 h) and `resign-refused-prod` (canary/config
  refused) mail `ag-bitrater-oncall`. With a 10 h TTL there are about 7 h left to react after the
  staleness alert fires.
- **Manual run:** `az containerapp job start -g rg-bitrater-prod -n acaj-bitrater-prod-resigner`, or the
  dashboard Signing page.
- **Code changes:** rebuild the jobs image (`azure-jobs/Dockerfile`), set its digest in `var.images.jobs`,
  apply. Changes to `resign_playback_urls.py` also go to the Functions package (`publish_functions.sh prod`),
  which serves the single-episode path.
- **Key rotation:** add the new public key to keyset `chaishots-playback-keyset` first, then update Key Vault
  `media-cdn-signing-key`, run once by hand, confirm 206, and only then remove the old public key.

### 8.4 Rollback (any time)

Tokens last 10 h, so a broken Azure resigner gives several hours of slack.

- Quick: `aws events enable-rule --region us-east-1 --name chai-q-resign-playback-urls`, then
  `aws lambda invoke --region us-east-1 --function-name chai-q-resign-playback-urls --payload '{}' out.json`
  to sign immediately. Then set the Azure prod resigner to `enabled = false` (Manual) and apply.
- Full revert of everything: `scripts/cutover/revert_to_aws.sh --apply` (switches the Azure jobs to Manual,
  re-enables both EventBridge rules, resumes App Runner).

### 8.5 Later (not part of the cutover)

- **H:** 30-day soak with Azure as the only signer.
- AWS resources (EventBridge rule, Lambda, secret) are deleted **only** through `AWS-RETIREMENT-PLAN.md`:
  30 clean days, both revert drills done, explicit owner approval of the exact resources, backups exported.
  Until then they stay as the revert path.

---

## 9. Emergency cheat-sheet

| Situation | Do this |
|---|---|
| Users get 403 on combined masters | Check the last run on the Signing page. If it's old, click **Resign now** (full sweep) or run the signer by hand. Before G4: `aws lambda invoke --region us-east-1 --function-name chai-q-resign-playback-urls --payload '{}' out.json`. After G4: `az containerapp job start -g rg-bitrater-prod -n acaj-bitrater-prod-resigner`. |
| Resigner broken and can't be fixed fast | Turn CDN enforcement off with the rollback yaml in `aws-infra/cdn-backups/` (async import: poll the operation until `done:true`), **then** set `SIGNING_ENABLED=false`. Never set `SIGNING_ENABLED=false` while enforcement is on. |
| One episode 403s | Resign that one from the Signing page (single-item mode). |
| Azure canary fails (before G4) | Azure writes nothing, so AWS is still signing. Check `SIGNING_*` env values and the CDN route/keyset. |
| Azure resigner fails after G4 | Re-enable the AWS EventBridge rule and invoke the Lambda once (§8.4). Then fix Azure. |
