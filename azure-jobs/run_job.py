"""Container Apps Job entrypoint: `python run_job.py <job>`.

  resigner    -> orchestrator/resign_guard.run() (settings check, CDN canary, DRY_RUN, then the handler)
  url_health  -> url_health_checker.handler({}, None)

Exit code 0 = success; non-zero marks the job execution Failed (alerts key off it).
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

JOBS = ("resigner", "url_health", "batch_cleanup", "workflow_watchdog")


def workflow_watchdog() -> int:
    """Fail if a Durable instance has remained non-terminal beyond the run ceiling."""
    base = os.environ["DURABLE_BASE_URL"].rstrip("/")
    key = os.environ["DURABLE_TASK_KEY"]
    max_hours = int(os.environ.get("AZURE_DURABLE_MAX_RUNNING_HOURS", "24"))
    query = urllib.parse.urlencode({
        "runtimeStatus": "Running,Pending,Suspended,ContinuedAsNew",
        "top": "1000",
        "code": key,
    })
    with urllib.request.urlopen(f"{base}/runtime/webhooks/durabletask/instances?{query}", timeout=30) as response:
        instances = json.load(response)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_hours)
    stale = []
    for instance in instances:
        raw = instance.get("createdTime") or instance.get("createdTimeUtc")
        if raw and datetime.fromisoformat(raw.replace("Z", "+00:00")) < cutoff:
            stale.append(instance.get("instanceId", "unknown"))
    if stale:
        raise RuntimeError(f"DURABLE_STUCK {len(stale)} instance(s): {','.join(stale[:20])}")
    print("DURABLE_WATCHDOG_OK " + json.dumps({"running": len(instances), "max_hours": max_hours}))
    return 0


def cleanup_batch() -> int:
    """Delete old completed task records from this stamp's two long-lived jobs."""
    from azure.batch import BatchClient
    from azure.core.exceptions import ResourceNotFoundError
    from azure.identity import DefaultAzureCredential

    endpoint = os.environ["AZURE_BATCH_ENDPOINT"]
    jobs = [j.strip() for j in os.environ["AZURE_BATCH_JOBS"].split(",") if j.strip()]
    days = int(os.environ.get("AZURE_BATCH_RETENTION_DAYS", "7"))
    if not jobs or days < 1:
        raise ValueError("AZURE_BATCH_JOBS must be non-empty and retention must be at least one day")
    credential = DefaultAzureCredential(managed_identity_client_id=os.environ.get("AZURE_CLIENT_ID"))
    client = BatchClient(endpoint, credential)
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    deleted = 0
    for job in jobs:
        try:
            tasks = client.list_tasks(job, filter="state eq 'completed'")
            for task in tasks:
                ended = getattr(getattr(task, "execution_info", None), "end_time", None)
                if ended and ended < cutoff:
                    client.delete_task(job, task.id)
                    deleted += 1
        except ResourceNotFoundError:
            continue
    print("BATCH_CLEANUP_OK " + json.dumps({"jobs": jobs, "deleted": deleted, "retention_days": days}))
    return 0


def main(argv) -> int:
    if len(argv) != 2 or argv[1] not in JOBS:
        print(f"usage: run_job.py {{{'|'.join(JOBS)}}}", file=sys.stderr)
        return 64
    import runtime_config
    # Job-specific rules: shadow jobs may READ prod master (F, G1) but write only *_shadow.
    runtime_config.assert_job_isolation(argv[1])

    if argv[1] == "resigner":
        import resign_guard

        return resign_guard.run()
    if argv[1] == "batch_cleanup":
        return cleanup_batch()
    if argv[1] == "workflow_watchdog":
        return workflow_watchdog()
    import url_health_checker

    print("URL_HEALTH_OK " + json.dumps(url_health_checker.handler({}, None), default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
