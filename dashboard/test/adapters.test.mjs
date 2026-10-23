import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SFNClient, StartExecutionCommand, DescribeExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import { BatchClient, SubmitJobCommand, DescribeJobsCommand, ListJobsCommand, TerminateJobCommand } from '@aws-sdk/client-batch';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

vi.mock('@/lib/cloud/azureToken', () => ({ azureToken: async () => 'tok' }));

const sfnMock = mockClient(SFNClient);
const batchMock = mockClient(BatchClient);
const lambdaMock = mockClient(LambdaClient);

async function load(mod, env = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import(mod);
}
function fetchReturning(...responses) {
  const calls = [];
  const queue = [...responses];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = queue.shift() || { status: 200, body: {} };
    return new Response(r.body === undefined ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      { status: r.status });
  }));
  return calls;
}

beforeEach(() => { sfnMock.reset(); batchMock.reset(); lambdaMock.reset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('ids', () => {
  it('routes by prefix', async () => {
    const { providerOfId, parseDurableId, parseBatchId } = await load('@/lib/cloud/ids');
    expect(providerOfId('arn:aws:states:us-east-1:1:execution:x:y')).toBe('aws');
    expect(providerOfId('4b1f-uuid')).toBe('aws');
    expect(providerOfId('azdf:lab_search:abc')).toBe('azure');
    expect(providerOfId('azb:chai-q-lab/t1')).toBe('azure');
    expect(parseDurableId('azdf:gcp_transcode:gcp-x:y')).toEqual({ orchestrator: 'gcp_transcode', instanceId: 'gcp-x:y' });
    expect(parseBatchId('azb:chai-q-lab/ChaiQSearch-1')).toEqual({ job: 'chai-q-lab', task: 'ChaiQSearch-1' });
  });
});

describe('workflows — AWS path sends the same Step Functions commands', () => {
  it('start/describe/stop', async () => {
    const wf = await load('@/lib/workflows', { CLOUD_PROVIDER: 'aws', SFN_ARN_H264: 'arn:aws:states:us-east-1:1:stateMachine:Chai-Q-Orchestrator-H264' });
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:aws:states:x:exec:1' });
    sfnMock.on(DescribeExecutionCommand).resolves({ status: 'FAILED', cause: 'boom' });
    sfnMock.on(StopExecutionCommand).resolves({});
    const input = JSON.stringify({ s3_url: 's', episode_id: 'e', codec: 'h264', run_id: 'r' });
    expect(await wf.startWorkflow('lab_h264', input)).toEqual({ executionArn: 'arn:aws:states:x:exec:1' });
    expect(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input).toEqual({
      stateMachineArn: 'arn:aws:states:us-east-1:1:stateMachine:Chai-Q-Orchestrator-H264', input,
    });
    expect(await wf.describeWorkflow('arn:aws:states:x:exec:1')).toMatchObject({ status: 'FAILED', cause: 'boom' });
    await wf.stopWorkflow('arn:aws:states:x:exec:1', 'Stopped by user from dashboard');
    expect(sfnMock.commandCalls(StopExecutionCommand)[0].args[0].input).toEqual({
      executionArn: 'arn:aws:states:x:exec:1', cause: 'Stopped by user from dashboard',
    });
  });

  it('passes the execution name when given (audio routes)', async () => {
    const wf = await load('@/lib/workflows', { CLOUD_PROVIDER: 'aws', AUDIO_SFN_ARN: 'arn:a' });
    sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'x' });
    await wf.startWorkflow('audio', '{"episode_id":"e"}', { name: 'audio-ep-e-1' });
    expect(sfnMock.commandCalls(StartExecutionCommand)[0].args[0].input).toEqual({
      stateMachineArn: 'arn:a', input: '{"episode_id":"e"}', name: 'audio-ep-e-1',
    });
  });

  it('config error text is unchanged on AWS', async () => {
    const wf = await load('@/lib/workflows', { CLOUD_PROVIDER: 'aws', GCP_SFN_ARN: '' });
    expect(wf.workflowConfigError('gcp')).toBe('GCP_SFN_ARN not configured');
  });
});

