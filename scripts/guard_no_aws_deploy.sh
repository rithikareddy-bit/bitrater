#!/usr/bin/env bash
# Refuses to continue when run from an azure-migration* branch.
#
# AWS prod runs the pre-migration code and must never be redeployed from the
# migration branch: its Lambda zips list individual files (aws-infra/lambda.tf)
# and would ship without the new modules (runtime_config.py, secret_store.py,
# ...), breaking prod. See AZURE-MIGRATION-PLAN.md §0 (P1) and P8b.
#
# Source this from any script that deploys to AWS.

_guard_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_guard_branch="$(git -C "$_guard_repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

if [[ "$_guard_branch" == azure-migration* ]]; then
  echo "ERROR: refusing to deploy to AWS from branch '$_guard_branch'." >&2
  echo "  AWS prod is frozen on the pre-migration code (revert path)." >&2
  echo "  Deploy AWS hotfixes from sync-bitrater-to-org, then port them here." >&2
  exit 1
fi
unset _guard_repo _guard_branch
