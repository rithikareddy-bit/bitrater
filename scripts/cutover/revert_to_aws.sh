#!/usr/bin/env bash
# Break-glass revert of the prod stamp to AWS WITHOUT terraform (target < 15 min).
#
# `terraform apply` can be blocked by any failing precondition (missing secret, image,
# Entra, quota) or by a laptop without the working tree. This uses plain az/aws calls:
#   0. preflight: AWS Batch can actually launch instances (the revert target works)
#   1. Azure prod scheduled jobs -> Manual trigger (resigner, url-health, ...), and stop
#      any execution still running (a resign sweep in progress)
#   2. Azure prod dashboard -> ingress disabled + revision deactivated (stops its
#      in-process orchestrator; one dashboard on prod Mongo at a time)
#   3. AWS App Runner chai-q-dashboard resumed (waits for RUNNING)
#   4. AWS EventBridge resign + url-health rules enabled
# Afterwards reconcile terraform (printed at the end) so the next apply doesn't undo this.
#
# Run the freeze check first (scripts/cutover/freeze_check.py --require-azure) unless
# Azure itself is the incident. Dry run (prints commands) unless --apply.
# Usage: revert_to_aws.sh [--apply] [--skip-preflight]
set -euo pipefail
APPLY=0; PREFLIGHT=1
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --skip-preflight) PREFLIGHT=0 ;;
    *) echo "usage: revert_to_aws.sh [--apply] [--skip-preflight]" >&2; exit 64 ;;
  esac
done

RG=rg-bitrater-prod; STAMP=prod; DASH="ca-bitrater-dash-$STAMP"; JOB_PREFIX="acaj-bitrater-$STAMP-"
AWS_REGION=us-east-1; APPRUNNER_SERVICE=chai-q-dashboard
RULES=(chai-q-resign-playback-urls chai-q-url-health-checker)
CE_PREFIX=chai-q-spot-env
AWS_BATCH_QUEUE=chai-q-queue
EXPECTED_AWS_ACCOUNT="${EXPECTED_AWS_ACCOUNT:-107647021172}"

run() {  # print, and execute only with --apply
  echo "+ $*"
  if (( APPLY )); then "$@"; fi
}

SUB="$(az account show --query id -o tsv)"

# --- 0. preflight: is AWS able to run lab jobs? -----------------------------------
if (( PREFLIGHT )); then
  echo "== preflight: AWS Batch capacity"
  account="$(aws sts get-caller-identity --query Account --output text)"
  if [[ "$account" != "$EXPECTED_AWS_ACCOUNT" ]]; then
    echo "PREFLIGHT FAILED: AWS CLI is on account $account, expected $EXPECTED_AWS_ACCOUNT." >&2
    exit 3
  fi
  ce="$(aws batch describe-compute-environments --region "$AWS_REGION" \
        --query "computeEnvironments[?starts_with(computeEnvironmentName,'$CE_PREFIX')]|[0].[computeEnvironmentName,status,state]" --output text)"
  echo "   compute environment: $ce"
  read -r ce_name ce_status ce_state <<<"$ce"
  if [[ -z "${ce_name:-}" || "$ce_name" == "None" || "$ce_status" != "VALID" || "$ce_state" != "ENABLED" ]]; then
    echo "PREFLIGHT FAILED: AWS Batch compute environment must exist and be VALID/ENABLED." >&2
    exit 3
  fi
  queue="$(aws batch describe-job-queues --region "$AWS_REGION" --job-queues "$AWS_BATCH_QUEUE" \
        --query 'jobQueues[0].[jobQueueName,status,state]' --output text)"
  echo "   job queue: $queue"
  read -r queue_name queue_status queue_state <<<"$queue"
  if [[ "$queue_name" != "$AWS_BATCH_QUEUE" || "$queue_status" != "VALID" || "$queue_state" != "ENABLED" ]]; then
    echo "PREFLIGHT FAILED: AWS Batch queue $AWS_BATCH_QUEUE must be VALID/ENABLED." >&2
    exit 3
  fi
  for definition in chai-q-worker audio-visqol; do
    revision="$(aws batch describe-job-definitions --region "$AWS_REGION" --job-definition-name "$definition" \
      --status ACTIVE --query 'max_by(jobDefinitions,&revision).revision' --output text)"
    echo "   job definition $definition: revision $revision"
    if [[ -z "$revision" || "$revision" == "None" ]]; then
      echo "PREFLIGHT FAILED: no ACTIVE AWS Batch job definition named $definition." >&2
      exit 3
    fi
  done
  queued="$(aws batch list-jobs --region "$AWS_REGION" --job-queue "$AWS_BATCH_QUEUE" \
    --job-status RUNNABLE --max-results 1 --query 'length(jobSummaryList)' --output text)"
  if [[ "$queued" != "0" ]]; then
    echo "PREFLIGHT FAILED: $AWS_BATCH_QUEUE already has RUNNABLE work; freeze/repair AWS before reverting." >&2
    exit 3
  fi
  asg="$(aws autoscaling describe-auto-scaling-groups --region "$AWS_REGION" \
         --query "AutoScalingGroups[?starts_with(AutoScalingGroupName,'$CE_PREFIX')]|[0].AutoScalingGroupName" --output text)"
  if [[ -z "$asg" || "$asg" == "None" ]]; then
    echo "PREFLIGHT FAILED: no Auto Scaling group found for $CE_PREFIX; capacity is unproven." >&2
    exit 3
  fi
  last="$(aws autoscaling describe-scaling-activities --region "$AWS_REGION" --auto-scaling-group-name "$asg" \
          --max-items 1 --query 'Activities[0].[StatusCode,StatusMessage]' --output text | head -1)"
  echo "   last scaling activity: $last"
  if [[ -z "$last" || "$last" == "None" || "$last" == Failed* ]]; then
    echo "PREFLIGHT FAILED: AWS Batch launch capacity is missing or its last scale attempt failed." >&2
    echo "Fix AWS first, or use --skip-preflight only for an emergency dashboard/cron rollback." >&2
    exit 3
  fi
