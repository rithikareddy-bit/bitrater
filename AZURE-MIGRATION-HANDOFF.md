# bitrater: AWS → Azure migration handoff

**Last updated:** 2026-09-27.
**Phase complete:** design, code and verification. Nothing is deployed.
**Next phase:** A (Azure foundations). Every step needs the owner's approval.

This file is self-contained. A new person or chat should be able to continue from it without the chat history.
- `AZURE-MIGRATION-PLAN.md` is the **contract**: the §0 zero-risk rules, the phases, and the gates. It also holds the running progress log (§10).
- This handoff explains **what exists, why, how it was verified, and exactly what to do next.**

---

## 1. TL;DR

- **Goal.** Move bitrater's **AWS compute** to Azure. Covered: App Runner dashboard, Step Functions, Lambdas, AWS Batch, EventBridge, ECR and Secrets Manager.
- **Two hard requirements:**
  1. **Zero risk to prod.**
  2. **AWS is kept forever as a revert path.**
- **Not moving:** GCP (Transcoder, GCS, Media CDN `cdn.chaishots.in`, Cloud Run vtt-worker). MongoDB, which is already on Azure (Cosmos `prodcluster`).
- **S3 data is not migrated** (owner decision). Code reads `s3_url` from S3 or Azure Blob, whichever the record says.
- **Status:**
  - All code for both clouds is written and tested: 114 Python tests, 55 dashboard tests, and the dashboard builds.
  - Terraform is written and plans cleanly for every phase.
  - Three first-pass audits and two second-pass reviews ran; all findings are fixed.
  - **Nothing has been deployed or changed in any cloud.**
  - **Nothing is committed** (owner's instruction).
- **Next:** Phase A, which creates the Azure foundation. See §11.

---

## 2. Rules for anyone continuing (non-negotiable)

1. **Zero risk to prod** (`AZURE-MIGRATION-PLAN.md` §0):
   - Reading prod is fine.
   - Any write needs **explicit per-step approval from the owner**. That covers prod Mongo, prod GCS, Media CDN, AWS resources, DNS, the Cosmos firewall and secrets.
   - Cost-incurring Azure applies and quota requests need approval too.
2. **Do not git commit or push.** The owner wants all changes left uncommitted in the working tree. The owner commits when they choose. Earlier commits were deliberately undone.
3. **Never redeploy AWS from this branch.**
   - `deploy.sh`, `dashboard/deploy.sh` and `aws-infra` Terraform refuse to run on `azure-migration*`.
   - AWS keeps running commit `6d0508f`, which is the revert target.
   - AWS hotfixes go through `sync-bitrater-to-org` (the branch prod deploys from) and are then ported here.
4. **Never delete anything in AWS.** At cutover: disable EventBridge rules, pause App Runner, leave the Lambdas and SFN idle, keep Batch at min 0. Keep the Terraform state.
5. **Cutovers happen only in a verified freeze window.** Run `scripts/cutover/freeze_check.py`; everything must be 0 in flight.
6. **Secrets:**
   - Never print them or write them to disk.
   - The scripts pass values on stdin. macOS bash 3.2 does **not** run EXIT traps in pipeline subshells. An early temp-file version leaked 7 secret copies into `$TMPDIR` during a dry run; they were securely deleted.
   - Rotate secrets in **both** Key Vault and Secrets Manager (AWS is the revert path).
7. **The shadow ("test copy") must never touch prod data.** The code and Terraform enforce this, and tests check it. Don't weaken the checks.

---

## 3. Environment facts (verified 2026-09-26)

| Thing | Value |
|---|---|
| Repo | `/Users/cstech-05/Desktop/bitrater`, branch `azure-migration` at `6d0508f` (= `sync-bitrater-to-org`, the commit AWS runs) plus uncommitted changes |
| AWS | account `107647021172`, region `us-east-1` (CLI default is `ap-south-1`, so pass `--region us-east-1`); Terraform in `aws-infra/` (local state, 102 entries, no drift) |
| Live Step Functions | `Chai-Q-Orchestrator-H264`, `-H265`, `GCP-Orchestrator`, `Audio-Orchestrator`, `Audio-Show-Batch` (+ legacy `Chai-Q-Orchestrator`, 0 executions, not ported) |
| EventBridge | `chai-q-resign-playback-urls` `rate(2 hours)` ENABLED (tokens have a 10 h TTL); `chai-q-url-health-checker` `rate(1 hour)` |
| Worker images (ECR digests prod runs) | `chai-q-worker@sha256:398058677769f1815668b36b0056642bf40355c0421c34fb4bdec9363238a430` (pushed 2026-09-24); `audio-visqol-worker@sha256:0e9e1972f0bb80dca9342f0d0c99a7385177f149d7a276a8207f644c303c51d9` |
| GCP | project `media-cdn-poc-466009`, `asia-south1`. The gcloud login on this laptop has **expired** (`! gcloud auth login` is needed for Phase B) |
| Azure | subscription `ff1dad43-0464-4958-8179-94669f96c927` ("Azure subscription 1"), tenant `krishnachaishots`, user `rithika_dev@krishnachaishots.onmicrosoft.com` (Owner). `Microsoft.Batch` provider is **NotRegistered** |
| MongoDB | Cosmos DB for MongoDB vCore `prodcluster` (M60, central India), public access with firewall AllowAll. DBs: `master`, `chai_q_lab`; subtitles in a second cluster (`gld2sqs`) |
| Source videos | S3 `sanity-dev-store` (ap-south-2, 3.86 TB) is also copied by another team to Azure `chaishotsblobstoredev/sanity-dev-store` (rg-scrolls-dev, public read, CORS PUT from `*`). 225 of 259 shows still point at S3; only the two test shows point at Azure |
| DNS | `chaishots.in` is on **Route 53** (an Azure DNS zone exists but isn't authoritative). Not in scope |
| Batch VM | `Standard_D4a_v4` (4 vCPU, 16 GiB, 100 GiB temp disk), listed by `az batch location list-skus` for centralindia |
| New Azure names (all free) | `rg-bitrater-prod`, `rg-bitrater-tfstate`, `bitratertfstate`, `bitraterprodacr`, `kv-bitrater-prod`, `bitraterbatch{shadow,prod}`, `bitraterfunc{shadow,prod}`, `bitratershadowup`, `cae-bitrater`, `fa-bitrater-<stamp>`, `ca-bitrater-dash-<stamp>`, `acaj-bitrater-<stamp>-{resigner,urlhealth,bcleanup,watchdog} (Container Apps job names ≤ 32 chars)` |

---

## 4. Decisions (owner-confirmed 2026-09-26)

- **Scope:** only the AWS parts move. GCP stays.
- **S3:** not migrated. The other team already copied it (61 objects missing, left as they are).
- **Workflows:** Azure **Durable Functions** (Python, Flex Consumption).
- **Resource group:** new `rg-bitrater-prod` with its own ACR and Key Vault, in Central India.
- **Batch capacity:** quota is per Batch account. Keep shadow small; request about 512 Spot vCPU for the production account.
- **Uploads:** the dashboard upload page moves to Azure Blob (flag `UPLOAD_PROVIDER`), at the prod bridge or later. It needs the storage owner's approval for the role.
- **AWS:** never decommissioned. It stays dormant and revert-ready.
- **Commits:** none. Changes stay uncommitted.
- **Test seed set:** see §10.

---

## 5. Target architecture

| AWS today | Azure |
|---|---|
| App Runner dashboard | Container App `ca-bitrater-dash-<stamp>`, exactly 1 replica (in-process orchestrator: never 0 while live, never 2); Terraform refuses to create it until Entra login and its Key Vault-backed client secret are configured |
| 5 Step Functions | Durable orchestrators in `azure-functions/`: `lab_search`, `gcp_transcode`, `audio_transcode`, `audio_show_batch` (+ `audio_episode_tolerant`, `invoke_async`) |
| Lambdas | One Durable activity `run_handler` that runs the **unchanged** `orchestrator/<module>.py` `handler(event, None)`; `POST /api/invoke/{fn}` for the dashboard's direct invokes |
| AWS Batch (lab + ViSQOL) | Per-stamp Azure Batch accounts `bitraterbatch<stamp>`, pools `chai-q-spot-<stamp>` and identities (autoscale from 0), with long-lived jobs `chai-q-lab-<stamp>` / `audio-visqol-<stamp>` |
| EventBridge crons | Container Apps Jobs `acaj-bitrater-<stamp>-resigner` (0 */2) and `-urlhealth` (0 *) |
| ECR | ACR `bitraterprodacr` (worker bases imported **by digest**, so they're byte-identical) |
| Secrets Manager | Key Vault `kv-bitrater-prod` (RBAC per secret, per identity) |

**Stamps.** The same code is deployed twice, as `shadow` (the isolated test copy) and `prod`. Every phase switch is a field in `var.stamps` in `azure-infra/variables.tf`:
- `enabled`
- `apps`
- `dashboard_replicas`
- `cloud_provider`
- `upload_provider`
- `resign_invoke`
- `aws_key`
- `resigner.{enabled,dry_run,db_master}`
- `url_health.{enabled,db_master}`

So each cutover or rollback is a one-line edit plus `terraform apply` plus `publish_functions.sh <stamp> --keys-only`.

**Shadow isolation:**

| Resource | Shadow value |
|---|---|
| DBs | `master_shadow`, `chai_q_lab_shadow` |
| GCS buckets | `chai-q-az-shadow-{input,output,manifests,audio}` |
| GCP service account | separate SA `chai-q-az-shadow@` (cannot write prod buckets) |
| CDN | `SKIP_CDN_INVALIDATION=1` |
| VTT, dev-sync, trailer scanner | off |
| Uploads | `bitratershadowup/uploads-shadow` |
| Identities | per-stamp, reading only shadow secrets |
| Mongo | `appName=bitrater-azure-shadow` (tripwire) |
| Startup check | every entrypoint refuses to start if any name points at prod |

---

## 6. What was built: file map (all uncommitted)

### Safety and config
| File | Purpose |
|---|---|
| `scripts/guard_no_aws_deploy.sh` (sourced by `deploy.sh`, `dashboard/deploy.sh`) and `aws-infra/zz_branch_guard.tf` | Block AWS deploys/plans from `azure-migration*` |
| `orchestrator/runtime_config.py` | DB/bucket names with defaults equal to the old literals; `assert_isolation()` for shadow (DBs, buckets incl. `AUDIO_GCS_BUCKET`, `SKIP_CDN_INVALIDATION`, `RESIGN_INVOKE_MODE=inprocess`) |
| `dashboard/lib/config.js` | Same for the dashboard, plus flags (`CLOUD_PROVIDER`, `UPLOAD_PROVIDER`, `VTT_ENABLED`, `UPLOAD_DEV_SYNC_ENABLED`, `invokeProvider(fn)`), `assertIsolation()` called from `instrumentation.ts` (exits on failure) |
| `scripts/codemods/*` | Replaced 118 hard-coded DB names and 4 CDN bucket literals; `verify_equivalence.py` proved it was a pure rename (it compares two commits, so re-running it needs a temporary commit; ask the owner) |

### Orchestrator (Python, runs on both clouds)
| File | Purpose |
|---|---|
| `secret_store.py` | `kv:<name>` → Key Vault, anything else → the same Secrets Manager call as before (used by 9 GCP modules) |
| `batch_jobs.py` | boto3-shaped Batch facade for AWS or Azure; describe/terminate route by id prefix (`azb:`); `search_orchestrator.py` changed one line |
| `resign_guard.py` | Azure resigner safety: exact prod `SIGNING_*` required, a live CDN canary (signed 200/206, unsigned 403), DRY_RUN by default, refuses real writes on a shadow stamp |
| `quality_checker.py` | Per-call temp directory |
| `gcp_*audio*.py` | Honour `AUDIO_GCS_BUCKET` (video and audio share one Function App) |
| `resync_subtitles.py` | `RESIGN_INVOKE_MODE=inprocess` (default `lambda`, unchanged) |

### Azure Functions (`azure-functions/`)
| File | Purpose |
|---|---|
| `bitrater_wf/sfn.py` | Step Functions semantics: Retry (MaxAttempts counts retries), Catch with Lambda-style causes, strict ResultSelector (`PathMissing` = States.Runtime, never caught), activity crashes become TaskError |
| `bitrater_wf/orchestrators.py` | The 4 ports; `continue_as_new` every 100 polls; audio batch sliding window of 30 with tolerated failures |
| `bitrater_wf/handlers.py` | Module allowlist, Lambda-style error payloads, isolation check |
| `function_app.py` | Registration, `/api/invoke/{fn}` (sync off the event loop, async = Event invoke with Lambda-style retries), ffmpeg setup (safe, atomic) |
| `host.json` | Hub `%DURABLE_TASK_HUB%`, 5 s queue polling, max 3 concurrent activities (the copy step buffers about 1 GiB) |
| `scripts/build_functions.sh` | Copies `orchestrator/*.py`, the ffmpeg binaries from the Lambda layer, and pinned requirements into the package (gitignored outputs) |

### Jobs and workers
| File | Purpose |
|---|---|
| `azure-jobs/Dockerfile`, `Dockerfile.dockerignore`, `run_job.py` | One image: `resigner` (through `resign_guard`) and `url_health` |
| `workers/azure_entry.py` + `workers/*-azure/Dockerfile` | Built on the exact ECR images (by digest); reads Mongo/S3 keys from Key Vault via IMDS (a separate pool identity per stamp); runs in the Batch task dir on the temp disk and links `configs/`; `TMPDIR` also goes there |
| `research-worker/worker.py`, `audio-visqol-worker/worker.py` | Only change: `DB_LAB` from env |

### Dashboard
| File | Purpose |
|---|---|
| `lib/workflows.js` | SFN ↔ Durable (Durable status 200/202/400/500 handled; failure cause matches SFN's) |
| `lib/jobs.js` | AWS Batch ↔ Azure Batch; lists both clouds; bounded-parallel describes; nextLink kept verbatim |
| `lib/invoke.js` | Lambda ↔ `/api/invoke`, Lambda-shaped results, per-function provider override |
| `lib/blobUpload.js` | Put Block + user-delegation SAS; account/container come from the upload token |
| `lib/cloud/ids.js` | Provider by id prefix (`arn:aws:`, `azdf:`, `azb:`); **shadow refuses AWS ids** |
| `app/api/test-jas-h264/route.js` | Uses Key Vault for the GCP credential on Azure; explicitly disabled and hidden on shadow because its fixed test bucket is not shadow-isolated |
| Rewired routes | push, gcp, gcp-status, audio/convert, run-show, visqol, stop-lab, auto-pipeline/cancel, show-status/active-runs, parallelResolLab, create-combined-master, quality-check, resync-subtitles, signing/resign (full sweep async on Azure), sync-showcache-episode/trailer, uploads/*, episode-vtt (`VTT_ENABLED`), uploads/sync (`UPLOAD_DEV_SYNC_ENABLED`) |
| Other routes | Only the DB-name codemod (pure rename) |

### Infrastructure (`azure-infra/`)
| File | Purpose |
|---|---|
| `bootstrap/` | Terraform state storage (AAD only) plus the deployer's blob-data role |
| `versions.tf`, `variables.tf`, `foundation.tf`, `stamps.tf`, `monitoring.tf`, `outputs.tf` | Everything in §5. Fail-closed checks require Entra before exposing a dashboard, `alert_email` before enabling apps, immutable ACR digests, and an exact Batch VM image version. Alerts cover resigner, Functions/Durable exceptions, stuck workflows, Batch task/allocation failures, dashboard replicas and scheduled-job failures |
| `scripts/copy_secrets_sm_to_kv.sh` | Modes: pipeline (from Secrets Manager + `aws-infra/terraform.tfvars`), `--aws-key <aws-s3-readonly\|aws-bridge>` (reads env `AWS_KEY_ID`/`AWS_KEY_SECRET`), `--gcp-shadow-key <file>` (checks it's the shadow SA). Dry run unless `--apply` |
| `scripts/publish_functions.sh <stamp> [--keys-only]` | Publish code, restart, store the Durable/function keys in Key Vault (`durable-task-key-<stamp>`, `functions-invoke-key-<stamp>`) |

### Test and parity tools
| File | Purpose |
|---|---|
| `tests/python/*`, `dashboard/test/*`, `pytest.ini`, `dashboard/vitest.config.mjs` | Test harness (the repo had no tests before) |
| `scripts/test_all.sh` | Run before any change is considered done |
| `requirements-lambda.txt` | Pinned to the live Lambda layer |
| `requirements-azure.txt`, `requirements-dev.txt` | Azure runtime deps; test venv `.venv` (Python 3.11 via `uv`) |
| `scripts/cutover/freeze_check.py` | The P6 gate (AWS SFN incl. legacy machine, AWS Batch, Azure Durable incl. Suspended/ContinuedAsNew, Azure Batch, Mongo `pipeline_runs`). `--require-azure` fails closed and supports multi-stamp JSON target lists |
| `scripts/parity/seed_shadow.py` | Copies prod records into the shadow DBs and strips all output URLs **and** AWS execution/job ids |
| `scripts/parity/seedset.json` | The agreed seed list |
| `scripts/parity/snapshot_prod.py` | Counts + max_id + hash of canonical playback URLs (detects overwrites) |
| `manifest_diff.py`, `vmaf_compare.py`, `mongo_shape_diff.py`, `resign_dryrun_compare.py` | Parity comparisons |
| `shadow_tripwire.kql` | Must return 0 rows throughout shadow |

---

## 7. How it was verified

- **Tests:** `scripts/test_all.sh` gives 114 Python and 55 dashboard tests passing. `cd dashboard && npm run build` exits 0; its two "Dynamic server usage" log lines also appear on the original code. `next lint` was never configured in this repo, so it isn't used.
- **Key parity tests:**
  - `search_orchestrator` makes **identical decisions** on AWS vs Azure Batch backends (normal, failing, slow, and lost-job timeout scenarios).
  - The Durable ports match the SFN JSON constants (contract test).
  - The AWS path of every dashboard adapter sends **the same SDK commands** (aws-sdk-client-mock).
- **Terraform:**
  - `validate` passes.
  - Read-only `terraform plan` (scratch copy, backend removed, creates nothing):
    - A2 (shadow foundation): 32 resources
    - D (shadow apps): 59
    - G1 (prod, url-health): 101
    - G2: 103
    - G3: 103
    - G4: 105
    - H: 104
  - Bad configs are rejected.
- **Live read-only checks:**
  - `freeze_check.py` against prod: nothing in flight.
  - The secret-copy dry run finds all 7 pipeline sources.
  - The seed dry run counts records (§10).
- **Reviews:**
  - First audit: 3 reviewers (dashboard flows, pipeline, infra).
  - Second review: 2 reviewers (code fixes, Terraform/scripts).
  - Every finding was checked against the code and fixed.
  - Third review (external tool, 8 findings), whose fixes were then checked:
    - Its fixes: Entra login required before any dashboard; a separate Batch account, pool and identity per stamp; `test-jas-h264` reads the GCP key from Key Vault on Azure and is hidden in shadow; `freeze_check --require-azure` fails closed; alerts for Functions exceptions, stuck workflows, Batch failures, dashboard down and job failures, plus a deep health check; watchdog and Batch cleanup jobs; immutable image digests and an exact VM image version.
    - Three bugs in those fixes were found and corrected:
      1. `SHADOW_MODE=true` on jobs plus the full isolation check blocked the Phase F dry run and the G1 url-health compare, which must read prod `master`. Replaced by job-specific rules (`runtime_config.assert_job_isolation`): shadow jobs write only `*_shadow`, the resigner stays dry, and reading prod master is allowed. A test uses the exact Phase F env.
      2. The Entra `clientSecretSettingName` pointed at an env var. It must name a Container App secret (`entra-client-secret`), and the client secret is no longer passed into the app.
      3. The new job names exceeded the 32-character Container Apps limit, which would have broken every apply after A2. They're now `…-bcleanup` and `…-watchdog`, and a test guards the limit.
    - After this round: 114 Python and 55 dashboard tests pass, the build passes, `terraform validate` passes, and read-only plans pass for A2, D, F, G1, G2, G3, G4 and H. A dashboard without login is refused.
  - Details are in `AZURE-MIGRATION-PLAN.md` §10.

---

## 8. Findings worth knowing

- **Video and audio share env var names with different values** (`GCS_INPUT/OUTPUT_BUCKET`). Audio now reads `AUDIO_GCS_BUCKET` first. Without this, audio would use the video buckets, and its copy step deletes `output/<id>/`.
- **AWS quirk, mirrored for parity:** Audio-Video (`av_`) GCP runs end FAILED in SFN after a successful finalize. The ResultSelector expects keys without the `av_` prefix. It's harmless.
- **The lab's discard path is dead code.** The binary search never discards. Terminate still happens on the lost-job timeout path.
- **The resigner sweep is now Mongo-only** and takes seconds. The old 900 s Lambda ceiling came from the earlier GCS-based version. Jobs still get 3600 s.
- **Signing default:** the code's default `SIGNING_MODE` is `signature`, but prod uses `token`. Azure sets it explicitly, and `resign_guard` refuses anything else.
- **Durable instance ids are short** (`<kind>-<uuid>`) to stay under length limits.
- **Shadow/prod Batch isolation is account-level.** Each stamp has its own Batch account, pool and managed identity; account-scoped Batch submit permissions cannot cross the boundary.
- **Completed Batch task records are retained for 7 days.** A daily Container Apps Job removes older records; a 15-minute watchdog fails when a Durable instance runs longer than 24 h.
- **Runtime artifacts are immutable.** App images must be `repository@sha256:<digest>` and the Batch node image must use an exact marketplace version, never `latest`.
- **The GCP SA key file at the repo root was never committed** (it's gitignored). Rotating it is housekeeping.
- **Cosmos firewall is AllowAll.** Azure can reach it, but tighten it after the migration (a separate change).

---

## 9. Deviations from the original plan (and why)

- **Copy / finalize / quality-check / resync run as Durable activities on Flex,** not as separate Container Apps Jobs. Flex allows long timeouts, and ffmpeg is bundled from the same Lambda layer, so the binaries are identical. Container Apps Jobs are used for resigner, url-health, the Durable watchdog and Batch record cleanup.
- **Batch uses BatchService mode,** so there's no subscription-level Batch service principal role. Its Spot quota is per account.
- **Batch VM is `Standard_D4a_v4`,** not `D4as_v5`: the workers need a temp disk, and `as_v5` is restricted.
- **The AWS deploy guard blocks the migration branch** rather than "main-only", because prod deploys come from `sync-bitrater-to-org`.
- **Per-stamp `apps` flag** replaces the single global flag, so prod can be staged like shadow.

---

## 10. Test-copy seed set (agreed 2026-09-26)

`scripts/parity/seedset.json`:
- **Shows:**
  - `test-1234567`, `test-jas123`: Azure-Blob sources
  - `day-shift-night-shift`, `oh-my-dog`: 8 episodes each, S3 sources, subtitles
  - `trial-marriage`: trailer
  - `girl-talks-deepa-thomas-podcast`: Audio-Video run, 8.5 GB source
  - `girl-talks-ritika-nayak-podcast`: 14.9 GB source, the largest, also Audio-Video
- **Podcast:** `radhe-govindha-podcast` (8 audio episodes).
- **Dry-run counts:** showcache 7, podcast_showcache 1, video_episodes 44, video_vmaf_research 699, audio_episodes 8.
- `test-123` isn't in `master.showcache`, so it's skipped.
- Subtitles are read from their own cluster, not copied.

---

## 11. Next steps (in order). ★ = needs the owner's explicit approval

Before each step, re-read the gate and rollback in `AZURE-MIGRATION-PLAN.md` §6. After each step, record it in §10 there.

### Phase A: foundations (no prod impact)

- **A1 ★ state storage**
  - Run: `cd azure-infra/bootstrap && terraform init && terraform apply`.
  - Creates `rg-bitrater-tfstate` / `bitratertfstate` + your Storage Blob Data Contributor role.
  - Check: `az storage container list --account-name bitratertfstate --auth-mode login`.
- **A-pre ★ register Batch:** `az provider register -n Microsoft.Batch --wait`.
- **A2 ★ foundation (defaults: shadow `enabled=true`, `apps=false`; prod disabled)**
  - First set `batch_image_version` to an exact version (`latest` is rejected). The supported-images check needs a Batch account, which doesn't exist before A2, so pick the version from the marketplace list:
    `az vm image list --publisher microsoft-dsvm --offer ubuntu-hpc --sku 2204 --location centralindia --all -o table`.
    A3 then confirms it against the new account. If it isn't container-capable, change the version and re-apply (the pool is at 0 nodes, so nothing is lost).
  - Run: `cd azure-infra && terraform init && terraform plan -out tfplan`, inspect the plan, then `terraform apply tfplan`.
  - Creates: RG, Log Analytics, App Insights, ACR, Key Vault (+ your Secrets Officer role), Container Apps env, the shadow Batch account + isolated pool (0 nodes), shadow identities, the Function App (no code), Batch jobs, and shadow upload storage.
- **A3 ★ quota**
  - Request the required low-priority core quota independently for each Batch account; shadow can use a small limit and prod should target about 512 cores.
  - Confirm the image: `az batch pool supported-images list --account-name bitraterbatch<stamp> --account-endpoint <endpoint>` must list the chosen `ubuntu-hpc 2204` version as container-capable. If not, update `batch_image_version` and re-apply.
- **A4 ★ import worker images by digest** (keeps VMAF/ffmpeg identical):
  ```
  az acr import -n bitraterprodacr \
    --source 107647021172.dkr.ecr.us-east-1.amazonaws.com/chai-q-worker@sha256:398058677769f1815668b36b0056642bf40355c0421c34fb4bdec9363238a430 \
    --image chai-q-worker:ecr-20260924 --username AWS --password "$(aws ecr get-login-password --region us-east-1)"
  ```
  Do the same for `audio-visqol-worker@sha256:0e9e1972…c51d9`.
  - Check that the digest in ACR equals the ECR digest (the wrapper Dockerfiles reference them by digest).
  - Optionally diff `worker.py` inside the image against `6d0508f`.
- **A5 ★ secrets**
  1. Run `azure-infra/scripts/copy_secrets_sm_to_kv.sh`. It's a dry run and should list 7 names. Then run it again with `--apply`.
  2. Create an AWS IAM user `chai-q-azure-s3-readonly` with `s3:GetObject` and `s3:ListBucket` on the source buckets (at least `sanity-dev-store`, ap-south-2). Confirm the bucket list from the `s3_url` values first.
  3. Create an access key and pass it via env: `AWS_KEY_ID=… AWS_KEY_SECRET=… copy_secrets_sm_to_kv.sh --aws-key aws-s3-readonly --apply`.
  4. Create the Entra app registration and client secret, then pipe it to Key Vault with `ENTRA_CLIENT_SECRET=… copy_secrets_sm_to_kv.sh --entra-client-secret --apply`; set `entra_client_id`. Never put the secret in Terraform variables.
- **A6 smoke (read-only on prod).** The `azure-infra/smoke/` scripts in the plan are **not written yet**; either write them or run these by hand:
  - each identity can read only its own secrets (after `apps=true`);
  - resize the Batch pool 0→1→0 and run one task that prints `env | grep AZ_BATCH; df -h` and reads one Key Vault secret via IMDS;
  - the Container Apps env is healthy.

### Phase B: shadow data (reads prod only)

- **B1 ★ GCP**
  1. Run `! gcloud auth login` (the login has expired).
  2. Create the buckets `gs://chai-q-az-shadow-{input,output,manifests,audio}` (asia-south1, 30-day lifecycle).
  3. Create SA `chai-q-az-shadow@media-cdn-poc-466009` with objectAdmin **only on those buckets**, plus Transcoder job rights. Grant the Transcoder service agent access to the shadow buckets.
  4. Create a key → `copy_secrets_sm_to_kv.sh --gcp-shadow-key key.json --apply`, then delete the local key file.
  5. **Decision:** make `chai-q-az-shadow-manifests` public-read (needed to play shadow output, since child playlists are relative)?
  6. Gate: a write to `chai-shots-manifests` with the shadow SA must return 403.
- **B2 ★ seed:**
  1. `MONGO_URI=… python scripts/parity/snapshot_prod.py > before.json`.
  2. `python scripts/parity/seed_shadow.py scripts/parity/seedset.json --apply`.
  3. `snapshot_prod.py > after.json` and diff; they must be equal.
- **B3 ★ tripwire:** turn on Cosmos diagnostic logs to Log Analytics so `shadow_tripwire.kql` works.

### Phase D: shadow live (no prod impact)

1. ★ Build and push images to ACR:
   - Dashboard: `docker build --platform linux/amd64 -f dashboard/Dockerfile -t bitraterprodacr.azurecr.io/bitrater-dashboard:<tag> .`
   - Jobs: `-f azure-jobs/Dockerfile` → `bitrater-jobs:<tag>`
   - Workers: `workers/chai-q-worker-azure/Dockerfile` and `workers/audio-visqol-azure/Dockerfile`
   - Resolve each pushed manifest digest and set `var.images` as `repository@sha256:<digest>`; mutable tags are rejected when apps are enabled.
2. ★ `azure-infra/scripts/publish_functions.sh shadow`. Needs Azure Functions Core Tools (`func`).
3. ★ Confirm `entra_client_id`, `alert_email`, `entra-client-secret`, all four image digests and the exact Batch image version are set. Then set `stamps.shadow.apps = true` and apply: grants, authenticated shadow dashboard, monitoring, watchdog/cleanup schedules and jobs.
4. ★ `publish_functions.sh shadow --keys-only`: restarts so the Key Vault references resolve. **Do this after every apply that changes grants.**
5. Gate:
   - every entrypoint logs that isolation passed;
   - tripwire returns 0;
   - test-show lab and GCP runs complete in shadow.
6. Gate: unauthenticated dashboard requests redirect to Entra, login completes successfully, and `/api/health?deep=1` returns `ready` for an authenticated operator.

### Phase E: parity (transcode spend only)

- **Lab:** 3 episodes × 2 codecs, then `scripts/parity/vmaf_compare.py <episode_id>`. Pass: VMAF within ±0.5 and golden recipe within 1 step. The Batch CPU is AMD vs AWS Intel, so this gate is what proves parity.
- **Transcode:** episode, trailer, Audio-Video.
  - `manifest_diff.py gs://chai-shots-manifests/<ep>/<ts>/ gs://chai-q-az-shadow-manifests/<ep>/<ts>/` must differ only in timestamps.
  - `mongo_shape_diff.py video_episodes <ep>`.
  - Playback in hls.js, AVPlayer and ExoPlayer.
- **Audio:** convert + show batch.
- **Failure matrix:** bad source, cancelled job, stop-lab. Compare against historical AWS records; forcing failures on AWS needs approval.
- **Upload test:** into `bitratershadowup`.

### Phase F: resigner dry run (reads prod)

- ★ Set `stamps.shadow.resigner.enabled = true` (leave `dry_run = true`, `db_master = "master"`), then apply and run `--keys-only`.
- Wait 12 runs (24 h), then `resign_dryrun_compare.py --last 12` must print GATE F PASSED.
- If the canary fails, check the alert query column names and the log format.

### Phase G: cutovers (each is a one-line edit + apply + `publish_functions.sh prod --keys-only`, in a freeze window)

- **G1 ★ url-health on prod**
  1. Set `stamps.prod.enabled = true`, apply, `publish_functions.sh prod`.
  2. Set `apps = true` (`dashboard_replicas = 0` means no prod dashboard; `aws_key = "aws-s3-readonly"`), apply, `--keys-only`.
  3. First compare in shadow for 3 h. Then set `url_health.enabled = true` on prod and disable the AWS EventBridge url-health rule (not delete).
  - Rollback: re-enable the rule.
- **G2 ★ dashboard bridge**
  1. Create IAM user `aws-bridge` with everything the App Runner role had:
     - SFN Start/Describe/Stop on the 5 machines
     - Batch Submit/List/Describe/Terminate on the **unversioned** job defs `chai-q-worker` and `audio-visqol` (pinned revisions caused AccessDenied before)
     - `lambda:InvokeFunction` on the 4 functions
     - S3 Get on the sources and multipart Put on `sanity-dev-store`
  2. `--aws-key aws-bridge --apply`.
  3. Freeze with `freeze_check.py --require-azure` and explicit shadow+prod Durable/Batch targets, then set prod `aws_key = "aws-bridge"`, `dashboard_replicas = 1`, `cloud_provider = "aws"`, apply, `--keys-only`.
  4. Pause App Runner, smoke-test, unfreeze.
  - Rollback: `dashboard_replicas = 0` + resume App Runner.
- **G3 ★ backends:** freeze, set prod `cloud_provider = "azure"` (the resigner stays on the AWS Lambda), test show end-to-end, unfreeze. **Revert drill** before and after (runbook below).
- **G4 ★ resigner:**
  1. Set `alert_email`.
  2. Set prod `resign_invoke = "inprocess"`, `resigner = { enabled = true, dry_run = false, db_master = "master" }`.
  3. Run in parallel with AWS EventBridge for 24 h.
  4. Disable (not delete) the EventBridge resign rule.
- **H:** 30-day soak, then prod `aws_key = "aws-s3-readonly"` and revoke the bridge key. **AWS stays in place.**

### Revert to AWS (target under 15 min; drill it twice at G3)

1. Freeze; `freeze_check.py --require-azure` checks every configured shadow/prod Durable and Batch target and shows 0 in flight.
2. Disable the Azure crons and set the prod dashboard to `dashboard_replicas = 0`.
3. Resume App Runner.
4. Re-enable both EventBridge rules.
5. Smoke-test a test show.
6. Unfreeze.

Data is compatible both ways: same Mongo fields, same GCS paths.

---

## 12. Still open / unknown until live

- **Owner decisions:**
  - Public-read shadow manifests bucket (B1).
  - Storage team's OK for the prod upload role (`prod_upload.grant_role_to_prod_dashboard`).
  - Entra app registration/client secret and `alert_email` are prerequisites for `apps=true` (Terraform now refuses to proceed without them).
- **Live checks (A6/D):**
  - Batch Spot allocation in BatchService mode for each stamp account (low-priority VMs were retired in 2025; confirm `$TargetLowPriorityNodes` gets Spot).
  - Container-capable image.
  - `AZ_BATCH_TASK_WORKING_DIR` mounted into containers.
  - `--rm` keeps the exit code.
  - OData filter `state ne 'completed'` accepted.
  - Key Vault secret-scoped role assignments need the secret to exist (they are created only at `apps=true`).
  - `ContainerAppConsoleLogs_CL` table exists before the alerts are created.
  - Confirm the Batch `TaskFailEvent`, Container Apps `Replicas`, and App Insights `exceptions/count` metric names in the subscription; exercise every alert before cutover.
  - Confirm the Entra `clientSecretSettingName` flow completes a real login before exposing the dashboard URL.
  - ffmpeg is executable on Flex.
  - The durabletask system key appears after publish.
  - A throw in Next `instrumentation.ts` stops the server (code now calls `process.exit(1)`).
  - Azure CLI default subscription is `ff1dad43…`.
- **Not done on purpose:**
  - `next.config.js` image hosts allow only `**.amazonaws.com`; add the blob host if images are served from Blob.
  - `azure-infra/smoke/` scripts are not written (A6).

---

## 13. Handy commands

```bash
cd /Users/cstech-05/Desktop/bitrater
git status --short            # everything is uncommitted by design; do NOT commit
git diff 6d0508f --stat       # tracked changes vs the AWS prod commit
scripts/test_all.sh           # must print ALL TESTS PASSED
(cd dashboard && npm run build)
(cd azure-infra && terraform init -backend=false && terraform validate)
# AWS-only diagnostic (not sufficient for a cutover gate): MONGO_URI is never printed
MONGO_URI="$(python3 -c "import re;print(re.search(r'^\s*mongo_uri\s*=\s*\"(.*)\"',open('aws-infra/terraform.tfvars').read(),re.M).group(1))")" \
  .venv/bin/python scripts/cutover/freeze_check.py --skip-azure
# Cutovers must use --require-azure. Supply AZURE_DURABLE_TARGETS and
# AZURE_BATCH_TARGETS as non-empty JSON arrays containing every enabled stamp.
```

To recover the undone commit history (only if the owner asks), the reflog has it: the last commit was `90413b0` (`git reflog`, kept about 90 days).
