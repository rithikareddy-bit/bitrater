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

    const { recoverOrphanedPipelines } = await import('./lib/pipelineRecovery');
    await recoverOrphanedPipelines();

    const { startTrailerScanner } = await import('./lib/trailerScanner');
    startTrailerScanner();
  }
}
