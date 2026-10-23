import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.doUnmock('@/lib/pipelineRecovery'); vi.doUnmock('@/lib/trailerScanner'); });

async function runRegister(env) {
  vi.resetModules();
  for (const k of ['SHADOW_MODE', 'DB_LAB', 'DB_MASTER', 'STARTUP_RECOVERY_ENABLED', 'TRAILER_SCANNER_ENABLED']) vi.stubEnv(k, '');
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const calls = [];
  vi.doMock('@/lib/pipelineRecovery', () => ({
    recoverOrphanedPipelines: async () => calls.push('recover'),
    startOrphanSweeper: () => calls.push('sweeper'),
  }));
  vi.doMock('@/lib/trailerScanner', () => ({ startTrailerScanner: () => calls.push('scanner') }));
  const { register } = await import('@/instrumentation');
  await register();
  return calls;
}

describe('instrumentation: background work is opt-in (AWS prod never ran it)', () => {
  it('does nothing without flags', async () => {
    expect(await runRegister({})).toEqual([]);
  });
  it('recovery + sweeper and the scanner run only when explicitly enabled', async () => {
    expect(await runRegister({ STARTUP_RECOVERY_ENABLED: 'true' })).toEqual(['recover', 'sweeper']);
    expect(await runRegister({ TRAILER_SCANNER_ENABLED: 'true' })).toEqual(['scanner']);
  });
  it('the hook is enabled in next.config.js', async () => {
    const cfg = (await import('@/next.config.js')).default;
    expect(cfg.experimental?.instrumentationHook).toBe(true);
  });
});

describe('orphan sweep only adopts runs nobody is driving', () => {
  it('filters on missing or stale (> 5-min takeover) locks', async () => {
    vi.resetModules();
    let filter;
    const col = { find: (f) => { filter = f; return { toArray: async () => [] }; } };
    vi.doMock('@/lib/mongodb', () => ({ default: async () => ({ db: () => ({ collection: () => col }) }) }));
    vi.doMock('@/lib/pipelineOrchestrator', () => ({ orchestrate: async () => {} }));
    const { recoverOrphanedPipelines } = await import('@/lib/pipelineRecovery');
    const before = Date.now();
    await recoverOrphanedPipelines({ staleOnly: true });
    expect(filter.status).toBe('RUNNING');
    const cutoff = filter.$or[1].locked_at.$lt.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(filter.$or[0]).toEqual({ locked_by: null });
    await recoverOrphanedPipelines();
    expect(filter).toEqual({ status: 'RUNNING' });
    vi.doUnmock('@/lib/mongodb'); vi.doUnmock('@/lib/pipelineOrchestrator');
  });
});

describe('/api/health deep check behind Easy Auth', () => {
  it('refuses ?deep=1 without a signed-in principal when Easy Auth is on', async () => {
    vi.resetModules();
    vi.stubEnv('SHADOW_MODE', '');
    vi.stubEnv('EASY_AUTH_ENABLED', 'true');
    const { GET } = await import('@/app/api/health/route');
    expect((await GET(new Request('http://x/api/health?deep=1'))).status).toBe(401);
    expect((await GET(new Request('http://x/api/health'))).status).toBe(200); // public shallow probe
  });
});
