// Submit / describe / list / terminate worker jobs on AWS Batch or Azure Batch.
//
// Callers pass the exact AWS values they always used (job queue, definition,
// environment). On AWS the same Batch commands are sent. On Azure a task is
// added to a long-lived Batch job per kind (AZURE_BATCH_<KIND>_JOB) running
// AZURE_BATCH_<KIND>_IMAGE, and an `azb:<job>/<task>` id is returned.
// Statuses are reported in AWS vocabulary; describe/terminate route by id.
import {
  BatchClient,
  SubmitJobCommand,
  DescribeJobsCommand,
  ListJobsCommand,
  TerminateJobCommand,
} from '@aws-sdk/client-batch';
import { CLOUD_PROVIDER } from '@/lib/config';
import { providerOfId, parseBatchId, assertIdAllowed } from '@/lib/cloud/ids';
import { azureToken } from '@/lib/cloud/azureToken';

const BATCH_SCOPE = 'https://batch.core.windows.net/.default';
const API = 'api-version=2024-07-01.20.0';

// Env copied into every Azure task (e.g. DB_LAB so a shadow lab can never write prod).
const PASSTHROUGH = ['DB_LAB', 'SHADOW_MODE', 'KEY_VAULT_URL', 'MONGO_URI_KV_SECRET', 'AWS_S3_KEY_KV_SECRET', 'AZURE_CLIENT_ID_BATCH'];
const WALL_CLOCK = { lab: 'PT20H', visqol: 'PT1H' }; // AWS job defs: 72000 s / 3600 s
export const TASK_RETENTION = 'PT1H'; // keep in sync with orchestrator/batch_jobs.py TASK_RETENTION_HOURS

let awsClient;
function aws() {
  if (!awsClient) awsClient = new BatchClient({ region: process.env.AWS_REGION || 'us-east-1' });
  return awsClient;
}

export function mapAzureTaskState(task) {
  switch (task.state) {
    case 'active': return 'RUNNABLE';
    case 'preparing': return 'STARTING';
    case 'running': return 'RUNNING';
    case 'completed': return task.executionInfo?.result === 'success' ? 'SUCCEEDED' : 'FAILED';
    default: return 'RUNNABLE';
  }
}

const azureJobFor = (kind) => process.env[`AZURE_BATCH_${kind.toUpperCase()}_JOB`];

async function azureFetch(path, init = {}) {
  const token = await azureToken(BATCH_SCOPE);
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${process.env.AZURE_BATCH_ENDPOINT}${path}${sep}${API}`, {
    signal: AbortSignal.timeout(30_000),
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; odata=minimalmetadata', ...(init.headers || {}) },
  });
}

// Error message a route should return if jobs can't be submitted, or null.
// (AWS callers keep their own BATCH_JOB_QUEUE / *_JOB_DEFINITION checks.)
export function jobsConfigError(kind) {
  if (CLOUD_PROVIDER === 'azure') {
    const K = kind.toUpperCase();
    return process.env.AZURE_BATCH_ENDPOINT && azureJobFor(kind) && process.env[`AZURE_BATCH_${K}_IMAGE`]
      ? null
      : `AZURE_BATCH_ENDPOINT/AZURE_BATCH_${K}_JOB/AZURE_BATCH_${K}_IMAGE not configured`;
  }
  return null;
}

// Returns the job id (AWS uuid, or azb:<job>/<task>).
export async function submitJob(kind, { jobName, jobQueue, jobDefinition, containerOverrides }) {
  if (CLOUD_PROVIDER !== 'azure') {
    const res = await aws().send(new SubmitJobCommand({ jobName, jobQueue, jobDefinition, containerOverrides }));
    return res.jobId;
  }
  const job = azureJobFor(kind);
  const env = [...(containerOverrides?.environment || [])];
  for (const name of PASSTHROUGH) {
    if (process.env[name] !== undefined && !env.some((e) => e.name === name)) env.push({ name, value: process.env[name] });
  }
  const id = jobName.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  const res = await azureFetch(`/jobs/${encodeURIComponent(job)}/tasks`, {
    method: 'POST',
    body: JSON.stringify({
      id,
      displayName: jobName.slice(0, 1024),
      commandLine: process.env.AZURE_BATCH_COMMAND_LINE || 'python /var/task/azure_entry.py',
      containerSettings: {
        imageName: process.env[`AZURE_BATCH_${kind.toUpperCase()}_IMAGE`],
        containerRunOptions: '--rm',
        workingDirectory: 'containerImageDefault',
      },
      environmentSettings: env,
      // No platform retries: callers retry themselves, as on AWS.
      // Short retention: the task dir sits on the node's shared temp disk (default is 7 days).
      constraints: { maxWallClockTime: WALL_CLOCK[kind] || 'PT20H', maxTaskRetryCount: 0, retentionTime: TASK_RETENTION },
    }),
  });
  if (!res.ok) throw new Error(`Azure Batch addTask failed: HTTP ${res.status} ${await res.text()}`);
  return `azb:${job}/${id}`;
}

// Returns [{ jobId, jobName, status, environment: {NAME: value} }]; unknown ids omitted.
export async function describeJobs(jobIds) {
  jobIds.forEach(assertIdAllowed);
  const out = [];
  const awsIds = jobIds.filter((id) => providerOfId(id) === 'aws');
  for (let i = 0; i < awsIds.length; i += 100) {
    const res = await aws().send(new DescribeJobsCommand({ jobs: awsIds.slice(i, i + 100) }));
    for (const j of res.jobs || []) {
      const environment = {};
      for (const e of j.container?.environment || []) environment[e.name] = e.value;
      out.push({ jobId: j.jobId, jobName: j.jobName, status: j.status, environment });
    }
  }
  // Azure: one GET per task, 16 at a time (parallelResolLab polls ~120 every 10 s).
  const azureIds = jobIds.filter((x) => providerOfId(x) === 'azure');
  for (let i = 0; i < azureIds.length; i += 16) {
    const got = await Promise.all(azureIds.slice(i, i + 16).map(async (id) => {
      const { job, task } = parseBatchId(id);
      const res = await azureFetch(`/jobs/${encodeURIComponent(job)}/tasks/${encodeURIComponent(task)}?$select=id,displayName,state,executionInfo,environmentSettings`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Azure Batch getTask failed: HTTP ${res.status}`);
      const t = await res.json();
      const environment = {};
      for (const e of t.environmentSettings || []) environment[e.name] = e.value;
      return { jobId: id, jobName: t.displayName || task, status: mapAzureTaskState(t), environment };
    }));
    out.push(...got.filter(Boolean));
  }
  return out;
}