describe('workflows — Azure Durable', () => {
  const env = { CLOUD_PROVIDER: 'azure', DURABLE_BASE_URL: 'https://fa-bitrater-shadow.azurewebsites.net', DURABLE_TASK_KEY: 'k' };

  it('start returns an azdf id and posts the same input', async () => {
    const wf = await load('@/lib/workflows', env);
    const calls = fetchReturning({ status: 202, body: { id: 'x' } });
    const { executionArn } = await wf.startWorkflow('gcp', '{"episode_id":"e"}');
    expect(executionArn).toMatch(/^azdf:gcp_transcode:gcp-/);
    expect(calls[0].url).toContain('/runtime/webhooks/durabletask/orchestrators/gcp_transcode/gcp-');
    expect(calls[0].url).toContain('code=k');
    expect(calls[0].init.body).toBe('{"episode_id":"e"}');
    expect(sfnMock.calls()).toHaveLength(0);
  });

  it.each([
    ['Running', 'RUNNING'], ['Pending', 'RUNNING'], ['ContinuedAsNew', 'RUNNING'],
    ['Completed', 'SUCCEEDED'], ['Failed', 'FAILED'], ['Terminated', 'ABORTED'],
  ])('maps %s -> %s', async (runtimeStatus, expected) => {
    const wf = await load('@/lib/workflows', env);
    fetchReturning({ status: 200, body: { runtimeStatus, output: 'GCP Transcoder job failed' } });
    expect((await wf.describeWorkflow('azdf:gcp_transcode:i1')).status).toBe(expected);
  });

  it('strips the Durable failure prefix so the UI cause is unchanged', async () => {
    const wf = await load('@/lib/workflows', env);
    fetchReturning({ status: 200, body: { runtimeStatus: 'Failed', output: "Orchestrator function 'gcp_transcode' failed: GCP Transcoder job failed" } });
    expect((await wf.describeWorkflow('azdf:gcp_transcode:i')).cause).toBe('GCP Transcoder job failed');
  });

  it('reads status bodies from 202 (running) and 400 (failed), as the Durable API returns them', async () => {
    const wf = await load('@/lib/workflows', env);
    fetchReturning({ status: 202, body: { runtimeStatus: 'Running' } },
      { status: 400, body: { runtimeStatus: 'Failed', output: 'GCP Transcoder job failed' } });
    expect((await wf.describeWorkflow('azdf:x:a')).status).toBe('RUNNING');
    expect(await wf.describeWorkflow('azdf:x:b')).toEqual({ status: 'FAILED', cause: 'GCP Transcoder job failed' });
  });

  it('404 throws (like ExecutionDoesNotExist); failed carries cause', async () => {
    const wf = await load('@/lib/workflows', env);
    fetchReturning({ status: 404 }, { status: 200, body: { runtimeStatus: 'Failed', output: 'GCP Transcoder job failed' } });
    await expect(wf.describeWorkflow('azdf:x:gone')).rejects.toThrow('Durable instance not found: gone');
    expect(await wf.describeWorkflow('azdf:x:f')).toEqual({ status: 'FAILED', cause: 'GCP Transcoder job failed' });
  });

  it('describe/stop of an AWS ARN still goes to AWS even when CLOUD_PROVIDER=azure (revert-safe)', async () => {
    const wf = await load('@/lib/workflows', env);
    sfnMock.on(DescribeExecutionCommand).resolves({ status: 'RUNNING' });
    sfnMock.on(StopExecutionCommand).resolves({});
    fetchReturning();
    expect((await wf.describeWorkflow('arn:aws:states:x')).status).toBe('RUNNING');
    await wf.stopWorkflow('arn:aws:states:x', 'c');
    expect(sfnMock.commandCalls(StopExecutionCommand)).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stop tolerates 410 (already finished) and throws otherwise', async () => {
    const wf = await load('@/lib/workflows', env);
    fetchReturning({ status: 410 }, { status: 500 });
    await wf.stopWorkflow('azdf:lab_search:a', 'x');
    await expect(wf.stopWorkflow('azdf:lab_search:b', 'x')).rejects.toThrow();
  });
});

