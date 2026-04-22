export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { recoverOrphanedPipelines } = await import('./lib/pipelineRecovery');
    await recoverOrphanedPipelines();

    const { startTrailerScanner } = await import('./lib/trailerScanner');
    startTrailerScanner();
  }
}