// Active jobs in the given AWS statuses, from every configured cloud: the AWS
// queue if `jobQueue` is given, plus the Azure job for `kind` if configured.
// Per-status list errors are swallowed (callers treat this as best effort),
// unless `throwOnError` is set.
export async function listActiveJobs(kind, { jobQueue, statuses, throwOnError = false }) {
  const out = [];
  if (jobQueue) {
    for (const status of statuses) {
      let nextToken;
      do {
        let res;
        try {
          res = await aws().send(new ListJobsCommand({ jobQueue, jobStatus: status, nextToken, maxResults: 100 }));
        } catch (err) {
          if (throwOnError) throw err;
          break;
        }
        for (const j of res.jobSummaryList || []) out.push({ jobId: j.jobId, jobName: j.jobName, status });
        nextToken = res.nextToken;
      } while (nextToken);
    }
  }
  const job = azureJobFor(kind);
  if (job && process.env.AZURE_BATCH_ENDPOINT) {
    const wanted = new Set(statuses);
    let path = `/jobs/${encodeURIComponent(job)}/tasks?$filter=${encodeURIComponent("state ne 'completed'")}&$select=id,displayName,state`;
    try {
      while (path) {
        const res = await azureFetch(path);
        if (!res.ok) throw new Error(`Azure Batch listTasks failed: HTTP ${res.status}`);
        const body = await res.json();
        for (const t of body.value || []) {
          const status = mapAzureTaskState(t);
          if (wanted.has(status)) out.push({ jobId: `azb:${job}/${t.id}`, jobName: t.displayName || t.id, status });
        }
        const next = body['odata.nextLink'];
        // Keep the service's own encoding of $filter/$skiptoken; only drop api-version
        // (azureFetch re-adds it) and the host.
        path = next
          ? next.replace(/^https?:\/\/[^/]+/, '').replace(/([?&])api-version=[^&]*(&|$)/, (m, a, b) => (b ? a : ''))
          : null;
      }
    } catch (err) {
      if (throwOnError) throw err;
    }
  }
  return out;
}

export async function terminateJob(jobId, reason) {
  assertIdAllowed(jobId);
  if (providerOfId(jobId) === 'aws') {
    await aws().send(new TerminateJobCommand({ jobId, reason }));
    return;
  }
  const { job, task } = parseBatchId(jobId);
  const res = await azureFetch(`/jobs/${encodeURIComponent(job)}/tasks/${encodeURIComponent(task)}/terminate`, { method: 'POST' });
  if (!res.ok && res.status !== 409) throw new Error(`Azure Batch terminate failed: HTTP ${res.status}`);
}