describe('jobs — AWS path sends the same Batch commands', () => {
  it('submit/describe/list/terminate', async () => {
    const jobs = await load('@/lib/jobs', { CLOUD_PROVIDER: 'aws' });
    batchMock.on(SubmitJobCommand).resolves({ jobId: 'uuid-1' });
    batchMock.on(DescribeJobsCommand).resolves({ jobs: [{ jobId: 'uuid-1', jobName: 'n', status: 'RUNNING',
      container: { environment: [{ name: 'EPISODE_ID', value: 'e1' }] } }] });
    batchMock.on(ListJobsCommand).resolves({ jobSummaryList: [{ jobId: 'uuid-1', jobName: 'ChaiQSearch-e1-x' }] });
    batchMock.on(TerminateJobCommand).resolves({});
    const params = { jobName: 'ParallelResol-e-h264-1080-abc', jobQueue: 'chai-q-queue', jobDefinition: 'chai-q-worker',
      containerOverrides: { environment: [{ name: 'CODEC', value: 'libx264' }] } };
    expect(await jobs.submitJob('lab', params)).toBe('uuid-1');
    expect(batchMock.commandCalls(SubmitJobCommand)[0].args[0].input).toEqual(params);
    expect(await jobs.describeJobs(['uuid-1'])).toEqual([{ jobId: 'uuid-1', jobName: 'n', status: 'RUNNING', environment: { EPISODE_ID: 'e1' } }]);
    const listed = await jobs.listActiveJobs('lab', { jobQueue: 'chai-q-queue', statuses: ['RUNNING'] });
    expect(listed).toEqual([{ jobId: 'uuid-1', jobName: 'ChaiQSearch-e1-x', status: 'RUNNING' }]);
    await jobs.terminateJob('uuid-1', 'Stopped by user from dashboard');
    expect(batchMock.commandCalls(TerminateJobCommand)[0].args[0].input).toEqual({ jobId: 'uuid-1', reason: 'Stopped by user from dashboard' });
  });

  it('no queue and no Azure job configured -> lists nothing (stop-lab returns 0 as before)', async () => {
    const jobs = await load('@/lib/jobs', { CLOUD_PROVIDER: 'aws', AZURE_BATCH_LAB_JOB: '' });
    expect(await jobs.listActiveJobs('lab', { jobQueue: undefined, statuses: ['RUNNING'] })).toEqual([]);
    expect(batchMock.calls()).toHaveLength(0);
  });
});

describe('jobs — Azure Batch', () => {
  const env = {
    CLOUD_PROVIDER: 'azure', AZURE_BATCH_ENDPOINT: 'https://bitrater.centralindia.batch.azure.com',
    AZURE_BATCH_LAB_JOB: 'chai-q-lab-shadow', AZURE_BATCH_LAB_IMAGE: 'bitraterprodacr.azurecr.io/chai-q-worker-azure:1',
    DB_LAB: 'chai_q_lab_shadow', SHADOW_MODE: 'true',
  };

  it('submit adds a task with passthrough env and returns an azb id', async () => {
    const jobs = await load('@/lib/jobs', env);
    const calls = fetchReturning({ status: 201 });
    const id = await jobs.submitJob('lab', { jobName: 'ChaiQSearch-ep-1080-900-abc123', jobQueue: 'q', jobDefinition: 'd',
      containerOverrides: { environment: [{ name: 'BITRATE', value: '900' }] } });
    expect(id).toBe('azb:chai-q-lab-shadow/ChaiQSearch-ep-1080-900-abc123');
    const body = JSON.parse(calls[0].init.body);
    expect(calls[0].url).toContain('/jobs/chai-q-lab-shadow/tasks?api-version=');
    expect(body.containerSettings.imageName).toBe(env.AZURE_BATCH_LAB_IMAGE);
    expect(body.constraints).toEqual({ maxWallClockTime: 'PT20H', maxTaskRetryCount: 0, retentionTime: 'PT1H' });
    const e = Object.fromEntries(body.environmentSettings.map((x) => [x.name, x.value]));
    expect(e).toMatchObject({ BITRATE: '900', DB_LAB: 'chai_q_lab_shadow', SHADOW_MODE: 'true' });
    expect(calls[0].init.headers.authorization).toBe('Bearer tok');
    expect(batchMock.calls()).toHaveLength(0);
  });

  it.each([
    [{ state: 'active' }, 'RUNNABLE'], [{ state: 'preparing' }, 'STARTING'], [{ state: 'running' }, 'RUNNING'],
    [{ state: 'completed', executionInfo: { result: 'success' } }, 'SUCCEEDED'],
    [{ state: 'completed', executionInfo: { result: 'failure' } }, 'FAILED'],
  ])('maps task %j -> %s', async (task, expected) => {
    const jobs = await load('@/lib/jobs', env);
    expect(jobs.mapAzureTaskState(task)).toBe(expected);
  });

  it('describe omits 404 tasks; list merges AWS queue + Azure job', async () => {
    const jobs = await load('@/lib/jobs', env);
    batchMock.on(ListJobsCommand).resolves({ jobSummaryList: [{ jobId: 'uuid-9', jobName: 'ChaiQSearch-old' }] });
    fetchReturning(
      { status: 404 },
      { status: 200, body: { value: [{ id: 't1', displayName: 'ChaiQSearch-new', state: 'running' }] } },
    );
    expect(await jobs.describeJobs(['azb:chai-q-lab-shadow/gone'])).toEqual([]);
    const listed = await jobs.listActiveJobs('lab', { jobQueue: 'chai-q-queue', statuses: ['RUNNING'] });
    expect(listed.map((j) => j.jobId).sort()).toEqual(['azb:chai-q-lab-shadow/t1', 'uuid-9']);
  });
});

