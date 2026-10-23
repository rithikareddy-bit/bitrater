"""boto3-Batch-shaped client that runs jobs on AWS Batch or Azure Batch.

search_orchestrator.py calls submit_job / describe_jobs / terminate_job exactly as
it did on boto3. Routing:
  submit_job     -> by queue: "azb-job:<job-id>" = Azure Batch job, else AWS Batch
  describe/terminate -> by job id: "azb:<job-id>/<task-id>" = Azure, else AWS
so runs started on either cloud can always be read and stopped (revert path).

Azure tasks report AWS status vocabulary so callers need no change; only
`status` is read by search_orchestrator.
"""
import os
import re
from datetime import timedelta

AZ_QUEUE_PREFIX = "azb-job:"
TASK_RETENTION_HOURS = 1  # keep in sync with dashboard/lib/jobs.js TASK_RETENTION
AZ_ID_PREFIX = "azb:"

# Azure task state -> AWS Batch job status (all non-terminal map into
# search_orchestrator._BATCH_ACTIVE_STATES).
_AZ_STATE_TO_AWS = {"active": "RUNNABLE", "preparing": "STARTING", "running": "RUNNING"}

# Env vars copied from this process into every Azure task, e.g. DB_LAB/SHADOW_MODE
# so a shadow lab can never write VMAF rows to prod chai_q_lab.
_DEFAULT_PASSTHROUGH = "DB_LAB,SHADOW_MODE,KEY_VAULT_URL,MONGO_URI_KV_SECRET,AWS_S3_KEY_KV_SECRET,AZURE_CLIENT_ID_BATCH"


def client():
    return RoutingBatchClient()


def is_azure_id(job_id: str) -> bool:
    return str(job_id).startswith(AZ_ID_PREFIX)


def _refuse_aws_in_shadow(what) -> None:
    """Shadow must never touch AWS Batch (a copied prod id would stop a prod job);
    mirrors dashboard/lib/cloud/ids.js assertIdAllowed."""
    if os.environ.get("SHADOW_MODE", "false").lower() == "true":
        raise RuntimeError(f"shadow stamp refuses AWS Batch call for {what!r}")


def azure_task_id(job_name: str) -> str:
    """Azure task ids: <=64 chars of [A-Za-z0-9_-]. Today's job names already fit."""
    return re.sub(r"[^A-Za-z0-9_-]", "-", job_name)[:64]


def map_azure_task(task) -> str:
    state = str(getattr(task.state, "value", task.state)).lower()
    if state != "completed":
        return _AZ_STATE_TO_AWS.get(state, "RUNNABLE")
    info = getattr(task, "execution_info", None)
    result = str(getattr(getattr(info, "result", None), "value", getattr(info, "result", ""))).lower()
    return "SUCCEEDED" if result == "success" else "FAILED"


class RoutingBatchClient:
    def __init__(self, aws=None, azure=None):
        self._aws_client = aws
        self._azure_client = azure

    def _aws(self):
        if self._aws_client is None:
            import boto3

            self._aws_client = boto3.client("batch")
        return self._aws_client

    def _azure(self):
        if self._azure_client is None:
            self._azure_client = AzureBatchJobs()
        return self._azure_client

    def submit_job(self, jobName, jobQueue, jobDefinition, containerOverrides):
        if str(jobQueue).startswith(AZ_QUEUE_PREFIX):
            return self._azure().submit_job(jobName, jobQueue[len(AZ_QUEUE_PREFIX):], jobDefinition, containerOverrides)
        _refuse_aws_in_shadow(jobQueue)
        return self._aws().submit_job(
            jobName=jobName, jobQueue=jobQueue, jobDefinition=jobDefinition, containerOverrides=containerOverrides,
        )

    def describe_jobs(self, jobs):
        az_ids = [j for j in jobs if is_azure_id(j)]
        aws_ids = [j for j in jobs if not is_azure_id(j)]
        out = []
        if aws_ids:
            _refuse_aws_in_shadow(aws_ids[0])
            out += self._aws().describe_jobs(jobs=aws_ids).get("jobs", [])
        if az_ids:
            out += self._azure().describe_jobs(az_ids)
        return {"jobs": out}

    def terminate_job(self, jobId, reason):
        if is_azure_id(jobId):
            return self._azure().terminate_job(jobId, reason)
        _refuse_aws_in_shadow(jobId)
        return self._aws().terminate_job(jobId=jobId, reason=reason)


class AzureBatchJobs:
    """Azure Batch tasks inside a long-lived job per queue (e.g. chai-q-lab-shadow)."""

    def __init__(self, batch_client=None):
        self._client = batch_client

    @property
    def client(self):
        if self._client is None:
            from azure.batch import BatchClient
            from azure.identity import DefaultAzureCredential

            self._client = BatchClient(os.environ["AZURE_BATCH_ENDPOINT"], DefaultAzureCredential())
        return self._client

    @staticmethod
    def _split(job_id):
        job, _, task = job_id[len(AZ_ID_PREFIX):].partition("/")
        return job, task

    def submit_job(self, job_name, batch_job_id, image, container_overrides):
        from azure.batch import models as m

        env = {e["name"]: e["value"] for e in container_overrides.get("environment", [])}
        passthrough = os.environ.get("AZURE_BATCH_TASK_ENV_PASSTHROUGH", _DEFAULT_PASSTHROUGH)
        for name in filter(None, (n.strip() for n in passthrough.split(","))):
            if name in os.environ and name not in env:
                env[name] = os.environ[name]

        task_id = azure_task_id(job_name)
        hours = float(os.environ.get("AZURE_BATCH_MAX_WALLCLOCK_HOURS", "20"))  # AWS job def: 72000 s
        self.client.create_task(batch_job_id, m.BatchTaskCreateOptions(
            id=task_id,
            display_name=job_name[:1024],
            command_line=os.environ.get("AZURE_BATCH_COMMAND_LINE", "python /var/task/azure_entry.py"),
            container_settings=m.BatchTaskContainerSettings(
                image_name=image,
                container_run_options="--rm",
                working_directory=m.ContainerWorkingDirectory.CONTAINER_IMAGE_DEFAULT,
            ),
            environment_settings=[m.EnvironmentSetting(name=k, value=v) for k, v in env.items()],
            # No platform retries: search_orchestrator / parallelResolLab retry themselves, as on AWS.
            # Short retention: the task dir sits on the node's shared temp disk (default is 7 days).
            constraints=m.BatchTaskConstraints(max_wall_clock_time=timedelta(hours=hours), max_task_retry_count=0,
                                               retention_time=timedelta(hours=TASK_RETENTION_HOURS)),
        ))
        return {"jobId": f"{AZ_ID_PREFIX}{batch_job_id}/{task_id}", "jobName": job_name}

    def describe_jobs(self, job_ids):
        from azure.core.exceptions import ResourceNotFoundError

        out = []
        for job_id in job_ids:
            job, task_id = self._split(job_id)
            try:
                task = self.client.get_task(job, task_id)
            except ResourceNotFoundError:
                continue  # AWS omits unknown ids too
            out.append({"jobId": job_id, "jobName": task.display_name or task_id, "status": map_azure_task(task)})
        return out

    def terminate_job(self, job_id, reason):
        job, task_id = self._split(job_id)
        self.client.terminate_task(job, task_id)
