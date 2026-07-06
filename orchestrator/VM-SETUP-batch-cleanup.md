# Running the manifest cleanup on a VM (laptop-independent)

Goal: strip signing params from all ~2,536 old combined masters in
`gs://chai-shots-manifests`, at a safe pace, on a box that keeps running after
you close your laptop. Uses `run_batch_cleanup.sh` inside `tmux`.

The job is **resumable** (JSONL state file) and **idempotent**, so it survives
reboots/crashes — just restart the wrapper and it continues.

---

## 1. The box

A tiny instance is plenty (the job is I/O + sleeps, not CPU):
- **EC2 `t3.small`** (Amazon Linux 2023 / Ubuntu) — recommended, so the AWS creds
  come from an **instance role** (no keys on disk).
- Or any always-on Linux box (GCE, a droplet) — then supply AWS creds via env.

## 2. Credentials the box needs

The box only needs **AWS creds to read one secret**. Everything else (GCS write,
CDN invalidate) is done by the GCP SA that lives *inside* that secret.

**EC2 (best):** attach an instance role with this policy:
```json
{ "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-*" }
```
**Non-EC2:** export `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION=us-east-1`
for an IAM user with the same permission.

## 3. Network access (gotchas)

The box must reach:
- **AWS Secrets Manager** (read the SA)
- **MongoDB Atlas** `prodcluster.mfhti8.mongodb.net` — **add the box's public IP to
  the Atlas IP allowlist**, or it can't enumerate episodes. (Most common failure.)
- **`storage.googleapis.com`** (read/write manifests) and
  **`networkservices.googleapis.com`** (CDN invalidation)

## 4. Install deps

```bash
sudo dnf install -y python3 python3-pip   # or: sudo apt install -y python3 python3-pip
pip3 install --user boto3 pymongo google-cloud-storage google-auth cryptography
```

## 5. Copy the code

Copy these 4 files from `orchestrator/` into a dir on the box (e.g. `~/cleanup/`):
```
strip_manifest_params.py
batch_strip_manifests.py
media_cdn_signer.py
run_batch_cleanup.sh
```
```bash
chmod +x run_batch_cleanup.sh
```

## 6. Set MONGO_URI

Export the master connection string (from `.env.deploy`):
```bash
export MONGO_URI='mongodb+srv://<user>:<pass>@prodcluster.mfhti8.mongodb.net/master?retryWrites=true&w=majority'
```

## 7. Run it (in tmux)

```bash
tmux new -s cleanup
cd ~/cleanup
./run_batch_cleanup.sh
# detach:  Ctrl-b then d        reattach:  tmux attach -t cleanup
```

The wrapper runs `--limit 0` (all remaining) at the safe pace (5s between
episodes, 5s between invalidations, exponential backoff on rate-limit). It loops:
crash/partial → resume after 60s; **done → exit; edge enforcing → stop.**

Go slower if you want:
```bash
SLEEP=10 INVAL_DELAY=10 ./run_batch_cleanup.sh
```

## 8. Monitor

```bash
tail -f batch_strip_manifests.log        # human-readable: cleaned / skipped / urls
wc -l batch_strip_state.jsonl            # how many episodes recorded done/partial
grep -c CLEANED batch_strip_manifests.log
grep -c FAILED  batch_strip_manifests.log
```

## 9. When it finishes

- Log ends with `===== SUMMARY … ALL DONE`.
- Spot-check a cleaned URL: `curl -s "<a master url>" | grep -c Signature=`  → 0.
- **Terminate the instance** (it's only needed for the one-time backfill).
- Optional: clean up `.bak` objects once you're confident:
  `gsutil rm gs://chai-shots-manifests/**/*.bak`  (or per-prefix).

## Safety recap

- Edge is re-checked before every episode; if any route enforces signing the
  whole run **stops** (never strips into an enforcing edge).
- Every file is backed up to `<path>.bak` before overwrite (`--backup`).
- Invalidation is paced + retried with backoff — can't hammer the CDN.
- Idempotent + resumable — safe to stop/restart anytime.