describe('invoke', () => {
  it('AWS: passes the InvokeCommand input through unchanged', async () => {
    const inv = await load('@/lib/invoke', { CLOUD_PROVIDER: 'aws' });
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, Payload: Buffer.from('{"ok":1}') });
    const params = { FunctionName: 'arn:aws:lambda:x', InvocationType: 'Event', Payload: Buffer.from('{"episode_id":"e"}') };
    await inv.invokeFunction('quality-checker', params);
    expect(lambdaMock.commandCalls(InvokeCommand)[0].args[0].input).toEqual(params);
    expect(inv.needsLambdaArn('quality-checker')).toBe(true);
  });

  it('Azure: sync/async modes and Lambda-shaped errors', async () => {
    const inv = await load('@/lib/invoke', { CLOUD_PROVIDER: 'azure', FUNCTIONS_BASE_URL: 'https://fa.example', FUNCTIONS_INVOKE_KEY: 'fk' });
    const calls = fetchReturning(
      { status: 200, body: { combined_master_m3u8_url: 'u' } },
      { status: 500, body: { errorMessage: 'bad', errorType: 'RuntimeError' } },
      { status: 202, body: { executionId: 'acaj:x/1' } },
    );
    const ok = await inv.invokeFunction('create-combined-master', { FunctionName: undefined, Payload: Buffer.from('{"episode_id":"e"}') });
    expect(JSON.parse(Buffer.from(ok.Payload).toString())).toEqual({ combined_master_m3u8_url: 'u' });
    expect(ok.FunctionError).toBeUndefined();
    expect(calls[0].url).toBe('https://fa.example/api/invoke/create-combined-master?mode=sync');
    expect(calls[0].init.headers['x-functions-key']).toBe('fk');
    const bad = await inv.invokeFunction('create-combined-master', { Payload: Buffer.from('{}') });
    expect(bad.FunctionError).toBe('Unhandled');
    expect(JSON.parse(Buffer.from(bad.Payload).toString()).errorMessage).toBe('bad');
    await inv.invokeFunction('quality-checker', { InvocationType: 'Event', Payload: Buffer.from('{}') });
    expect(calls[2].url).toContain('mode=async');
    expect(lambdaMock.calls()).toHaveLength(0);
  });

  it('Azure: invocation failures throw (like the Lambda SDK), async included', async () => {
    const inv = await load('@/lib/invoke', { CLOUD_PROVIDER: 'azure', FUNCTIONS_BASE_URL: 'https://fa.example', FUNCTIONS_INVOKE_KEY: 'stale' });
    fetchReturning(
      { status: 401 },                                        // rotated key, empty body
      { status: 403, body: 'Forbidden' },
      { status: 404, body: { errorMessage: 'unknown function' } },
      { status: 503 },
      { status: 500, body: 'host error' },                    // not a Lambda-style handler error
    );
    const event = { InvocationType: 'Event', Payload: Buffer.from('{}') };
    await expect(inv.invokeFunction('quality-checker', event)).rejects.toThrow('HTTP 401');
    await expect(inv.invokeFunction('resync-subtitles', event)).rejects.toThrow('HTTP 403');
    await expect(inv.invokeFunction('create-combined-master', { Payload: Buffer.from('{}') })).rejects.toThrow('HTTP 404');
    await expect(inv.invokeFunction('create-combined-master', { Payload: Buffer.from('{}') })).rejects.toThrow('HTTP 503');
    await expect(inv.invokeFunction('create-combined-master', { Payload: Buffer.from('{}') })).rejects.toThrow('HTTP 500');
  });

  it('per-function override keeps the resigner on AWS after the backend cutover', async () => {
    const inv = await load('@/lib/invoke', { CLOUD_PROVIDER: 'azure', INVOKE_PROVIDER_RESIGN_PLAYBACK_URLS: 'aws' });
    lambdaMock.on(InvokeCommand).resolves({ Payload: Buffer.from('{}') });
    fetchReturning();
    await inv.invokeFunction('resign-playback-urls', { FunctionName: 'arn:aws:lambda:resign', Payload: Buffer.from('{}') });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(inv.needsLambdaArn('resign-playback-urls')).toBe(true);
    expect(inv.needsLambdaArn('quality-checker')).toBe(false);
  });
});
