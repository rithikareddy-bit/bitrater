import { describe, it, expect, vi, afterEach } from 'vitest';

async function load(env = {}) {
  vi.resetModules();
  for (const k of ['DB_LAB', 'DB_MASTER', 'DB_DEV', 'CLOUD_PROVIDER', 'UPLOAD_PROVIDER', 'SHADOW_MODE',
    'VTT_ENABLED', 'UPLOAD_DEV_SYNC_ENABLED']) vi.stubEnv(k, '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('@/lib/config');
}
afterEach(() => vi.unstubAllEnvs());

describe('config defaults = pre-migration behaviour', () => {
  it('uses prod names and AWS when nothing is set', async () => {
    const c = await load();
    expect([c.DB_LAB, c.DB_MASTER, c.DB_DEV]).toEqual(['chai_q_lab', 'master', 'gld2sqs']);
    expect(c.CLOUD_PROVIDER).toBe('aws');
    expect(c.UPLOAD_PROVIDER).toBe('s3');
    expect(c.SHADOW_MODE).toBe(false);
    expect(c.VTT_ENABLED).toBe(true);
    expect(c.UPLOAD_DEV_SYNC_ENABLED).toBe(true);
  });

  it('invokeProvider: per-function override beats CLOUD_PROVIDER', async () => {
    const c = await load();
    vi.stubEnv('CLOUD_PROVIDER', 'azure');
    vi.stubEnv('INVOKE_PROVIDER_RESIGN_PLAYBACK_URLS', 'aws');
    expect(c.invokeProvider('resign-playback-urls')).toBe('aws');
    expect(c.invokeProvider('quality-checker')).toBe('azure');
  });
});

describe('assertIsolation', () => {
  const good = {
    SHADOW_MODE: 'true', DB_LAB: 'chai_q_lab_shadow', DB_MASTER: 'master_shadow', MONGO_DATABASE: 'master_shadow',
    TRAILER_SCANNER_ENABLED: 'false', VTT_ENABLED: 'false', UPLOAD_DEV_SYNC_ENABLED: 'false', CLOUD_PROVIDER: 'azure',
    UPLOAD_PROVIDER: 'azure', UPLOAD_AZURE_CONTAINER: 'uploads-shadow', INVOKE_PROVIDER_RESIGN_PLAYBACK_URLS: 'azure',
  };
  it('is a no-op in prod', async () => {
    const c = await load();
    expect(() => c.assertIsolation({})).not.toThrow();
  });
  it('passes a full shadow config', async () => {
    const c = await load();
    expect(() => c.assertIsolation(good)).not.toThrow();
  });
  it.each([
    ['DB_LAB', 'chai_q_lab'], ['DB_MASTER', 'master'], ['MONGO_DATABASE', 'master'],
    ['TRAILER_SCANNER_ENABLED', 'true'], ['VTT_ENABLED', 'true'], ['UPLOAD_DEV_SYNC_ENABLED', 'true'],
    ['CLOUD_PROVIDER', 'aws'], ['INVOKE_PROVIDER_RESIGN_PLAYBACK_URLS', 'aws'], ['UPLOAD_PROVIDER', 's3'],
    ['UPLOAD_AZURE_CONTAINER', 'sanity-dev-store'],
  ])('rejects %s=%s', async (k, v) => {
    const c = await load();
    expect(() => c.assertIsolation({ ...good, [k]: v })).toThrow(k);
  });
});

describe('test-jas H264 availability', () => {
  it('stays enabled on AWS, is fail-closed on Azure, and obeys the explicit switch', async () => {
    const { testJasEnabled } = await import('@/app/api/test-jas-h264/route');
    expect(testJasEnabled({ CLOUD_PROVIDER: 'aws' })).toBe(true);
    expect(testJasEnabled({ CLOUD_PROVIDER: 'azure' })).toBe(false);
    expect(testJasEnabled({ CLOUD_PROVIDER: 'azure', TEST_JAS_H264_ENABLED: 'true' })).toBe(true);
    expect(testJasEnabled({ CLOUD_PROVIDER: 'aws', TEST_JAS_H264_ENABLED: 'false' })).toBe(false);
  });
});

describe('isolation runs where the dashboard actually executes', () => {
  it('Mongo client refuses in a misconfigured shadow stamp', async () => {
    vi.resetModules();
    vi.stubEnv('SHADOW_MODE', 'true');
    vi.stubEnv('DB_LAB', 'chai_q_lab'); // prod name in shadow
    vi.stubEnv('MONGO_URI', 'mongodb://localhost:1');
    const { default: getClientPromise } = await import('@/lib/mongodb');
    expect(() => getClientPromise()).toThrow('Shadow isolation check failed');
  });

  it('liveness probe reports 503 for a misconfigured shadow stamp, 200 otherwise', async () => {
    vi.resetModules();
    vi.stubEnv('SHADOW_MODE', 'true');
    vi.stubEnv('DB_LAB', 'chai_q_lab');
    let { GET } = await import('@/app/api/health/route');
    expect((await GET(new Request('http://x/api/health'))).status).toBe(503);
    vi.unstubAllEnvs();
    vi.resetModules();
    ({ GET } = await import('@/app/api/health/route'));
    expect((await GET(new Request('http://x/api/health'))).status).toBe(200);
  });
});
