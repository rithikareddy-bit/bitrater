# Azure Migration Plan: bitrater AWS → Azure (zero risk to prod)

> **Continuing this work? Start with `AZURE-MIGRATION-HANDOFF.md`.** It covers the current state, what was built, how it was verified, and the exact next steps. This file is the contract (§0 rules, phases, gates) plus the progress log (§10).

Status: DRAFT for review · last updated 2026-09-26
Owner: rithika · Subscription: `Azure subscription 1` (tenant `krishnachaishots`) · Region: Central India

---

## 0. The zero-risk-to-prod method (every step below follows these rules)

**P1. Prod stays exactly as it is until a cutover step.**
- AWS prod (App Runner, 6 Step Functions, 17 Lambdas, Batch, EventBridge, Secrets Manager) keeps running the **current code, unchanged**. It is **not redeployed** during the migration.
- Migration code lives on a branch. It is only deployed to Azure.
- If prod needs a hotfix during the migration, it goes through the normal AWS deploy and is ported to the branch too.

**P2. Azure is built next to prod, fully isolated, and never shares anything writable with prod.**

| Resource | Prod (untouched) | Azure shadow |
|---|---|---|
| Mongo databases | `master`, `chai_q_lab` | `master_shadow`, `chai_q_lab_shadow` (same Cosmos cluster, separate DBs) |
| GCS transcode scratch | `chai-q-transcoder-input` / `-output` | `chai-q-az-shadow-input` / `-output` |
| GCS publish / CDN origin | `chai-shots-manifests` | `chai-q-az-shadow-manifests` (no CDN in front) |
| Audio buckets | `chai-q-audio-transcoder`, `chai-q-audio-public` | `chai-q-az-shadow-audio` |
| Media CDN | live, never touched | not used; shadow output is checked through GCS reads |
| Sprites / vtt-worker | Cloud Run, untouched | not called in shadow |

Why separate buckets are mandatory: `gcp_copy_s3_to_gcs.py:242-244` **deletes `chai-q-transcoder-output/{episode_id}/`** at the start of every run. A shared bucket would let a shadow run wipe a prod run's output.

**P3. Reads from prod are allowed; writes to prod are not, until that component's cutover.**
- Allowed reads: prod Mongo (to seed shadow data, to compare), S3 / Azure Blob sources, GCS prod output, and HTTP GETs on `cdn.chaishots.in` (to verify tokens).

**P4. Every cutover is a config switch, and it's reversible within minutes.**
- AWS resources are **paused or disabled, never deleted**, through deployment, parity, cutover and at least 30 days of clean Azure operation.
- Rollback for every step is written down (§6) before it runs.

**P5. Gates, not dates.**
- A component moves forward only when its gate (§6) passes with measured evidence.
- Any failed gate metric means stop and roll back.

**P6. Cutovers happen only in a freeze window with nothing in flight.**
- Checked, not assumed:
  - `aws stepfunctions list-executions --status-filter RUNNING` = 0 for all 6 machines
  - Batch RUNNING/RUNNABLE = 0
  - `chai_q_lab.pipeline_runs` status RUNNING = 0
- This protects against the new dashboard's startup recovery (`lib/pipelineRecovery.js`) picking up runs that hold AWS execution ARNs.

**P7. The playback-critical path goes last and has two layers of protection.**
- The resigner (tokens expire 10 h after signing) is cut over last.
- It runs in **dry-run** first.
- Then it runs **alongside** EventBridge, with a **canary guard** that aborts before writing if its own tokens fail against the live CDN.

**P8. Operating rules for Claude / anyone executing this plan.**
- Read-only commands against prod are fine.
- **Any command that writes to prod** needs **explicit approval for that step**. That covers:
  - prod Mongo DBs
  - prod GCS buckets
  - Media CDN config
  - AWS prod resources
  - Route 53 / DNS
  - Cosmos firewall
  - Secrets Manager
- Creating new Azure resources that cost money (first `terraform apply`, quota requests) also needs approval.
- New GCP shadow buckets need approval. They are additive only.

**P8b. AWS is retained until Azure is proven; retirement is separate.**
- Nothing in AWS is deleted during deployment, parity, cutover or soak.
- The code stays dual-provider (`CLOUD_PROVIDER=aws|azure`).
- Mongo fields and GCS paths stay compatible both ways.
- Secrets are rotated in both Key Vault and Secrets Manager.
- The revert runbook is drilled twice at G3:
  1. Freeze.
  2. Disable the Azure crons and scale the Azure dashboard to 0.
  3. Resume App Runner.
  4. Re-enable EventBridge.
  5. Smoke-test.
  6. Unfreeze.
  Target: under 15 minutes.
- After the soak, Phase I may retire AWS compute only with explicit approval and a fresh backup/export of AWS Terraform state. S3 remains until every referenced S3 object has been migrated and Mongo URLs verified.

The detailed execution plan is in `~/.claude/plans/plan-it-first-wiggly-riddle.md`.

**P9. Out of scope, so there is no risk from them.**
- S3 data migration (decided 2026-09-26; S3 is left as-is and still read where `s3_url` points).
- Everything on GCP: Transcoder, GCS prod buckets, Media CDN, Cloud Run vtt-worker.
- MongoDB schema and data layout.
- Cosmos firewall changes (the security follow-ups in §8 are separate changes).

---

## 1. Scope
Move **bitrater's own AWS compute** to Azure:
- App Runner dashboard
- 6 Step Functions
- 17 Lambdas
- AWS Batch (research lab + ViSQOL)
- 2 EventBridge schedules
- ECR
- Secrets Manager

The pipeline keeps calling GCP (Transcoder, GCS, Media CDN) exactly as today, just from Azure.

## 2. What exists today (verified live 2026-09-26)

**AWS, account 107647021172, us-east-1** (Terraform in `aws-infra/`, 102 state entries, no drift):

