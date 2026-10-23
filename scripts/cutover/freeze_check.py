#!/usr/bin/env python3
"""Freeze-window gate (AZURE-MIGRATION-PLAN.md P6): verify NOTHING is in flight.

Read-only. Exit 0 only if every check is zero:
  AWS   Step Functions RUNNING executions on the 5 live machines
  AWS   Batch jobs SUBMITTED..RUNNING on the lab queue
  Azure Durable instances Running/Pending   (if DURABLE_BASE_URL + DURABLE_TASK_KEY set)
  Azure Batch tasks not completed           (if AZURE_BATCH_ENDPOINT + AZURE_BATCH_JOBS set)
  Azure Container Apps Job executions Running (resigner, url-health, ...; AZURE_SUBSCRIPTION_ID,
                                            resource group AZURE_RESOURCE_GROUP or rg-bitrater-prod)
  Mongo chai_q_lab.pipeline_runs status=RUNNING (MONGO_URI)

Usage: MONGO_URI=... python scripts/cutover/freeze_check.py [--skip-aws] [--skip-azure] [--require-azure]
"""
import json
import os
import sys
import urllib.request

ACCOUNT, REGION = "107647021172", "us-east-1"
MACHINES = ["Chai-Q-Orchestrator-H264", "Chai-Q-Orchestrator-H265", "GCP-Orchestrator",
            "Audio-Orchestrator", "Audio-Show-Batch",
            "Chai-Q-Orchestrator"]  # legacy, still wired to the S3 ObjectCreated trigger
BATCH_ACTIVE = ["SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"]
def _json_targets(environ, name):
    raw = environ.get(name)
    if not raw:
        return None
    value = json.loads(raw)
    if not isinstance(value, list) or not value:
        raise ValueError(f"{name} must be a non-empty JSON array")
    return value


def azure_targets(environ=os.environ):
    """Return explicit targets, with backwards-compatible single-stamp env support."""
    durable = _json_targets(environ, "AZURE_DURABLE_TARGETS")
    if durable is None and environ.get("DURABLE_BASE_URL") and environ.get("DURABLE_TASK_KEY"):
        durable = [{"name": "default", "base": environ["DURABLE_BASE_URL"], "key": environ["DURABLE_TASK_KEY"]}]
    batch = _json_targets(environ, "AZURE_BATCH_TARGETS")
    if batch is None and environ.get("AZURE_BATCH_ENDPOINT") and environ.get("AZURE_BATCH_JOBS"):
        batch = [{"name": "default", "endpoint": environ["AZURE_BATCH_ENDPOINT"],
                  "jobs": [j for j in environ["AZURE_BATCH_JOBS"].split(",") if j]}]
    return durable or [], batch or []


def missing_azure_config(environ=os.environ):
    try:
        durable, batch = azure_targets(environ)
    except (ValueError, json.JSONDecodeError) as exc:
        return [str(exc)]
    missing = []
    if not durable or any(not t.get("name") or not t.get("base") or not t.get("key") for t in durable):
        missing.append("complete Durable target(s)")
    if not batch or any(not t.get("name") or not t.get("endpoint") or not t.get("jobs") for t in batch):
        missing.append("complete Batch target(s)")
    if not environ.get("AZURE_SUBSCRIPTION_ID"):
        missing.append("AZURE_SUBSCRIPTION_ID (scheduled job executions)")
    return missing


def aws_counts():
    import boto3
    sfn, batch = boto3.client("stepfunctions", region_name=REGION), boto3.client("batch", region_name=REGION)
    out = {}
    for m in MACHINES:
        arn = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:{m}"
        pages = sfn.get_paginator("list_executions").paginate(stateMachineArn=arn, statusFilter="RUNNING")
        out[f"aws.sfn.{m}"] = sum(len(p["executions"]) for p in pages)
    queue = os.environ.get("BATCH_JOB_QUEUE", "chai-q-queue")
    out["aws.batch.active"] = sum(
        len(p["jobSummaryList"]) for s in BATCH_ACTIVE
        for p in batch.get_paginator("list_jobs").paginate(jobQueue=queue, jobStatus=s))
    return out


def azure_counts():
    out = {}
    durable_targets, batch_targets = azure_targets()
    for target in durable_targets:
        base, key, name = target["base"], target["key"], target["name"]
        url = f"{base}/runtime/webhooks/durabletask/instances?runtimeStatus=Running,Pending,Suspended,ContinuedAsNew&top=1000&code={key}"
        with urllib.request.urlopen(url, timeout=30) as r:
            out[f"azure.durable.{name}.running"] = len(json.load(r))
    if batch_targets:
        from azure.batch import BatchClient
        from azure.identity import DefaultAzureCredential
        credential = DefaultAzureCredential()
        for target in batch_targets:
            client = BatchClient(target["endpoint"], credential)
            for job in target["jobs"]:
                out[f"azure.batch.{target['name']}.{job}"] = sum(
                    1 for _ in client.list_tasks(job, filter="state ne 'completed'"))
    out.update(job_execution_counts())
    return out


def job_execution_counts(environ=os.environ, client=None):
    """Running Container Apps Job executions (e.g. a resigner sweep still writing showcache)."""
    sub = environ.get("AZURE_SUBSCRIPTION_ID")
    if not sub and client is None:
        return {}
    rg = environ.get("AZURE_RESOURCE_GROUP", "rg-bitrater-prod")
    if client is None:
        from azure.identity import DefaultAzureCredential
        from azure.mgmt.appcontainers import ContainerAppsAPIClient
        client = ContainerAppsAPIClient(DefaultAzureCredential(), sub)
    out = {}
    for job in client.jobs.list_by_resource_group(rg):
        if job.name.startswith("acaj-bitrater-"):
            out[f"azure.job.{job.name}.running"] = sum(
                1 for _ in client.jobs_executions.list(rg, job.name, filter="status eq 'Running'"))
    return out


def mongo_counts():
    import pymongo
    db = os.environ.get("DB_LAB", "chai_q_lab")
    client = pymongo.MongoClient(os.environ["MONGO_URI"], readPreference="secondaryPreferred")
    return {f"mongo.{db}.pipeline_runs.RUNNING": client[db].pipeline_runs.count_documents({"status": "RUNNING"})}


def main(argv):
    require_azure = "--require-azure" in argv
    if require_azure and "--skip-azure" in argv:
        print("ERROR --require-azure cannot be combined with --skip-azure", file=sys.stderr)
        return 2
    if require_azure:
        missing = missing_azure_config()
        if missing:
            print("ERROR required Azure freeze checks are not configured: " + ", ".join(missing), file=sys.stderr)
            return 2
    counts = {}
    if "--skip-aws" not in argv:
        counts.update(aws_counts())
    if "--skip-azure" not in argv:
        counts.update(azure_counts())
    counts.update(mongo_counts())
    for k, v in counts.items():
        print(f"{'OK ' if v == 0 else 'BUSY'} {k} = {v}")
    busy = {k: v for k, v in counts.items() if v}
    print("FREEZE OK — nothing in flight" if not busy else f"NOT FROZEN — {len(busy)} check(s) busy")
    return 0 if not busy else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
