# Deploy runbook

How to ship changes safely, and the one failure mode that has bitten this repo.
For secret rotation and signing keys see `DEPLOY-SECRETS.md`.

---

## 1. Where variables come from

**`aws-infra/terraform.tfvars` is the single source of truth.** Terraform loads it
automatically. Nothing needs to be exported in your shell.

It holds: `mongo_uri`, `subtitle_mongo_uri`, `cdn_base`, `gcp_project`,
`gcs_input_bucket`, `gcs_output_bucket`, `gcp_credentials_secret_arn`,
`vtt_worker_url`, `vtt_worker_secret`, plus signing config.

> **Never pass these with `-var` from the shell.** See §4.

---

## 2. What deploys where

Two independent targets. A change to one does not ship the other.

| Component | Path | Deployed by |
|---|---|---|
| Dashboard (Next.js) | `dashboard/` | Docker → ECR → App Runner (auto-redeploys on push) |
| Lambdas | `orchestrator/*.py` | `terraform apply` (`archive_file` → `source_code_hash`) |
| Research worker | `research-worker/` | Docker → ECR |

A single feature is often **split across both**. Example: the Check Quality fix
is half `dashboard/` (button gating) and half `orchestrator/quality_checker.py`
(the Lambda). Shipping only the dashboard leaves the button enabled against a
Lambda that cannot serve it.

**Order: Lambdas first, then the dashboard.** New Lambda + old dashboard is
harmless; old Lambda + new dashboard is broken.

### Lambda only

```bash
cd aws-infra
terraform plan  -target=aws_lambda_function.<name>   # read it, then:
terraform apply -target=aws_lambda_function.<name>
```

### Dashboard only

```bash
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 107647021172.dkr.ecr.us-east-1.amazonaws.com
docker build --platform linux/amd64 -f dashboard/Dockerfile -t chai-q-dashboard .
docker tag chai-q-dashboard:latest 107647021172.dkr.ecr.us-east-1.amazonaws.com/chai-q-dashboard:latest
docker push 107647021172.dkr.ecr.us-east-1.amazonaws.com/chai-q-dashboard:latest
```

`auto_deployments_enabled = true` on App Runner, so the push alone triggers the
redeploy.

### Everything (`./deploy.sh`)

Full bootstrap: enables GCP APIs, creates buckets, `terraform apply` across all
infra, rebuilds **both** the research-worker and dashboard images. Use it for a
fresh environment. For a routine change it is overkill — it redeploys transcode
workers for a dashboard-only edit.

---

## 3. Reading a plan before you apply

A shared source file can pull an unrelated Lambda into the plan. `lambda.tf`
bundles `gcp_finalize_hls.py` into **both** `gcp_finalize` and
`resync_subtitles`, so editing it dirties the zip hash of both — even when the
second one never calls the changed function.

Before applying, confirm each listed resource is one you meant to touch. To check
what actually differs, diff the deployed code against the repo:

```bash
aws lambda get-function --function-name <fn> --region us-east-1 \
  --query 'Code.Location' --output text | xargs curl -s -o /tmp/live.zip
unzip -o -q /tmp/live.zip -d /tmp/live && diff /tmp/live/<file>.py orchestrator/<file>.py
```

---

## 4. The `-var` hazard

**Do not pass `-var` flags.** This is the failure mode to know about.

### What happens

`-var="mongo_uri=${MONGO_URI}"` with `MONGO_URI` unset in your shell:

1. **The shell** expands the unset variable to nothing → Terraform receives
   `-var=mongo_uri=`. The variable name is gone by the time Terraform runs.
2. **Terraform precedence** — an explicit `-var` outranks `terraform.tfvars`, so
   `""` beats the real value. (Order, lowest to highest: `default` → `TF_VAR_*` →
   `terraform.tfvars` → `-var`.)
3. **No guard existed** — the variable has no `default`, and `""` is a valid
   `string`, so Terraform accepted it silently.

`sensitive = true` then hides it: the plan prints `(sensitive value)`, not `""`.

### Blast radius

`var.mongo_uri` feeds **10 resources**: 7 Lambdas, the Batch job definition, a
Secrets Manager secret — and `apprunner.tf:162`, **the dashboard itself**. An
untargeted apply with an empty value takes the platform down.

### Guards now in place

- **`variables.tf`** — every no-default variable has a `validation` block
  rejecting empty values, so this fails at plan time instead of applying. The
  `cdn_base` block also rejects a trailing slash, since it is string-prefixed
  onto `h264/h265_master_m3u8_url` in MongoDB and a stray `/` yields `//` in
  every URL.
- **`deploy.sh`** — all `-var` flags removed; it checks `terraform.tfvars`
  exists up front, and warns if Step 1d's GCP secret ARN diverges from tfvars.

Validation blocks are plan-time input checks. They describe no infrastructure and
change nothing on apply.

### The tell

A correct code-only Lambda plan touches **`source_code_hash`** and
**`last_modified`**, nothing else:

```
~ source_code_hash = "I3xDMjXc..." -> "AYiftaDT..."
Plan: 0 to add, 1 to change, 0 to destroy.
```

**If you see a `~ environment` block you did not intend, stop.** That is a
variable being overwritten.

---

## 5. Post-deploy verification

Static checks (`terraform validate`, `npm run build`, `py_compile`) prove a
Lambda *packages*, never that it *runs*. After deploying, exercise the path once:

- **Check Quality** → run on one episode with an H.264 master; confirm `overall`
  is not `ERROR`.
- **Check VTTs / Sync** → `/show-status`; confirm counts move as expected.

---

## 6. Rotating a secret

Update the value in **`aws-infra/terraform.tfvars`**, then `terraform apply`.
Putting it only in `.env.deploy` no longer reaches Terraform — that path was
removed in §4. See `DEPLOY-SECRETS.md` for the rotation procedure itself.