fi

# --- 1. Azure scheduled jobs -> Manual, stop running executions -------------------
echo "== Azure scheduled jobs ($JOB_PREFIX*)"
for job in $(az containerapp job list -g "$RG" --query "[?starts_with(name,'$JOB_PREFIX')].name" -o tsv); do
  run az rest --method patch \
    --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/jobs/$job?api-version=2024-03-01" \
    --body '{"properties":{"configuration":{"triggerType":"Manual","scheduleTriggerConfig":null,"manualTriggerConfig":{"parallelism":1,"replicaCompletionCount":1}}}}' \
    --output none
  for execution in $(az containerapp job execution list -g "$RG" -n "$job" --query "[?properties.status=='Running'].name" -o tsv); do
    run az containerapp job stop -g "$RG" -n "$job" --job-execution-name "$execution" --output none
  done
done

# --- 2. Azure dashboard off ---------------------------------------------------------
echo "== Azure dashboard ($DASH)"
if az containerapp show -g "$RG" -n "$DASH" --output none 2>/dev/null; then
  revision="$(az containerapp show -g "$RG" -n "$DASH" --query properties.latestRevisionName -o tsv)"
  run az containerapp ingress disable -g "$RG" -n "$DASH" --output none
  run az containerapp revision deactivate -g "$RG" -n "$DASH" --revision "$revision" --output none
else
  echo "   (no prod dashboard on Azure)"
fi

# --- 3. AWS App Runner back on --------------------------------------------------------
echo "== AWS App Runner ($APPRUNNER_SERVICE)"
arn="$(aws apprunner list-services --region "$AWS_REGION" \
       --query "ServiceSummaryList[?ServiceName=='$APPRUNNER_SERVICE'].ServiceArn|[0]" --output text)"
if [[ -z "$arn" || "$arn" == "None" ]]; then
  echo "AWS App Runner service $APPRUNNER_SERVICE was not found." >&2
  exit 1
fi
status="$(aws apprunner describe-service --region "$AWS_REGION" --service-arn "$arn" --query Service.Status --output text)"
echo "   status: $status"
if [[ "$status" == "PAUSED" ]]; then
  run aws apprunner resume-service --region "$AWS_REGION" --service-arn "$arn" --output text --query Service.Status
  if (( APPLY )); then
    for _ in $(seq 1 60); do
      status="$(aws apprunner describe-service --region "$AWS_REGION" --service-arn "$arn" --query Service.Status --output text)"
      [[ "$status" == "RUNNING" ]] && break
      sleep 10
    done
    echo "   status: $status"
    [[ "$status" == "RUNNING" ]] || { echo "App Runner did not reach RUNNING in 10 min" >&2; exit 1; }
  fi
fi
if [[ "$status" != "RUNNING" && "$status" != "PAUSED" ]]; then
  echo "AWS App Runner is $status, not RUNNING/PAUSED; refusing to enable AWS schedules." >&2
  exit 1
fi

# --- 4. AWS crons back on -------------------------------------------------------------
echo "== AWS EventBridge rules"
for rule in "${RULES[@]}"; do
  run aws events enable-rule --region "$AWS_REGION" --name "$rule"
done

cat <<EOF

== Done$( (( APPLY )) || echo " (DRY RUN: nothing changed; re-run with --apply)" ).
Next:
  1. Smoke-test: open the AWS dashboard, start a GCP transcode for a test show.
  2. Reconcile terraform (azure-infra/terraform.tfvars, stamps.prod), then plan + apply:
       dashboard_replicas = 0
       resigner   = { enabled = false, dry_run = true, db_master = "master" }
       url_health = { enabled = false, db_master = "master" }
     (cloud_provider/resign_invoke only matter once the dashboard is back on Azure.)
  3. Record the revert in AZURE-MIGRATION-PLAN.md §10.
EOF