| Piece | Details | Code |
|---|---|---|
| App Runner `chai-q-dashboard` | 1 vCPU/2 GB. Next.js. Runs the in-process orchestrator (≤15 h loops, Mongo `locked_by` lock), the parallel-resol Batch pool (~120 jobs, `pr_lock`) and the 5-min trailer scanner (`scanner_locks`). No login | `dashboard/` |
| Step Functions | `Chai-Q-Orchestrator-H264`/`-H265` (lab search loop, 15–25 s, ≤2880 cycles); `GCP-Orchestrator` (copy → transcode → poll 60 s → finalize); `Audio-Orchestrator`; `Audio-Show-Batch` (Map 30, nested); `Chai-Q-Orchestrator` (legacy) | `orchestrator/*step_function*.json` |
| Lambdas (17) | `chai-q-` aggregator, mark-lab-failed, search-orchestrator, gcp-copy-s3-to-gcs (900 s), gcp-transcoder, gcp-check-status, gcp-finalize-hls (600 s), gcp-create-combined-master, quality-checker (ffmpeg layer), url-health-checker, resync-subtitles, resign-playback-urls, audio-copy, audio-transcoder, audio-check, audio-list-episodes, s3-trigger | `orchestrator/*.py` |
| EventBridge | `chai-q-resign-playback-urls` `rate(2 hours)` ENABLED; `chai-q-url-health-checker` `rate(1 hour)` | `aws-infra/scheduler.tf` |
| Batch | EC2 Spot 0–512 vCPU. `chai-q-worker` (2-pass x264/x265 + libvmaf, 4 vCPU/7 GB, 20 h); `audio-visqol` (4 vCPU/8 GB) | `research-worker/`, `audio-visqol-worker/` |
| Secrets Manager | `chai-q-gcp-credentials`, `chai-q/media-cdn-signing-key` (Ed25519), `chai-q-audio-mongo-uri` | |
| ECR | `chai-q-worker`, `chai-q-dashboard`, `audio-visqol-worker` | |

**Azure (already exists):**
- Cosmos Mongo vCore `prodcluster` (M60). Public access is on, with firewall AllowAll.
- Sanity uploads already go to `chaishotsblobstoredev/sanity-dev-store` (not ours).
- No bitrater compute exists on Azure yet.
- Quota: 65 regional vCPU, 0 GPU.

## 3. Target on Azure (new resource group `rg-bitrater-prod`, Central India)

| AWS | Azure |
|---|---|
| App Runner | Container Apps app, single revision mode, `min = max = 1`, Entra ID login, `APP_BASE_URL=http://localhost:3000` (so self-calls skip the login) |
| Step Functions | Durable Functions (Python, Flex Consumption) |
| Short Lambdas | Azure Functions (same app) |
| Lambdas at 600–900 s, quality check (ffmpeg), resigner, url-health | Container Apps Jobs (manual trigger + cron) |
| EventBridge | Container Apps Job cron |
| AWS Batch | Separate Azure Batch account, Spot pool and managed identity per stamp; autoscale from 0, container tasks from ACR |
| ECR | ACR `bitraterprodacr` |
| Secrets Manager | Key Vault `kv-bitrater-prod` + user-assigned managed identities |
| GCP key via Secrets Manager | Key Vault secret now. Workload Identity Federation later (optional) |
| S3 source reads | Unchanged: a read-only AWS key in Key Vault, used only where `s3_url` is S3 |
| CloudWatch | Log Analytics + App Insights |
| Terraform `aws` (local state) | Terraform `azurerm` in `azure-infra/`, remote state in a Blob container |

## 4. Code changes (on branch `azure-migration`; AWS prod never runs this code)

