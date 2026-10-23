// Runs once per server start (next.config.js experimental.instrumentationHook).
// Background work is opt-in per flag so a deployment without the flags behaves like
// AWS prod at 6d0508f, where this file never ran:
//   STARTUP_RECOVERY_ENABLED=true  re-adopt RUNNING pipeline_runs (startup + 5-min sweep)
//   TRAILER_SCANNER_ENABLED=true   start the trailer scanner
// The shadow isolation check always runs (also enforced in lib/mongodb.js and /api/health).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Azure shadow stamp: refuse to start (before any recovery or scanner work)
    // if anything could reach prod. No-op unless SHADOW_MODE=true.
    const { assertIsolation } = await import('./lib/config');
    try {
      assertIsolation();
    } catch (err) {
      console.error('[startup]', err);
      process.exit(1); // a throw here may only be logged by Next; never run misconfigured
    }

    if (process.env.STARTUP_RECOVERY_ENABLED === 'true') {
      const { recoverOrphanedPipelines, startOrphanSweeper } = await import('./lib/pipelineRecovery');
      await recoverOrphanedPipelines();
      startOrphanSweeper();
    }

    if (process.env.TRAILER_SCANNER_ENABLED === 'true') {
      const { startTrailerScanner } = await import('./lib/trailerScanner');
      startTrailerScanner();
    }
  }
}
