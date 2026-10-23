#!/usr/bin/env bash
# Read-only gate for the legacy S3 -> Lambda -> Chai-Q-Orchestrator entry path.
# AWS stays untouched. Exit 0 only when neither Lambda nor state machine has had
# activity during the observation window; exit 2 when the path is still in use.
set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
LOOKBACK_DAYS="${LOOKBACK_DAYS:-30}"
BUCKET="${LEGACY_S3_BUCKET:-chai-q-raw-input-lab-107647021172}"
FUNCTION="${LEGACY_S3_FUNCTION:-chai-q-s3-trigger}"
STATE_MACHINE="${LEGACY_STATE_MACHINE:-Chai-Q-Orchestrator}"

read -r start end <<<"$(python3 - "$LOOKBACK_DAYS" <<'PY'
from datetime import datetime, timedelta, timezone
import sys
end = datetime.now(timezone.utc).replace(microsecond=0)
start = end - timedelta(days=int(sys.argv[1]))
print(start.isoformat().replace('+00:00', 'Z'), end.isoformat().replace('+00:00', 'Z'))
PY
)"

account="$(aws sts get-caller-identity --query Account --output text)"
machine_arn="arn:aws:states:${AWS_REGION}:${account}:stateMachine:${STATE_MACHINE}"

echo "Legacy entry-path audit (read-only; last ${LOOKBACK_DAYS} days)"
notification="$(aws s3api get-bucket-notification-configuration --bucket "$BUCKET" \
  --query "LambdaFunctionConfigurations[?contains(LambdaFunctionArn, ':function:${FUNCTION}')].Id" --output text)"
if [[ -n "$notification" && "$notification" != "None" ]]; then
  echo "  S3 notification: configured ($notification)"
else
  echo "  S3 notification: not configured"
fi

invocations="$(aws cloudwatch get-metric-statistics --region "$AWS_REGION" \
  --namespace AWS/Lambda --metric-name Invocations \
  --dimensions "Name=FunctionName,Value=$FUNCTION" \
  --start-time "$start" --end-time "$end" --period 86400 --statistics Sum \
  --query 'sum(Datapoints[].Sum)' --output text)"
[[ -n "$invocations" && "$invocations" != "None" ]] || invocations=0

executions="$(aws cloudwatch get-metric-statistics --region "$AWS_REGION" \
  --namespace AWS/States --metric-name ExecutionsStarted \
  --dimensions "Name=StateMachineArn,Value=$machine_arn" \
  --start-time "$start" --end-time "$end" --period 86400 --statistics Sum \
  --query 'sum(Datapoints[].Sum)' --output text)"
[[ -n "$executions" && "$executions" != "None" ]] || executions=0

echo "  Lambda invocations: $invocations"
echo "  Step Functions executions started: $executions"

if awk "BEGIN { exit !(($invocations > 0) || ($executions > 0)) }"; then
  echo "IN USE: port this entry path before Azure backend cutover; do not disable or delete it." >&2
  exit 2
fi

echo "PASS: no observed use. Keep AWS unchanged during Azure shadow/parity."
echo "Re-run immediately before cutover; retirement still requires explicit approval."
