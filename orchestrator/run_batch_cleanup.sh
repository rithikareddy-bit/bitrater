#!/usr/bin/env bash
#
# run_batch_cleanup.sh — drive the manifest param-strip to completion on a VM.
#
# Runs batch_strip_manifests.py in a resilient loop: processes ALL remaining
# episodes (--limit 0) at the safe pace, and if the process dies (crash, spot
# reclaim, network blip) it resumes from the JSONL state file after a short wait.
# It stops cleanly when the backlog is empty (exit 0) or if the edge ever starts
# enforcing signing (exit 2).
#
# Run it inside tmux so it survives SSH disconnects:
#   tmux new -s cleanup
#   ./run_batch_cleanup.sh
#   (detach: Ctrl-b then d   |   reattach: tmux attach -t cleanup)
#
# Prereqs on the box (see VM-SETUP-batch-cleanup.md):
#   - AWS creds that can read the GCP-SA secret (instance role or env)
#   - MONGO_URI exported
#   - python3 + deps installed
#   - this dir contains: strip_manifest_params.py, batch_strip_manifests.py, media_cdn_signer.py

set -uo pipefail
cd "$(dirname "$0")"

ARN="${GCP_SA_SECRET_ARN:-arn:aws:secretsmanager:us-east-1:107647021172:secret:chai-q-gcp-credentials-0IwMJd}"

if [ -z "${MONGO_URI:-}" ]; then
  echo "ERROR: MONGO_URI not set. export it (or: set -a; . /path/.env.deploy; set +a) and re-run." >&2
  exit 1
fi

# Tunables — override via env if you want it even slower.
LIMIT="${LIMIT:-0}"                    # 0 = all remaining in one pass
SLEEP="${SLEEP:-5}"                    # seconds between episodes
INVAL_DELAY="${INVAL_DELAY:-5}"        # seconds between CDN invalidations
BACKUP="${BACKUP:---backup}"           # set BACKUP="" to skip .bak copies

# Progress signal = number of episodes recorded "done" in the state file. If it
# doesn't grow across MAX_STUCK consecutive retry passes, we're not making
# progress (e.g. Mongo unreachable / Atlas IP not allowlisted / bad creds) — so
# ABORT with a clear error instead of spinning forever. Real progress resets it.
STATE_FILE="${STATE_FILE:-batch_strip_state.jsonl}"
MAX_STUCK="${MAX_STUCK:-3}"
done_count() {
  [ -f "$STATE_FILE" ] || { echo 0; return; }
  local n; n=$(grep -c '"status": "done"' "$STATE_FILE" 2>/dev/null); echo "${n:-0}"
}

echo "=== manifest cleanup loop starting $(date -u)  (abort after $MAX_STUCK stuck passes) ==="
attempt=0
stuck=0
prev_done=$(done_count)
while true; do
  attempt=$((attempt+1))
  echo "--- pass #$attempt  $(date -u)  (done so far: $prev_done) ---"
  python3 batch_strip_manifests.py \
    --from-secret "$ARN" \
    --apply $BACKUP \
    --limit "$LIMIT" \
    --sleep "$SLEEP" \
    --invalidation-delay "$INVAL_DELAY"
  rc=$?

  # rc=0 done, rc=2 edge ENFORCES (hard stop). Everything else (rc=5 transient
  # edge-unreadable, rc=3 partial, or a crash) is retryable — but still guarded by
  # the no-progress cap so a persistent failure (Mongo down, edge unreadable for
  # good) can't spin forever.
  case "$rc" in
    0) echo "=== ALL DONE (rc=0) $(date -u) ==="; break ;;
    2) echo "=== STOP: edge ENFORCES signing (rc=2) — fix the edge config before continuing. ===" >&2; break ;;
    *)
      [ "$rc" -eq 5 ] && echo "pass #$attempt: edge unreadable (transient network/sleep blip)." >&2
      cur_done=$(done_count)
      if [ "$cur_done" -gt "$prev_done" ]; then
        stuck=0                                  # made progress → reset
      else
        stuck=$((stuck+1))
        echo "no progress this pass (stuck ${stuck}/${MAX_STUCK})." >&2
      fi
      prev_done=$cur_done
      if [ "$stuck" -ge "$MAX_STUCK" ]; then
        echo "=== ABORT: ${MAX_STUCK} consecutive passes with no progress (rc=$rc)." >&2
        echo "    Likely Mongo unreachable / Atlas IP not allowlisted / edge unreadable / bad creds." >&2
        echo "    Check batch_strip_manifests.log, fix the cause, then re-run (state resumes)." >&2
        exit 1
      fi
      echo "pass #$attempt rc=$rc — resuming from state in 60s..."
      sleep 60
      ;;
  esac
done
