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
- AWS resources are **paused or disabled, never deleted**, until 30 days of clean running on Azure.
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

**P8b. AWS is kept permanently as a revert path.**
- Nothing in AWS is ever deleted.
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
- The legacy `Chai-Q-Orchestrator` + `s3-trigger` are not ported (confirm unused, §7).

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
| **H. Soak, AWS dormant** | 30 days clean → revoke the temporary G2 bridge IAM key. **AWS is never removed** (user decision 2026-09-26): rules disabled, App Runner paused, Lambdas/SFN idle, Batch min 0, TF state kept, so the revert path always exists | None | Yes |

## 6. Gates and rollbacks

| Step | Gate (all must pass) | Rollback |
|---|---|---|
| A | `az` smoke: identities can read Key Vault; Batch pool scales 0→2→0; Container Apps env healthy; GCP smoke from Azure: list shadow bucket + transcoder `list_jobs` | `terraform destroy` of the new RG (nothing depends on it) |
| B | Shadow doc counts = seeded counts; prod collections untouched (count/updatedAt before = after) | Drop the shadow DBs / buckets |
| E: lab | Same episode + resolution: golden recipe bitrate within one search step of AWS; VMAF within ±0.5 | Fix on branch; prod unaffected |
| E: transcode | Test episode, trailer, podcast: same file list and naming in the shadow manifests bucket as prod; `*_master.m3u8` / combined master diff = only timestamp folder; Mongo fields in shadow DB match prod's shape; plays in hls.js + AVPlayer + ExoPlayer from signed GCS URLs; subtitles line up | Fix on branch |
| E: failure paths | Forced failures (bad source URL, cancelled job, stop-lab) end in the same Mongo states as AWS | Fix on branch |
| F | 12/12 dry runs: canary 200/403 correct, target count = prod `playback_resign_runs.updated_count` ±0, 0 errors, duration < 5 min | Keep EventBridge (it never stopped) |
| G1 | 3 consecutive hourly runs match the previous AWS results | Re-enable the EventBridge rule |
| G2 | All pages load; one lab + one GCP run started from the Azure dashboard complete on AWS backends; trailer scanner ticks; no double orchestrate (single `locked_by` holder) | Pause Azure app → resume App Runner (same prod DB) |
| G3 | Test show end-to-end on prod names: lab → transcode → finalize → combined master → sync-showcache → playable on `cdn.chaishots.in`; first 5 real runs clean | Freeze → `CLOUD_PROVIDER=aws` (AWS resources idle, untouched) → unfreeze |
| G4 | 24 h parallel: every Azure run passes the canary; `url-health` shows 0 new 403s on combined URLs; alert on resign-run staleness > 3 h is working | Disable Azure cron; EventBridge is still enabled during the parallel run |
| H | 30 days: no rollbacks, no playback incidents, costs as expected | Revert runbook (below): resume App Runner, re-enable EventBridge, `CLOUD_PROVIDER=aws`. Always available |

## 7. Decisions needed before Phase A
1. Workflows: Durable Functions (recommended) vs the existing Temporal vs folding into the dashboard.
2. Resource group: new `rg-bitrater-prod` (recommended) vs reusing scrolls.
3. Quota: file a ~512 Spot vCPU request (recommended) / start at 65 / handled by your admin.
4. Dashboard Upload Videos page: switch to Azure `chaishotsblobstoredev/sanity-dev-store` at G2, or keep S3 writes.
5. Confirm the legacy `Chai-Q-Orchestrator` + `chai-q-s3-trigger` are unused (then they are not ported).
6. Shadow seed set: which real shows/episodes to copy into the shadow DB.

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

### Next: Phase A (every step needs approval)
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
