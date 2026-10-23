export const dynamic = 'force-dynamic';

export async function GET(request) {
  const deep = new URL(request.url).searchParams.get('deep') === '1';
  if (!deep) {
    // Liveness must not restart on a dependency outage, but a misconfigured shadow
    // stamp must never look healthy (no-op unless SHADOW_MODE=true).
    const { isolationViolations } = await import('@/lib/config');
    const problems = isolationViolations();
    if (problems.length) return Response.json({ status: 'isolation-failed', problems }, { status: 503 });
    return Response.json({ status: 'ok' });
  }
  // On Azure only /api/health bypasses Easy Auth (availability probe); the deep check
  // reveals config/dependency details, so it still needs a signed-in principal. Easy
  // Auth sets this header itself and strips any client-supplied copy.
  if (process.env.EASY_AUTH_ENABLED === 'true' && !request.headers.get('x-ms-client-principal')) {
    return Response.json({ status: 'unauthorized' }, { status: 401 });
  }
  try {
    const [{ default: clientPromise }, { DB_MASTER, CLOUD_PROVIDER }] = await Promise.all([
      import('@/lib/mongodb'),
      import('@/lib/config'),
    ]);
    const client = await clientPromise();
    await client.db(DB_MASTER).command({ ping: 1 });
    const configured = CLOUD_PROVIDER === 'azure'
      ? Boolean(process.env.DURABLE_BASE_URL && process.env.DURABLE_TASK_KEY && process.env.AZURE_BATCH_ENDPOINT)
      : Boolean(process.env.SFN_ARN_H264 && process.env.BATCH_JOB_QUEUE);
    if (!configured) throw new Error(`${CLOUD_PROVIDER} pipeline configuration is incomplete`);
    return Response.json({ status: 'ready', mongo: 'ok', provider: CLOUD_PROVIDER });
  } catch (error) {
    return Response.json({ status: 'not-ready', error: error.message }, { status: 503 });
  }
}
