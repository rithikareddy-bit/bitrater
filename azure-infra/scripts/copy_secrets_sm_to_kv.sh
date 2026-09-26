#!/usr/bin/env bash
# Phase A5: copy the pipeline's existing secrets into Key Vault (kv-bitrater-prod).
# Reads (never modifies) AWS Secrets Manager and aws-infra/terraform.tfvars; values are
# passed to az on stdin (never written to disk, printed or logged).
# Secrets Manager is left in place (AWS stays the revert path; rotate in BOTH stores).
#
# Usage: copy_secrets_sm_to_kv.sh [--apply]                         # pipeline secrets (A5)
#        AWS_KEY_ID=.. AWS_KEY_SECRET=.. copy_secrets_sm_to_kv.sh --aws-key aws-s3-readonly [--apply]
#            writes <prefix>-access-key-id, -secret-access-key, -json (A5 read-only key; G2 aws-bridge)
#        copy_secrets_sm_to_kv.sh --gcp-shadow-key <sa-key.json> [--apply]   # B1 shadow SA
#        ENTRA_CLIENT_SECRET=.. copy_secrets_sm_to_kv.sh --entra-client-secret [--apply]
# Without --apply nothing is written (dry run). --apply needs explicit approval (P8).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VAULT="${VAULT:-kv-bitrater-prod}"
TFVARS="$ROOT/aws-infra/terraform.tfvars"
APPLY=false; MODE=pipeline; ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --aws-key) MODE=aws; ARG="$2"; shift ;;
    --gcp-shadow-key) MODE=gcp-shadow; ARG="$2"; shift ;;
    --entra-client-secret) MODE=entra ;;
    *) echo "unknown arg $1" >&2; exit 64 ;;
  esac
  shift
done

sm()     { aws secretsmanager get-secret-value --region us-east-1 --secret-id "$1" --query SecretString --output text; }
tfvar()  { python3 -c "import re,sys;m=re.search(r'^\s*$1\s*=\s*\"(.*)\"\s*$',open('$TFVARS').read(),re.M);sys.stdout.write(m.group(1) if m else '')"; }
shadow_app() { python3 -c "import sys;u=sys.stdin.read();sys.stdout.write(u+('&' if '?' in u else '?')+'appName=bitrater-azure-shadow')"; }

put() {  # put <kv-name> <description>; value on stdin (refuses empty values)
  # Value stays in memory and reaches az via stdin: no temp file can be left behind
  # (bash 3.2 on macOS does not run EXIT traps in these pipeline subshells).
  local name="$1" desc="$2" value
  value="$(cat; printf x)"; value="${value%x}"
  if [[ -z "$value" ]]; then echo "ERROR: empty value for $name — source missing" >&2; exit 1; fi
  if $APPLY; then
    printf %s "$value" | az keyvault secret set --vault-name "$VAULT" --name "$name" --file /dev/stdin --description "$desc" --output none
    echo "set  $name  ($desc)"
  else
    echo "would set  $name  ($desc, ${#value} bytes)"
  fi
}

if [[ "$MODE" == aws ]]; then
  [[ "$ARG" == aws-s3-readonly || "$ARG" == aws-bridge ]] || { echo "prefix must be aws-s3-readonly or aws-bridge" >&2; exit 64; }
  : "${AWS_KEY_ID:?set AWS_KEY_ID}" "${AWS_KEY_SECRET:?set AWS_KEY_SECRET}"
  printf %s "$AWS_KEY_ID"     | put "$ARG-access-key-id"     "AWS key id ($ARG)"
  printf %s "$AWS_KEY_SECRET" | put "$ARG-secret-access-key" "AWS secret ($ARG)"
  python3 -c 'import json,os;print(json.dumps({"access_key_id":os.environ["AWS_KEY_ID"],"secret_access_key":os.environ["AWS_KEY_SECRET"]}),end="")' \
                              | put "$ARG-json"              "AWS key as JSON for Batch workers ($ARG)"
  $APPLY || echo "(dry run — nothing written)"; exit 0
fi
if [[ "$MODE" == gcp-shadow ]]; then
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["client_email"].startswith("chai-q-az-shadow@"),"not the shadow SA";print(json.dumps(d),end="")' "$ARG" \
                              | put gcp-credentials-shadow "shadow GCP SA key (cannot write prod buckets)"
  $APPLY || echo "(dry run — nothing written)"; exit 0
fi
if [[ "$MODE" == entra ]]; then
  : "${ENTRA_CLIENT_SECRET:?set ENTRA_CLIENT_SECRET}"
  printf %s "$ENTRA_CLIENT_SECRET" | put entra-client-secret "Entra dashboard application client secret"
  $APPLY || echo "(dry run — nothing written)"; exit 0
fi

sm chai-q-gcp-credentials          | put gcp-credentials        "GCP SA key (from SM chai-q-gcp-credentials)"
sm chai-q/media-cdn-signing-key    | put media-cdn-signing-key  "Ed25519 CDN signing key (from SM chai-q/media-cdn-signing-key)"
tfvar mongo_uri                    | put mongo-uri              "prod Mongo URI (from aws-infra tfvars mongo_uri)"
tfvar mongo_uri | shadow_app       | put mongo-uri-shadow       "same cluster, appName=bitrater-azure-shadow (write tripwire)"
tfvar subtitle_mongo_uri           | put subtitle-mongo-uri     "subtitle/dev Mongo URI (from tfvars subtitle_mongo_uri)"
tfvar vtt_worker_secret            | put vtt-worker-secret      "Cloud Run vtt-worker shared secret (from tfvars vtt_worker_secret)"
# Generated once; re-runs keep it (rotating would invalidate in-flight upload tokens).
if $APPLY && az keyvault secret show --vault-name "$VAULT" --name upload-token-secret --query id -o tsv >/dev/null 2>&1; then
  echo "keep upload-token-secret (exists)"
else
  python3 -c "import secrets;print(secrets.token_urlsafe(48),end='')" | put upload-token-secret "HMAC for upload tokens (new)"
fi

echo
echo "Written by other modes / scripts (their own approved steps):"
echo "  --aws-key aws-s3-readonly   A5 (new read-only S3 IAM user)"
echo "  --aws-key aws-bridge        G2 (temporary bridge IAM user)"
echo "  --gcp-shadow-key <file>     B1 (shadow SA key)"
echo "  --entra-client-secret       before enabling a dashboard"
echo "  durable-task-key-<stamp>, functions-invoke-key-<stamp>   scripts/publish_functions.sh (D)"
$APPLY || echo "(dry run — nothing written; re-run with --apply after approval)"