**Isolation switches** (defaults = today's values, so behaviour is identical unless set):
- DB names:
  - `DB_LAB` (default `chai_q_lab`) replaces 73 hard-coded uses.
  - `DB_MASTER` (default `master`) replaces 45 hard-coded uses.
  - `DB_SUBTITLES` (default `gld2sqs`) is read-only.
- Buckets: `GCS_INPUT_BUCKET`, `GCS_OUTPUT_BUCKET`, `GCS_MANIFEST_BUCKET`, `AUDIO_*` replace 13 hard-coded bucket literals.
- `CDN_BASE`.
- `CLOUD_PROVIDER=aws|azure` selects the adapters below.

**Provider adapters** (one seam each, AWS and Azure implementations side by side):
- `dashboard/lib/workflows.js`: start/describe/stop. Used by `push`, `gcp`, `gcp-status`, `audio/*`, `stop-lab`, `auto-pipeline/cancel`.
- `dashboard/lib/jobs.js`: submit/list/describe/terminate. Used by `parallelResolLab.js`, `stop-lab`, `cancel`, `active-runs`, `audio/visqol`.
- `dashboard/lib/invoke.js`: runs a function. Used by `create-combined-master`, `quality-check`, `resync-subtitles`, `signing/resign`, `sync-showcache-episode`, `sync-showcache-trailer`.
- `orchestrator/secrets.py`: Key Vault or Secrets Manager.
- `orchestrator/jobs.py`: Azure Batch or AWS Batch, for `search_orchestrator.py`.
- A **dual-ID lookup**: any ID starting `arn:aws:` always goes to the AWS client. This is a second safety net on top of the freeze window.

**Ports:**
- Step Function JSON → Durable orchestrators `lab_search`, `gcp_transcode`, `audio_transcode`, `audio_show_batch`, with identical retry/catch/poll semantics.
- The legacy `Chai-Q-Orchestrator` + `s3-trigger` are not ported. `scripts/cutover/audit_legacy_s3_trigger.sh` must show no activity over the full observation window before G3. If it is active, port it before cutover; do not disable it merely to make the gate pass.

**Resigner canary guard** (new, Azure version only):
1. Before the bulk write, sign 3 sample URLs.
2. GET each through `cdn.chaishots.in`. Expect 200 signed and 403 unsigned.
3. **Abort without writing** if any check fails, and raise an alert.
- There is also a `DRY_RUN=true` mode: compute everything, write only to `chai_q_lab_shadow.playback_resign_runs`.

**Tests:**
- Unit tests prove the defaults reproduce today's DB/bucket names.
- Contract tests for each adapter.
- Replay tests comparing AWS vs Azure outputs.

## 5. Phases

| Phase | What | Prod impact | Needs approval |
|---|---|---|---|
| **A. Foundations** | New RG, ACR, Key Vault, Log Analytics, identities, Container Apps env, Function App, isolated per-stamp Batch accounts/pools, Terraform. Quota request (Spot vCPU). Copy secrets into Key Vault (read from Secrets Manager, write to Key Vault only) | None | Yes: first apply (cost), quota request, secret copy |
| **B. Shadow data + buckets** | Create GCS shadow buckets. Seed `master_shadow` / `chai_q_lab_shadow` from prod (read-only dump → restore to the shadow DBs): test shows (`test-123`, `test-1234567`, `test-jas123`) + ~10 real episodes, 2 trailers, 1 podcast show | None (prod read only) | Yes: GCS bucket creation, the seed |
| **C. Code on branch** | Isolation switches + adapters + ports + canary guard + tests | None (not deployed to AWS) | No |
| **D. Shadow stack live** | Deploy everything to Azure, pointing at shadow DBs/buckets. Dashboard is reachable behind Entra only | None | Yes: deploys |
| **E. Parity** | Run the same inputs on AWS prod (normal operations) and Azure shadow, compare. Gates in §6 | None | Transcode spend (small) |
| **F. Resigner dry-run** | Azure resigner reads prod showcache, signs, runs the canary against the live CDN, writes only the shadow run log. 12 cycles (24 h) | None (reads + CDN GETs) | Yes |
| **G1. Cutover url-health** | Enable the Azure cron on prod DB; disable the EventBridge rule | Low (additive `url_health_runs`) | Yes |
| **G2. Cutover dashboard (bridge)** | Freeze window → pause App Runner → Azure dashboard on prod DB with `CLOUD_PROVIDER=aws` (still drives AWS backends) → smoke test → unfreeze | Operators switch URL | Yes |
| **G3. Cutover backends** | Freeze window → `CLOUD_PROVIDER=azure`, buckets → prod names → smoke run on a test show → unfreeze. AWS SFN/Lambdas/Batch left idle | Pipeline runs on Azure | Yes |
| **G4. Cutover resigner** | Azure resigner writes to prod with the canary guard, **alongside** EventBridge for 24 h (both write valid tokens) → disable EventBridge (not delete) | Playback path | Yes |
| **H. Soak, AWS dormant** | At least 30 clean days with rules disabled, App Runner paused, Lambdas/SFN idle, Batch min 0, and AWS Terraform state preserved | None | Yes |
| **I. Optional AWS retirement** | Separate change window after owner approval. Export state/config/log evidence; retire compute in dependency order. Do not remove S3 or its read credentials until all `s3_url` references are migrated and verified | Permanent loss of AWS rollback | Yes, separately for each destructive step |

## 6. Gates and rollbacks

| Step | Gate (all must pass) | Rollback |
|---|---|---|
| A | `az` smoke: identities can read Key Vault; Batch pool scales 0→2→0; Container Apps env healthy; GCP smoke from Azure: list shadow bucket + transcoder `list_jobs` | `terraform destroy` of the new RG (nothing depends on it) |
| B | Shadow doc counts = seeded counts; prod collections untouched (count/updatedAt before = after) | Drop the shadow DBs / buckets |
| E: lab | Same episode + resolution: golden recipe bitrate within one search step of AWS; VMAF within ±0.5 | Fix on branch; prod unaffected |
| E: transcode | Test episode, trailer, podcast: same file list and naming in the shadow manifests bucket as prod; `*_master.m3u8` / combined master diff = only timestamp folder; Mongo fields in shadow DB match prod's shape; plays in hls.js + AVPlayer + ExoPlayer from signed GCS URLs; subtitles line up | Fix on branch |
| E: failure paths | Forced failures (bad source URL, cancelled job, stop-lab) end in the same Mongo states as AWS | Fix on branch |
| F | 12/12 dry runs: canary 200/403 correct, target count matches prod, error signatures exactly match the nearest AWS run (no Azure-only errors), duration < 5 min | Keep EventBridge (it never stopped) |
| G1 | 3 consecutive hourly runs match the previous AWS results | Re-enable the EventBridge rule |
| G2 | `release_readiness.sh` passes; all pages load; one lab + one GCP run started from the Azure dashboard complete on AWS backends; startup recovery works; no double orchestrate (single `locked_by` holder). Trailer scanning remains off unless separately approved | Pause Azure app → resume App Runner (same prod DB) |
| G3 | Legacy S3-trigger audit passes; test show end-to-end on prod names: lab → transcode → finalize → combined master → sync-showcache → playable on `cdn.chaishots.in`; first 5 real runs clean | Freeze → `CLOUD_PROVIDER=aws` (AWS resources idle, untouched) → unfreeze |
| G4 | 24 h parallel: every Azure run passes the canary; `url-health` shows 0 new 403s on combined URLs; alert on resign-run staleness > 3 h is working | Disable Azure cron; EventBridge is still enabled during the parallel run |
| H | At least 30 days: no rollbacks, no playback incidents, costs as expected; two successful AWS revert drills; retirement evidence captured | Revert runbook: resume App Runner, re-enable EventBridge, `CLOUD_PROVIDER=aws` |
| I | Explicit owner approval; Azure production healthy; AWS activity zero for the agreed window; Terraform state backed up; legacy S3 trigger audit passes; S3-reference count is zero before storage/IAM removal | Restore from state/backups where possible; destructive removal is not an instant rollback |

## 7. Open decisions and gates
1. Workflows: Durable Functions (recommended) vs the existing Temporal vs folding into the dashboard.
2. Resource group: new `rg-bitrater-prod` (recommended) vs reusing scrolls.
3. Quota: file a ~512 Spot vCPU request (recommended) / start at 65 / handled by your admin.
4. Dashboard Upload Videos page: switch to Azure `chaishotsblobstoredev/sanity-dev-store` at G2, or keep S3 writes.
5. Run `scripts/cutover/audit_legacy_s3_trigger.sh` before G3. Any observed activity means the path must be ported.
6. Shadow seed set: which real shows/episodes to copy into the shadow DB.
7. Before the production dashboard is exposed, configure a stable custom hostname and Entra callback, or explicitly accept the generated Container Apps hostname and its recreation risk.

## 8. Risks ranked high → low
| # | Risk | Blast radius | Handled by |
|---|---|---|---|
| 1 | Resigner stops or mis-signs | All users; playback 403 within ≤10 h | P7: dry-run (F), canary guard, 24 h parallel (G4), staleness alert, EventBridge disabled not deleted |
| 2 | In-flight runs at cutover (AWS ARNs / job IDs in Mongo; startup recovery) | Running labs/transcodes fail or duplicate | P6 freeze window with verified zero in flight + dual-ID lookup |
| 3 | Workflow rewrite publishes wrong output | Bad episodes on the CDN | P2 shadow buckets (can't touch `chai-shots-manifests` before G3) + E parity gates |
| 4 | Lab on Azure Batch (quota 65 vs 512, job-state mapping, Spot eviction) | Slow/wrong golden recipes | Quota in A, E lab gate, AWS Batch kept idle until H |
| 5 | GCP access from Azure | Transcodes fail (loud) | A smoke gate before anything else |
| 6 | Dashboard move (single replica, self-calls, login) | Operators blocked | G2 bridge mode, `localhost` self-calls, App Runner paused not deleted |
| 7 | Shared-bucket collision (copy step deletes output prefix) | Prod run output wiped | P2: separate shadow buckets, mandatory |
| 8 | Long steps (900/600 s) | Step timeouts | Container Apps Jobs; E gates |
| 9 | Registries, logs, Terraform, url-health | Low | Mechanical |

**Security follow-ups** (separate changes with their own approval, **not** done during the migration, to keep prod still):
- Rotate the GCP SA key file stored in plaintext at the repo root (`media-cdn-poc-466009-8fc70116b15e.json`). It is gitignored and was never committed (checked 2026-09-26), so this is housekeeping, not a leak.
- Move Mongo URIs out of plaintext env vars (done on the Azure side by design).
- Restrict the Cosmos firewall (currently AllowAll 0.0.0.0–255.255.255.255) to the Azure VNet after H.

## 9. Appendix: where the AWS calls are
- **Dashboard:**
  - SFN in `push`, `gcp`, `gcp-status/[id]`, `audio/convert`, `audio/run-show`, `stop-lab`, `auto-pipeline/cancel`
  - Batch in `lib/parallelResolLab.js`, `stop-lab`, `auto-pipeline/cancel`, `show-status/active-runs`, `audio/visqol`
  - Lambda in `create-combined-master`, `quality-check/[id]`, `resync-subtitles`, `signing/resign`, `sync-showcache-episode`, `sync-showcache-trailer`
  - S3 in `uploads/*`, `lib/sourceUrl.js`
  - Secrets in `test-jas-h264`
- **Orchestrator:**
  - boto3 Batch in `search_orchestrator.py`
  - SFN in `lambda_trigger.py`
  - S3 + Secrets in `gcp_copy_s3_to_gcs.py`
  - Secrets in every `gcp_*.py`, `resign_playback_urls.py`, `strip_manifest_params.py`, `patch_gcs_cache_control.py`, `fix_subtitle_timestamp_map.py`
  - Lambda invoke in `resync_subtitles.py`
- **Workers:** S3 in `research-worker/worker.py`; Secrets in `audio-visqol-worker/worker.py`.
- **Infra:** `aws-infra/*.tf`, `deploy.sh`, `dashboard/deploy.sh`.

---

## 10. Progress log

### 2026-09-26: Phase A0 + Phase C done (branch `azure-migration`, local commits, nothing deployed)
- **A0**
  - Deployed Lambda code equals `sync-bitrater-to-org` @ `6d0508f`, so the branch starts there.
  - `scripts/guard_no_aws_deploy.sh` (wired into both `deploy.sh`) and `aws-infra/zz_branch_guard.tf` refuse AWS deploys/plans from `azure-migration*`.
  - The plan originally said "main-only", but prod deploys come from `sync-bitrater-to-org`, so the guard blocks the migration branch instead.
- **C1–C12**
  - Test harness (pytest, deps pinned to the live Lambda layer; vitest).
  - Runtime config + codemod: 118 DB literals and 4 CDN bucket literals, verified as a pure rename.
  - `secret_store`, `batch_jobs` facade (parity-tested against full searches).
  - Dashboard adapters (`workflows` / `jobs` / `invoke` / blob uploads).
  - Durable ports of the 4 live Step Functions, with a contract test against the SFN JSON.
  - `resign_guard` + jobs image, Batch worker wrappers.
  - Terraform (validated, not applied), parity/cutover tools.
  - `scripts/test_all.sh`: 88 Python + 45 dashboard tests passing.
- **freeze_check** runs against prod (read-only). On 2026-09-26 nothing was in flight.

### Deviations from the plan (and why)
- **Copy / finalize / quality-check / resync run as Durable activities on Flex Consumption, not Container Apps Jobs.**
  - Flex allows long timeouts.
  - ffmpeg is bundled from the same Lambda layer, so the binaries are identical.
  - Container Apps Jobs run the resigner, url-health, Durable watchdog and Batch record cleanup. The resigner needs separate settings because in F it reads prod `master` while the shadow app is pinned to `master_shadow`.
- **Resync → resigner is inline `RESIGN_INVOKE_MODE`** in `resync_subtitles.py`, not a separate `invoke_client.py`.
- **Batch account uses `BatchService` allocation mode.** Verify in Phase A that Spot is available in this mode. Otherwise switch to `UserSubscription`, which needs a subscription-level role for the Batch service principal (an approval item).

### Findings during implementation
- **Video and audio Lambdas share env var names with different values** (`GCS_INPUT/OUTPUT_BUCKET`).
  - On Azure they share one Function App, so audio now reads `AUDIO_GCS_BUCKET` first (unset on AWS means unchanged).
  - Without this, audio would use the video buckets, and its copy step deletes `output/<id>/` in whatever bucket it's given.
- **Existing AWS quirk, mirrored for parity:** for Audio-Video (`av_`) runs, `gcp_finalize_hls` returns `av_*` keys, but the GCP-Orchestrator ResultSelector reads `h264_/h265_master_m3u8_url`.
  - So those executions end FAILED after a successful finalize.
  - It's harmless, because the dashboard only overrides Mongo status while it's PENDING/RUNNING.
- **Dead code:** the lab's binary search never discards jobs, so the discard/terminate path in `search_orchestrator` is unused. Terminate still happens on the lost-job timeout path, which is parity-tested.
- **The GCP SA key file at the repo root was never committed** (gitignored). Rotating it is housekeeping.

### 2026-09-26: end-to-end audit (3 independent reviews) — all gaps fixed
The fixes are in the commits titled "audit fixes"; `scripts/test_all.sh` is green. `terraform plan` (read-only, scratch copy) evaluates for:
- A2: 31 resources
- full rollout, both stamps: 105 resources
- a deliberately bad config, which the guardrails reject

Main fixes:
- Durable storage roles (queue/table).
- Jobs image `.dockerignore`.
- QC per-call temp dir.
- Activity failures reach the SFN-style Catch.
- Sync invoke runs off the event loop; activity concurrency is capped.
- Batch identity client id is passed to tasks; workers run in the Batch task dir (temp disk).
- Durable status codes (202/400).
- SAS vs delegation-key expiry.
- Shadow isolation now also covers uploads and `INVOKE_PROVIDER_*`.
- Terraform:
  - Every phase switch is a variable: `dashboard_replicas`, `cloud_provider`, `resign_invoke`, `aws_key`, `resigner.*`, `url_health.*`.
  - The bridge ARNs + VTT worker are set for prod.
  - Per-stamp identities with per-secret Key Vault access, so shadow cannot read prod secrets.
  - The `deploy_apps` gate for the first apply.
  - Functions keys go to Key Vault via `publish_functions.sh`, not into Terraform state.
  - Own shadow upload storage.
  - Job timeout 3600 s.
  - Alerts are column-safe and require `alert_email` before the resigner writes.
- `seed_shadow` strips prod output URLs, so shadow only ever touches shadow output.
- **Batch pool VM:** `Standard_D4a_v4` (4 vCPU / 16 GiB, 100 GiB local temp disk for 11 GB+ sources). The `ds_v5`, `d_v5`, `ads_v5` and `as_v5` sizes are all NotAvailableForSubscription; `D4ds_v4` is the fallback. The CPU is AMD rather than AWS's Intel c5/m5, so the E-lab VMAF parity gate is what confirms results match.

### 2026-09-26: second review (2 reviewers) — all findings fixed
**Code:**
- The resign canary accepts 206 (it sends a Range request).
- Seeding strips AWS execution/job ids; shadow refuses any AWS id.
- A real resign is refused on a shadow stamp.
- Shadow requires `RESIGN_INVOKE_MODE=inprocess`.
- The full sweep runs async on Azure.
- `freeze_check` covers `Chai-Q-Orchestrator` and every Durable state.
- Batch paging keeps the service's encoding.
- ffmpeg setup can't take the app down.
- Uploads use the token's account/container.
- The snapshot hashes playback URLs (detects overwrites).
- Workers log a workdir fallback, and ViSQOL TMPDIR is on the temp disk.
- An isolation failure exits the dashboard.

**Terraform/scripts:**
- Per-stamp `apps` flag (replaces the global `deploy_apps`).
- The dashboard exists only when `dashboard_replicas = 1` (Container Apps needs max ≥ 1).
- Allowed-value validations, plus two guardrails:
  - a shadow resigner must stay dry;
  - the bridge / AWS resigner needs `aws-bridge`.
- The Function App waits for its storage roles.
- Alerts use `has`.
- The backend pins the subscription.
- Bootstrap uses `data_plane_available=false`.
- Secret scripts keep values in memory. The old temp-file approach leaked copies of 7 secret values into `$TMPDIR` during a dry run (bash 3.2); they were deleted immediately.
- `upload-token-secret` is not rotated on re-runs.
- `publish_functions.sh --keys-only` always restarts.

Read-only plans pass for A2, D, G1, G2, G3, G4 and H, and bad configs are rejected.

### 2026-09-27: migration gap review — all findings fixed locally, nothing deployed
- Dashboard creation now fails unless Entra is configured. The client secret stays in Key Vault (`entra-client-secret`) and the auth config uses `clientSecretSettingName`.
- Shadow and prod now use separate Batch accounts, pools and managed identities, preventing account-scoped submit permissions or pool secret access from crossing stamps.
- `test-jas-h264` reads its GCP key from Key Vault on Azure; it is disabled and hidden on shadow because its fixed test bucket is not isolated.
- `freeze_check.py --require-azure` fails closed and accepts explicit multi-stamp Durable/Batch target lists.
- Monitoring now covers Function exceptions, stuck Durable runs, Batch task/allocation failures, dashboard replica loss and scheduled-job failures. `/api/health?deep=1` checks Mongo and pipeline configuration.
- Every scheduled job receives the full shadow isolation environment and checks it before work.
- Daily cleanup deletes completed Batch task records after 7 days.
- App images must be immutable ACR digest references; the Batch node image version is a required exact value rather than `latest`.
- Verification after the fixes: 105 Python tests and 55 dashboard tests pass, the dashboard production build passes, and `terraform validate` passes.

### 2026-09-27: third review (external tool) — fixes checked, 3 corrections
The external tool fixed 8 findings. Three problems in those fixes were corrected:
1. Job-specific shadow isolation, so the Phase F / G1 prod-master reads work.
2. The Entra secret setting name.
3. Job names over the 32-character limit.

Details and verification are in `AZURE-MIGRATION-HANDOFF.md` §7.

### 2026-09-27: Phase A1 done (approved)
`azure-infra/bootstrap` applied: `rg-bitrater-tfstate`, storage `bitratertfstate` (AAD only, versioning on), container `tfstate`, and a Storage Blob Data Contributor role for the deployer. Gate passed: container reachable with `--auth-mode login`, and `terraform init` of `azure-infra` connected to the backend (no state written yet). The bootstrap state is local at `azure-infra/bootstrap/terraform.tfstate` (gitignored); keep that file.

### 2026-09-27: A-pre + A2 done (approved)
**A-pre:** `Microsoft.Batch` registered.

**A2:** `terraform apply` created 33 resources: RG `rg-bitrater-prod`, Log Analytics, App Insights, ACR `bitraterprodacr`, Key Vault `kv-bitrater-prod` (RBAC, purge protection), Container Apps env `cae-bitrater`, shadow identities, Flex Function App `fa-bitrater-shadow` (Running, no code), Batch account `bitraterbatchshadow` + pool `chai-q-spot-shadow` (steady, 0 nodes, `standard_d4a_v4`), Batch jobs, and shadow upload storage.

Gates:
- A re-plan first showed an endless diff: Azure auto-adds the Consumption workload profile. Fixed by declaring it in `foundation.tf`; the re-plan is now "No changes".
- `batch_image_version = 22.04.2026082801` in `azure-infra/terraform.tfvars` (non-secret).

A3 read-only checks:
- The image is listed as DockerCompatible (node agent `batch.node.ubuntu 22.04`, Batch support ends 2027-05-31, "unverified").
- The account quota is only **6 low-priority cores** (one D4 node), so an increase request is needed.

### 2026-09-27: non-prod batch (owner: "do all steps not related to prod")
**A4 ✓** Imported `chai-q-worker:ecr-20260924` and `audio-visqol-worker:ecr-20260601` into ACR by digest. The ACR digests equal ECR (`398058…`, `0e9e19…`).

**A5 (partly done)**
- ✓ `copy_secrets_sm_to_kv.sh --apply` wrote 7 secrets: gcp-credentials, media-cdn-signing-key, mongo-uri, mongo-uri-shadow, subtitle-mongo-uri, vtt-worker-secret, upload-token-secret. Every value was hash-checked against its source. No temp files.
- ⏸ The read-only S3 IAM user is **held**: it's a change in the prod AWS account, so it needs explicit approval.

**A3**
- Image check ✓: `ubuntu-hpc 2204` @ `22.04.2026082801` is DockerCompatible.
- ⏸ The quota ticket is held until a support contact name/email is given. The shadow account is at 6 low-priority cores (1 node).

**A6 ✓ smoke** (shadow pool, one Spot `D4a_v4`, autoscale 0→1→0 worked). From inside the prod worker image:
- the task dir is mounted and on the temp disk (98 GB, 93 GB free);
- the container layer has only 17 GB free;
- IMDS returns a Key Vault token for the pool identity.
- Lesson: task files vanish when the node scales down, so queue a keep-alive task before reading output.
- Also confirmed in the real worker mode (`workingDirectory=containerImageDefault`, starting in `/var/task`): the task dir is mounted on the temp disk, so `azure_entry.prepare_workdir` works.

**D1 ✓ images** built with `az acr build` from minimal contexts (no `.env` files), pinned in `azure-infra/terraform.tfvars`: dashboard `a0cc1d…`, jobs `7b61d1…`, `chai-q-worker-azure` `e0376d…`, `audio-visqol-azure` `565430…`.

**D2 ✓ Functions published** to `fa-bitrater-shadow`. All 8 functions are indexed, and the keys are stored in Key Vault (`durable-task-key-shadow`, `functions-invoke-key-shadow`). Probe: `/api/invoke/<unknown>` gives 404 from our code with the key and 401 without. Two deploy bugs were fixed:
1. `azure-functions-durable 1.7.0` needs `requests>=2.33`. `requirements-azure.txt` now pins `requests>=2.33,<3`, and `build_functions.sh` lets Azure pins override the Lambda pins (the Lambda layer keeps 2.32.5). The test venv was already on 2.34.2.
2. Flex injected an `AzureWebJobsStorage` connection string with an **empty AccountKey**, which overrides the identity settings (host startup 403s). `stamps.tf` now sets `AzureWebJobsStorage = ""` (applied: 1 change to the shadow Function App). After that the host logs "Host started" / "Job host started".

**Pending apply:** the pinned image digests change one shadow Function App setting (the worker image). They'll be applied together with `apps=true`.

### 2026-09-27: end-to-end readiness review (4th pass) — fixed
**Confirmed and fixed:**
1. Upcoming D3 needs 5 secrets that don't exist yet (`aws-s3-readonly-{access-key-id,secret-access-key,json}`, `gcp-credentials-shadow`, `entra-client-secret`). A plan-time check now lists missing names (names-only data source) instead of failing mid-apply. So **A5 S3 user, B1 and the Entra app must come before D3.**
2. Every Batch task would have failed without the S3 key secret. `azure_entry.py` now loads it best-effort; only S3-source runs need it.
3. **Next 14 never runs `instrumentation.ts`** (`experimental.instrumentationHook` is off — also at AWS prod `6d0508f`). So the dashboard startup isolation check, and in prod the orphan-pipeline recovery and the trailer scanner, never run today. The shadow check now lives in `lib/mongodb.js` (every data access) and `/api/health` (503 when misconfigured). **Enabling the hook is a prod behaviour change and is left to the owner.**
4. The Batch allocation alert could never fire. It now matches `PoolResizeCompleteEvent` with `resultCode_s != Success`; checked against the real quota event.
5. Per-stamp autoscale limit (`batch_max_spot_nodes = {shadow = 1, prod = 16}`) matches the 6-core shadow quota.
6. The resigner alerts tolerate a missing log table (`union isfuzzy=true`); the Functions exception alert fires only above 5 in 15 minutes.
7. Seeding strips `gcs_master_url`, `cdn_ts`, `output_uri`, `gcs_input_uri` too.
8. Dashboard and worker images were rebuilt and re-pinned (`bitrater-dashboard@sha256:fd56d8…`, `chai-q-worker-azure@sha256:d932e0…`, `audio-visqol-azure@sha256:de88b3…`) and applied along with the pool limit.

**Regression I caused and fixed:** I tried `ignore_changes` on `AzureWebJobsStorage` to silence a plan diff. On the next settings update the provider re-injected the empty-key connection string and the host stopped (503). Reverted and re-applied; the host is healthy again (probe 404 with the key). A test now forbids this. **Expected permanently:** every plan shows `+ "AzureWebJobsStorage" = ""` on the shadow Function App.

**Also noted:**
- The platform-injected `DEPLOYMENT_STORAGE_CONNECTION_STRING` also has an empty AccountKey. It's harmless (deployment uses the identity), but watch it.
- Shadow identities also read prod `media-cdn-signing-key` and `subtitle-mongo-uri`, and `mongo-uri-shadow` is the same cluster credential. Shadow isolation is enforced by code checks + tripwire, not by credentials.
- Shadow QC/ViSQOL/playback need the shadow manifests/audio buckets to be public-read (B1 decision).

### 2026-10-06: readiness review (3 reviewers) — all code findings fixed locally, nothing deployed

Tests: 131 Python + 64 dashboard pass, the build passes (instrumentation hook compiled), and `terraform validate`/`fmt` pass. Read-only plan against live state: the 2 empty shadow Batch jobs get replaced (new `STAMP_DB_LAB`), and the Function App settings change in place (`COPY_MAX_WORKERS`). The pool is unchanged.

1. **Batch node disk.** Task dirs were kept 7 days on the shared temp disk, and worker.py never deletes 11 GB+ sources. Now `retentionTime` is 1 h in both submitters, and `azure_entry.py` runs the worker as a child process, passes its exit code through (signals as 128+N), forwards SIGTERM, and cleans the task dir afterwards.
2. **Worker isolation.** The Batch job's `common_environment_properties.STAMP_DB_LAB` (Terraform) is enforced by `azure_entry.check_isolation`, so isolation no longer depends on the submitter's env passthrough. Also, `batch_jobs.py` refuses AWS Batch calls on shadow (same as `cloud/ids.js`).
3. **Copy-step memory.** The real peak is about 2 × PART_SIZE × workers. `COPY_MAX_WORKERS` is an env var (default 16, so AWS is unchanged); Azure sets 5. A test guards 3 concurrent copies against the instance memory.
4. **Async invoke failures.** These were silent on Azure. `invoke.js` now throws on any failed invocation (401/403/404/5xx, any failed async start), like the Lambda SDK. Only a sync 500 with a Lambda-style body is returned as `FunctionError`.
5. **Durable 404.** It now throws, like `ExecutionDoesNotExist`, instead of ABORTED, which had made `gcp-status` write FAILED and `push` start duplicates.
6. **Alerts.**
   - `RESIGN_PARTIAL` replaces `RESIGN_OK` when some episodes fail.
   - `run_job.py` prints `<JOB>_ERROR` for every failure, and the alert matches every marker.
   - `function_exceptions` is per stamp (dimension `cloud/roleName`; shadow at severity 3).
   - New alerts: a dashboard availability web test on the auth-exempt shallow `/api/health` (deep still needs a signed-in principal), and a dashboard restart-loop alert.
7. **Dashboard access.** `dashboard_allowed_principals` (Easy Auth `allowedPrincipals`) is required before a dashboard is created.
8. **Capacity.**
   - `batch_max_spot_nodes.prod = 128`.
   - The effective ceiling is capped by `batch_spot_core_quota` (granted cores / 4), so requests above quota never fail allocation.
   - G3 is refused below 128 nodes unless `accept_reduced_lab_capacity`.
   - `batch_pool_overrides` lets the image/VM change per stamp (a replacement can't hit both pools at once).
9. **Revert.**
   - `scripts/cutover/revert_to_aws.sh` is a break-glass path without Terraform, with an AWS capacity preflight; the dry run was checked against live AWS/Azure (read-only).
   - `freeze_check` now also counts running Container Apps job executions (`AZURE_SUBSCRIPTION_ID` is required with `--require-azure`).
   - `publish_functions.sh` waits for the keys, writes Key Vault only on change, restarts the dashboard revision when a key changed, and refuses prod without `FREEZE_OK=1`.
   - The G2 runbook pauses App Runner before the Azure dashboard starts.
10. **Orphaned pipelines.** `instrumentationHook` is on, with opt-in flags. Azure runs startup recovery + a 5-min stale-lock sweep. The trailer scanner is off on both stamps (AWS never ran it).

**Still open (not code):** AWS EC2 launch restriction (account 107647021172) and 30 orphaned RUNNABLE jobs; quota tickets; IAM users; Entra app + allowed principals; GCP shadow setup; parity gates. See handoff §11–§12.

### 2026-10-06: Stage 1 (shadow) — owner: "do all the steps end to end"
1. `scripts/test_all.sh`: ALL TESTS PASSED (131 Python, 64 dashboard).
2. Shadow apply: replaced the shadow Batch jobs (`STAMP_DB_LAB`) and added `COPY_MAX_WORKERS=5`. The first apply hit `409 JobBeingDeleted` (Batch deletes asynchronously); after the deletion finished, the re-plan (2 add, 1 change) applied cleanly. `publish_functions.sh shadow`: 8 functions, host Running, keys unchanged.
3. **B1 GCP done** (owner ran the IAM commands):
   - Buckets `chai-q-az-shadow-{input,output,manifests,audio}`: asia-south1, uniform access, **public access prevention enforced**, 30-day delete lifecycle.
   - SA `chai-q-az-shadow@` has objectAdmin on those 4 buckets only, plus project `roles/transcoder.admin`. GCP has no per-bucket Transcoder role; the Transcoder agent `service-623432890759@gcp-sa-transcoder` can write prod buckets, so isolation against a shadow-submitted job writing prod relies on the code checks + tripwire.
   - The Transcoder agent has objectAdmin on the 4 shadow buckets.
   - Gate passed via read-only `testPermissions`: no `objects.create` on any of the 5 prod buckets; `create` allowed on all 4 shadow buckets.
   - Key `49c61b9d…` stored as KV `gcp-credentials-shadow`; the local file was shredded. The first key `e224c8ea…` was deleted: a brand-new key returns `Invalid JWT Signature` for about 10–60 s, so the token fetch now retries.
   - Decision pending: public-read on the manifests bucket. Allowing it needs PAP removed first.
4. Batch quota: `bitraterbatchprod` doesn't exist until G1, so the prod ticket is deferred (contact recorded). Shadow is at 6 cores, enough for Stage 1.
5. Blocked by the Claude Code auto-mode classifier, so the owner must run these or allow them: the prod Mongo read (S3 bucket audit), creating IAM in the prod AWS account, and seeding.
7. **A5 S3 user done** (owner ran it): the read-only audit of source URLs found S3 `sanity-dev-store` 4816, Azure Blob 37, S3 `sanity-prod-store` 2 (both ap-south-2). IAM user `chai-q-azure-s3-readonly`: inline policy `s3-source-readonly` (GetObject + ListBucket/GetBucketLocation on those 2 buckets). simulate-principal-policy: Get allowed, Put/Delete implicitDeny. Key `AKIARSECDGB2HVPJ7IQU` → KV `aws-s3-readonly-{access-key-id,secret-access-key,json}`.
8. **Entra done:** app reg `bitrater-dashboard-shadow` (appId `d7e4b4de-eb13-4307-9259-21f25fc57278`, single tenant, ID tokens, shadow callback URI) + service principal. Client secret (1 year, expires about 2027-10-06) piped straight to KV `entra-client-secret`. tfvars: `entra_client_id`, `alert_email = rithikaabba@chaishots.in`, `dashboard_allowed_principals.identities = [39a6a5f6-…]` (owner only). All 5 D3 secrets present.
9. **Public-read shadow manifests:** owner said yes. PAP removed and `allUsers:objectViewer` on `chai-q-az-shadow-manifests` only.
10. **B3 needs no change:** prodcluster already has diagnostic setting `documentdb-requests-to-log-analytics` → `log-scrolls-prod` (rg-scrolls-prod) with `vCoreMongoRequests`. **Tripwire bug fixed:** the table has no `AppName` column; the appName is the first element of `UserAgent`. `shadow_tripwire.kql` now filters `UserAgent has "bitrater-azure-shadow"`. Verified: tripwire = 0 rows; the control (the audit's appName) matched 11 read-only ops.
11. **B2 seed done** (owner ran it): showcache 7, podcast_showcache 1, video_episodes 44, video_vmaf_research 699, audio_episodes 8. GATE B2 PASSED (prod snapshot unchanged). Cosmos logs for `bitrater-seed-shadow`: writes only to `chai_q_lab_shadow` (751 Update) and `master_shadow` (8); `master`/`chai_q_lab` reads only.
12. **D1 redo:** the images in ACR were built 2026-09-26, before the Oct-6 code fixes (dashboard instrumentation/next.config, `run_job.py`, `azure_entry.py`). All 4 were rebuilt with `az acr build` from minimal contexts (tag `20261006`, no `.env`), and tfvars was re-pinned: dashboard `f54e6e69…`, jobs `381ccf0a…`, lab `24a7a566…`, visqol `21a56618…`. Note: `az acr build -f` is resolved relative to the CWD, so run it from inside the context.
13. **D3 `apps=true` applied (shadow)**, with two live issues:
    - **Container Apps env `cae-bitrater` was suspended by Azure** (`ManagedClusterSuspended … unknown reasons`, after sitting empty since 2026-09-26). The jobs went to Failed and the dashboard hung. Fix (owner-approved): `terraform apply -replace=azurerm_container_app_environment.main` (8 add, 7 destroy, all shadow). New domain `calmtree-35a4902d`; Entra redirect URI updated.
    - **Alert creation failed:** `union isfuzzy=true` with no existing table gives a 400. All 3 Container Apps log unions in `monitoring.tf` now start with an empty `datatable(TimeGenerated: datetime)[]` operand (verified against the workspace; infra tests pass).
    - Result: the dashboard is Running (`✓ Ready`, no `[startup]` error, so isolation passed). Easy Auth: browser 302 → login.microsoftonline.com, API 401, `/api/health` excluded, deep health 401 unauthenticated. Jobs: resigner/urlhealth Manual, bcleanup/watchdog scheduled. `publish_functions.sh shadow --keys-only` done. Tripwire 0.
6. Storage: owner chose to keep the existing accounts (sources stay in `chaishotsblobstoredev/sanity-dev-store`, GCS stays in GCS). Other projects' storage accounts are not consolidated (other teams own them).

### 2026-10-09: status check (read-only) + gate F result
**Stage 1 shadow is live:**
- Dashboard: 1 replica, healthy; unauthenticated requests get 401.
- Scheduled jobs and alerts are in place.
- All D3 secrets are present.
- Seed done; tripwire 0.

**Phase E (parity) has NOT started:** 0 Durable instances, 0 Batch tasks, no new VMAF rows (still the 699 seeded).

**Phase F (resigner dry run) has effectively PASSED.** 37 shadow dry runs since 2026-10-06 12:59:
- canary 37/37 OK;
- target 3979, would_update 3924, matching the prod AWS runs (updated 3924).

The gate script required 0 errors, but **prod AWS has the same 55 errors on every run**. `resign_dryrun_compare.py` now requires the *same* errors as the nearest prod run, and a test covers this. Result: 23/24 PASS. The one miss (3951 vs 3955 at 2026-10-09 08:00) is the catalog growing between the two runs; the next runs show 3979.

**Prod data issue (pre-existing, not migration):**
- 55 `master.showcache` episodes have a combined URL but **no `id`**: `jaane-jigars-1` 26, `the-audition-show` 16, `silently-yours-1` 10, `the-audition-show-part-1/2/3` 1 each.
- Neither resigner can address them, so all 55 tokens are **expired**.
- Owner decision needed to fix the data.

**AWS prod lab is broken (pre-existing):** 30 `ChaiQSearch-*` jobs RUNNABLE since 2026-10-02. The compute env is VALID with desired 4 vCPU, but EC2 can't launch (Fleet Requests quota). The AWS research lab doesn't run today, which also weakens the lab part of the revert path.

**Storage consolidation:** owner chose to keep the existing accounts.

**Next:**
1. Phase E parity runs (shadow; GCP transcode spend). Shadow Batch has only 6 cores = 1 node, so the lab is slow but works.
2. G1 prod stamp: needs the prod Batch account + quota ticket (~512 cores).
3. G2: aws-bridge IAM user + freeze + pause App Runner.
4. G3 + 2 revert drills.
5. G4 resigner.
6. H 30-day soak.

### Original Phase A checklist (completed; kept for reference)

1. **A1**: `terraform apply` in `azure-infra/bootstrap` (state storage + your blob-data role on it).
2. **Pre-step**: `az provider register -n Microsoft.Batch` (subscription-level; currently NotRegistered).
3. **A2**: select an exact supported `batch_image_version`, then `terraform apply` in `azure-infra` with `apps=false`, shadow stamp only.
   - Creates: RG, logs, ACR, Key Vault, Container Apps env, identities, Flex app (no code), the isolated shadow Batch account/pool (0 nodes), Batch jobs, shadow upload storage.
   - No dashboard or jobs yet.
4. **A3**: Batch **account** low-priority (Spot) core quota increase. In BatchService mode the quota is per account: keep shadow small and request production capacity separately.
   - Confirm the pool image with `az batch pool supported-images list`.
5. **A4**: `az acr import` of the two ECR worker images by digest.
6. **A5**:
   - `copy_secrets_sm_to_kv.sh --apply`.
   - Create a read-only S3 IAM user, then `--aws-key aws-s3-readonly --apply`.
7. **A6**: smoke tests.

Then:
- **B1**: shadow GCS buckets + shadow SA, then `--gcp-shadow-key`.
- **B2**: `seed_shadow.py scripts/parity/seedset.json --apply` (list agreed 2026-09-26).
- **D**:
  1. Push all images and set `var.images` to immutable `repository@sha256:<digest>` references.
  2. `publish_functions.sh shadow`.
  3. Create the Entra registration/client secret, store the secret in Key Vault, set `entra_client_id` and `alert_email`, then set `stamps.shadow.apps = true` and apply.
  4. `publish_functions.sh shadow --keys-only`: restarts the app so the new Key Vault grants take effect.
     Run this after **every** apply that adds or changes a stamp's grants.
- **G1**: enable prod with `apps` staged the same way (`enabled` → publish → `apps=true`).
  - `dashboard_replicas = 0` means no prod dashboard; `aws_key = "aws-s3-readonly"`.
  - Then turn on url-health.
- **G2**:
  1. Create the aws-bridge IAM user → `--aws-key aws-bridge --apply`.
  2. Set prod `aws_key = "aws-bridge"`, `dashboard_replicas = 1`, `cloud_provider = "aws"`.
  - The bridge user needs everything the App Runner role had:
    - SFN Start/Describe/Stop on the 5 machines
    - Batch Submit/List/Describe/Terminate on the unversioned job defs `chai-q-worker` and `audio-visqol` (not a pinned revision — see the earlier AccessDenied)
    - `lambda:InvokeFunction` on the 4 functions
    - S3 Get on source buckets
    - S3 multipart Put on `sanity-dev-store` while `upload_provider = "s3"`
- **G3 / G4 / H**: one-line `var.stamps` edits (G3 `cloud_provider=azure`; G4 `resign_invoke=inprocess` + resigner writes; H `aws_key=aws-s3-readonly`). Each is followed by `publish_functions.sh prod --keys-only`.
- **Live checks** (A6/D):
  - Batch Spot allocation in BatchService mode + the account low-priority quota.
  - `ubuntu-hpc 2204` listed as container-capable.
  - `AZ_BATCH_TASK_WORKING_DIR` is mounted into containers.
  - `--rm` keeps the exit code.
  - OData `state ne 'completed'` is accepted.
  - Role assignments on a secret need the secret to exist (they are created only after the copy).
  - The `ContainerAppConsoleLogs_CL` table exists before the alerts are created.
  - The CLI default subscription is `ff1dad43…`.
- **Entra login**: mandatory before any dashboard is created. Use an app registration with ID tokens, redirect `https://<fqdn>/.auth/login/aad/callback`, `entra_client_id`, and a Key Vault-backed client secret.
