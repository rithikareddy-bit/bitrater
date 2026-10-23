#!/usr/bin/env bash
# Local, read-only production-cutover gate. It prevents required migration and
# rollback material from existing only as untracked files on one workstation.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

critical=(
  azure-infra/terraform.tfvars
  scripts/cutover/revert_to_aws.sh
  scripts/cutover/audit_legacy_s3_trigger.sh
  scripts/cutover/release_readiness.sh
  AWS-RETIREMENT-PLAN.md
)

failed=0
for path in "${critical[@]}"; do
  if [[ ! -f "$path" ]]; then
    echo "MISSING: $path" >&2
    failed=1
  elif ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "UNTRACKED: $path" >&2
    failed=1
  fi
done

if ! git diff --check; then
  failed=1
fi

if (( failed )); then
  echo "NOT READY: preserve and review every critical file in source control before production cutover." >&2
  exit 2
fi

echo "PASS: critical migration/revert files are tracked and git diff has no whitespace errors."
echo "This does not replace parity, freeze, quota, legacy-trigger, or rollback-drill gates."
