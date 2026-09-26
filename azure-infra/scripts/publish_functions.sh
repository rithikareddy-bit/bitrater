#!/usr/bin/env bash
# Build + publish the Function App code for a stamp, store its keys in Key Vault for the
# dashboard (durable-task-key-<stamp>, functions-invoke-key-<stamp>; never in Terraform
# state), and restart it.
#
# ALSO run `--keys-only` after EVERY terraform apply that adds/changes the stamp's Key Vault
# grants (apps=true, aws_key switch): the restart makes @Microsoft.KeyVault(...) settings
# resolve with the new access (otherwise they stay unresolved for up to ~24 h).
# Needs approval (deploy).
# Usage: publish_functions.sh <shadow|prod> [--keys-only]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="${1:?usage: publish_functions.sh <shadow|prod> [--keys-only]}"
RG=rg-bitrater-prod; APP="fa-bitrater-$STAMP"; VAULT=kv-bitrater-prod

if [[ "${2:-}" != "--keys-only" ]]; then
  "$ROOT/scripts/build_functions.sh"
  (cd "$ROOT/azure-functions" && func azure functionapp publish "$APP" --python)
fi
az functionapp restart -g "$RG" -n "$APP" --output none
echo "restarted $APP"

store() {  # store <secret-name> <jmespath>  (value kept in memory, sent on stdin)
  local value
  value="$(az functionapp keys list -g "$RG" -n "$APP" --query "$2" -o tsv | tr -d '\n')" || value=""
  [[ -n "$value" ]] || { echo "ERROR: $2 empty (host not started yet?)" >&2; exit 1; }
  printf %s "$value" | az keyvault secret set --vault-name "$VAULT" --name "$1" --file /dev/stdin --output none
  echo "stored $1"
}
store "durable-task-key-$STAMP"     "systemKeys.durabletask_extension"
store "functions-invoke-key-$STAMP" "functionKeys.default"
