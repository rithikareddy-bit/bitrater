// Start / describe / stop pipeline workflows on AWS Step Functions or Azure
// Durable Functions.
//
// Callers keep building the exact StartExecution input they always did. On AWS
// this sends that same command; on Azure it starts the matching Durable
// orchestrator with the same JSON input and returns an `azdf:` id, which the
// routes store in the same Mongo field (lab_execution_arn_*, *gcp_execution_arn_*).
// Describe/stop route by the id's own cloud (lib/cloud/ids.js).
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
  StopExecutionCommand,
} from '@aws-sdk/client-sfn';
import { randomUUID } from 'node:crypto';
import { CLOUD_PROVIDER } from '@/lib/config';
import { providerOfId, parseDurableId, assertIdAllowed } from '@/lib/cloud/ids';

let sfnClient;
function sfn() {
  if (!sfnClient) sfnClient = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });
  return sfnClient;
}

// kind -> [AWS state machine env var, Azure Durable orchestrator name]
export const WORKFLOWS = {
  lab_h264: ['SFN_ARN_H264', 'lab_search'],
  lab_h265: ['SFN_ARN_H265', 'lab_search'],
  gcp: ['GCP_SFN_ARN', 'gcp_transcode'],
  audio: ['AUDIO_SFN_ARN', 'audio_transcode'],
  audio_show: ['AUDIO_SHOW_BATCH_SFN_ARN', 'audio_show_batch'],
};

// Durable runtimeStatus -> Step Functions execution status vocabulary.
const DURABLE_TO_SFN = {
  Pending: 'RUNNING',
  Running: 'RUNNING',
  ContinuedAsNew: 'RUNNING',
  Suspended: 'RUNNING',
  Completed: 'SUCCEEDED',
  Failed: 'FAILED',
  Terminated: 'ABORTED',
  Canceled: 'ABORTED',
};

// Error message a route should return if the workflow can't be started, or null.
export function workflowConfigError(kind) {
  const [envVar] = WORKFLOWS[kind];
  if (CLOUD_PROVIDER === 'azure') {
    return process.env.DURABLE_BASE_URL && process.env.DURABLE_TASK_KEY
      ? null
      : 'DURABLE_BASE_URL/DURABLE_TASK_KEY not configured';
  }
  return process.env[envVar] ? null : `${envVar} not configured`;
}

function durableUrl(path, params = {}) {
  const url = new URL(`/runtime/webhooks/durabletask${path}`, process.env.DURABLE_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('code', process.env.DURABLE_TASK_KEY);
  return url;
}

// Returns { executionArn } — for Azure the value is an azdf: id.
export async function startWorkflow(kind, input, { name } = {}) {
  const [envVar, orchestrator] = WORKFLOWS[kind];
  if (CLOUD_PROVIDER !== 'azure') {
    const params = { stateMachineArn: process.env[envVar], input };
    if (name) params.name = name;
    const res = await sfn().send(new StartExecutionCommand(params));
    return { executionArn: res.executionArn };
  }
  // Short, unique ids (the SFN execution name is not reused: Durable id length limits).
  const instanceId = `${kind}-${randomUUID()}`;
  const res = await fetch(durableUrl(`/orchestrators/${orchestrator}/${encodeURIComponent(instanceId)}`), {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json' },
    body: input,
  });
  if (!res.ok) throw new Error(`Durable start ${orchestrator} failed: HTTP ${res.status} ${await res.text()}`);
  return { executionArn: `azdf:${orchestrator}:${instanceId}` };
}

// Returns { status, cause } in Step Functions vocabulary.
export async function describeWorkflow(executionArn) {
  assertIdAllowed(executionArn);
  if (providerOfId(executionArn) === 'aws') {
    const d = await sfn().send(new DescribeExecutionCommand({ executionArn }));
    return { status: d.status, cause: d.cause, error: d.error };
  }
  const { instanceId } = parseDurableId(executionArn);
  const res = await fetch(durableUrl(`/instances/${encodeURIComponent(instanceId)}`), { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return { status: 'ABORTED', cause: 'instance not found' };
  // Durable status API: 200 completed, 202 running/pending, 400 failed/terminated,
  // 500 failed (returnInternalServerErrorOnFailure). All carry the status JSON.
  if (![200, 202, 400, 500].includes(res.status)) throw new Error(`Durable status failed: HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Durable status failed: HTTP ${res.status} (no status body)`);
  }
  const status = DURABLE_TO_SFN[body.runtimeStatus] || 'RUNNING';
  let cause;
  if (status === 'FAILED') {
    cause = typeof body.output === 'string' ? body.output : JSON.stringify(body.output ?? '');
    // Keep the SFN-style cause ("GCP Transcoder job failed") the UI already shows.
    cause = cause.replace(/^Orchestrator function '[^']+' failed:\s*/, '');
  }
  return { status, cause };
}

// Throws on failure, like StopExecution (stop-lab relies on that).
export async function stopWorkflow(executionArn, cause) {
  assertIdAllowed(executionArn);
  if (providerOfId(executionArn) === 'aws') {
    await sfn().send(new StopExecutionCommand({ executionArn, cause }));
    return;
  }
  const { instanceId } = parseDurableId(executionArn);
  const res = await fetch(durableUrl(`/instances/${encodeURIComponent(instanceId)}/terminate`, { reason: cause || '' }), {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  // 410 Gone = already completed/terminated, the StopExecution-on-finished equivalent.
  if (!res.ok && res.status !== 410) throw new Error(`Durable terminate failed: HTTP ${res.status}`);
}
