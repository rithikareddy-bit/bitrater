#!/usr/bin/env bash
# Build + publish the Function App code for a stamp, store its keys in Key Vault for the
# dashboard (durable-task-key-<stamp>, functions-invoke-key-<stamp>; never in Terraform
# state), and restart it.
#
# ALSO run `--keys-only` after EVERY terraform apply that adds/changes the stamp's Key Vault
# grants (apps=true, aws_key switch): the restart makes @Microsoft.KeyVault(...) settings
# resolve with the new access (otherwise they stay unresolved for up to ~24 h).
#
# The restart interrupts running activities (copy/finalize/polls retry, but a lab poll
# or copy in progress restarts). For prod it is refused unless FREEZE_OK=1, which you set
# only after scripts/cutover/freeze_check.py --require-azure printed "FREEZE OK".
# Needs approval (deploy).
# Usage: [FREEZE_OK=1] publish_functions.sh <shadow|prod> [--keys-only]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="${1:?usage: publish_functions.sh <shadow|prod> [--keys-only]}"
RG=rg-bitrater-prod; APP="fa-bitrater-$STAMP"; VAULT=kv-bitrater-prod; DASH="ca-bitrater-dash-$STAMP"
KEY_WAIT_SECONDS="${KEY_WAIT_SECONDS:-300}"

if [[ "$STAMP" == "prod" && "${FREEZE_OK:-}" != "1" ]]; then
  echo "REFUSED: restarting fa-bitrater-prod interrupts running pipeline activities." >&2
  echo "Run scripts/cutover/freeze_check.py --require-azure; when it prints 'FREEZE OK', re-run with FREEZE_OK=1." >&2
  exit 2
fi

if [[ "${2:-}" != "--keys-only" ]]; then
  "$ROOT/scripts/build_functions.sh"
  (cd "$ROOT/azure-functions" && func azure functionapp publish "$APP" --python)
fi
az functionapp restart -g "$RG" -n "$APP" --output none
echo "restarted $APP"

changed=0
store() {  # store <secret-name> <jmespath>  (value kept in memory, sent on stdin)
  local value="" current="" waited=0
  # The host needs a moment after restart before it serves keys (the durabletask system
  # key only appears once the extension has started): retry instead of failing.
  while :; do
    value="$(az functionapp keys list -g "$RG" -n "$APP" --query "$2" -o tsv 2>/dev/null | tr -d '\n')" || value=""
    [[ -n "$value" && "$value" != "None" ]] && break
    if (( waited >= KEY_WAIT_SECONDS )); then
      echo "ERROR: $2 still empty after ${KEY_WAIT_SECONDS}s (host not started?); Key Vault NOT updated" >&2
      exit 1
    fi
    sleep 10; waited=$((waited + 10))
  done
  current="$(az keyvault secret show --vault-name "$VAULT" --name "$1" --query value -o tsv 2>/dev/null | tr -d '\n')" || current=""
  if [[ "$value" == "$current" ]]; then
    echo "unchanged $1"
    return
  fi
  printf %s "$value" | az keyvault secret set --vault-name "$VAULT" --name "$1" --file /dev/stdin --output none
  changed=1
  echo "stored $1"
}
store "durable-task-key-$STAMP"     "systemKeys.durabletask_extension"
store "functions-invoke-key-$STAMP" "functionKeys.default"

# The dashboard reads these keys through Key Vault-backed Container App secrets, which
# only refresh periodically: restart its revision so it never calls with a stale key.
if (( changed )) && az containerapp show -g "$RG" -n "$DASH" --output none 2>/dev/null; then
  revision="$(az containerapp show -g "$RG" -n "$DASH" --query properties.latestRevisionName -o tsv)"
  az containerapp revision restart -g "$RG" -n "$DASH" --revision "$revision" --output none
  echo "restarted $DASH ($revision) to pick up the new keys"
fi
