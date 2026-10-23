import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SFNClient, StopExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { BatchClient, TerminateJobCommand } from '@aws-sdk/client-batch';

vi.mock('@/lib/cloud/azureToken', () => ({ azureToken: async () => 'tok' }));
const sfnMock = mockClient(SFNClient);
const batchMock = mockClient(BatchClient);

async function load(mod, env = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import(mod);
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); sfnMock.reset(); batchMock.reset(); });

describe('shadow never touches AWS by stored id', () => {
  it('describe/stop/terminate refuse AWS ids when SHADOW_MODE=true', async () => {
    const wf = await load('@/lib/workflows', { SHADOW_MODE: 'true', CLOUD_PROVIDER: 'azure' });
    await expect(wf.describeWorkflow('arn:aws:states:us-east-1:1:execution:x:y')).rejects.toThrow('shadow');
    await expect(wf.stopWorkflow('arn:aws:states:x', 'c')).rejects.toThrow('shadow');
    const jobs = await load('@/lib/jobs', { SHADOW_MODE: 'true', CLOUD_PROVIDER: 'azure' });
    await expect(jobs.terminateJob('4b1f-uuid', 'r')).rejects.toThrow('shadow');
    await expect(jobs.describeJobs(['4b1f-uuid'])).rejects.toThrow('shadow');
    expect(sfnMock.calls()).toHaveLength(0);
    expect(batchMock.calls()).toHaveLength(0);
  });

  it('prod/bridge still reaches AWS ids (revert path)', async () => {
    const wf = await load('@/lib/workflows', { CLOUD_PROVIDER: 'azure' });
    sfnMock.on(StopExecutionCommand).resolves({});
    sfnMock.on(DescribeExecutionCommand).resolves({ status: 'RUNNING' });
    await wf.stopWorkflow('arn:aws:states:x', 'c');
    expect((await wf.describeWorkflow('arn:aws:states:x')).status).toBe('RUNNING');
    const jobs = await load('@/lib/jobs', { CLOUD_PROVIDER: 'azure' });
    batchMock.on(TerminateJobCommand).resolves({});
    await jobs.terminateJob('4b1f-uuid', 'r');
    expect(batchMock.commandCalls(TerminateJobCommand)).toHaveLength(1);
  });
});

describe('Azure Batch paging keeps the service encoding', () => {
  it('follows odata.nextLink verbatim except api-version', async () => {
    const jobs = await load('@/lib/jobs', {
      CLOUD_PROVIDER: 'azure', AZURE_BATCH_ENDPOINT: 'https://acct.centralindia.batch.azure.com', AZURE_BATCH_LAB_JOB: 'chai-q-lab-shadow',
    });
    const next = "https://acct.centralindia.batch.azure.com/jobs/chai-q-lab-shadow/tasks?api-version=2024-07-01.20.0&$filter=state%20ne%20'completed'&$skiptoken=abc%3D";
    const urls = [];
    const pages = [{ value: [{ id: 't1', state: 'running' }], 'odata.nextLink': next }, { value: [{ id: 't2', state: 'active' }] }];
    vi.stubGlobal('fetch', vi.fn(async (url) => { urls.push(String(url)); return new Response(JSON.stringify(pages.shift())); }));
    const got = await jobs.listActiveJobs('lab', { statuses: ['RUNNING', 'RUNNABLE'] });
    expect(got.map((j) => j.jobId)).toEqual(['azb:chai-q-lab-shadow/t1', 'azb:chai-q-lab-shadow/t2']);
    expect(urls[1]).toBe("https://acct.centralindia.batch.azure.com/jobs/chai-q-lab-shadow/tasks?$filter=state%20ne%20'completed'&$skiptoken=abc%3D&api-version=2024-07-01.20.0");
  });
});

describe('uploads finish on the account/container in the token', () => {
  it('publicBlobUrl uses the token target', async () => {
    const { publicBlobUrl } = await load('@/lib/blobUpload');
    expect(publicBlobUrl('uploads/x.mp4', { account: 'bitratershadowup', container: 'uploads-shadow' }))
      .toBe('https://bitratershadowup.blob.core.windows.net/uploads-shadow/uploads/x.mp4');
  });
});

describe('signing/resign full sweep', () => {
  it('on Azure: fire-and-forget 202 (no 230 s front-end timeout)', async () => {
    vi.resetModules();
    vi.stubEnv('CLOUD_PROVIDER', 'azure');
    vi.stubEnv('FUNCTIONS_BASE_URL', 'https://fa.example');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => { calls.push(String(url)); return new Response('{"executionId":"azdf:invoke_async:1"}', { status: 202 }); }));
    const { POST } = await import('@/app/api/signing/resign/route');
    const res = await POST(new Request('http://x/api/signing/resign', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(202);
    expect(calls[0]).toContain('/api/invoke/resign-playback-urls?mode=async');
  });
});

describe('active-run capacity follows the selected Batch provider', () => {
  it('reports Azure by its configured pool ceiling instead of hard-coded AWS 128', async () => {
    vi.resetModules();
    vi.stubEnv('CLOUD_PROVIDER', 'azure');
    vi.stubEnv('LAB_COMPUTE_PROVIDER', 'azure');
    vi.stubEnv('LAB_WORKER_CAPACITY', '1');
    const emptyCollection = { find: () => ({ toArray: async () => [] }) };
    vi.doMock('@/lib/mongodb', () => ({
      default: async () => ({ db: () => ({ collection: () => emptyCollection }) }),
    }));
    vi.doMock('@/lib/jobs', () => ({
      listActiveJobs: async (_kind, { statuses }) => statuses.includes('RUNNING')
        ? [{ jobId: 'azb:chai-q-lab-shadow/t1' }]
        : [],
      describeJobs: async () => [{
        status: 'RUNNING', environment: { EPISODE_ID: 'e1', CODEC: 'libx264' },
      }],
    }));
    const { GET } = await import('@/app/api/show-status/active-runs/route');
    const body = await (await GET()).json();
    expect(body.workers.compute).toEqual({ provider: 'azure', used: 1, total: 1, left: 0 });
    expect(body.reruns[0]).toMatchObject({ compute_h264: 1, compute_running: 1 });
    vi.doUnmock('@/lib/mongodb');
    vi.doUnmock('@/lib/jobs');
  });
});
