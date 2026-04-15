import clientPromise from '@/lib/mongodb';
import { orchestrate } from '@/lib/pipelineOrchestrator';

/**
 * Called on server startup via instrumentation.ts.
 * Scans for pipeline_runs with status=RUNNING and re-spawns the orchestrator
 * for each one. The orchestrator itself will acquire the lock, so concurrent
 * calls are safe — only one instance will win per run.
 */
export async function recoverOrphanedPipelines() {
  try {
    const client = await clientPromise();
    const col = client.db('chai_q_lab').collection('pipeline_runs');

    const orphans = await col.find({ status: 'RUNNING' }).toArray();
    if (orphans.length === 0) return;

    console.log(`[pipelineRecovery] Found ${orphans.length} RUNNING pipeline(s) — attempting recovery`);

    for (const run of orphans) {
      const runIdStr = String(run._id);
      setImmediate(() => {
        orchestrate(runIdStr).catch(err => {
          console.error(`[pipelineRecovery] Error recovering run ${runIdStr}:`, err);
        });
      });
    }
  } catch (err) {
    console.error('[pipelineRecovery] Failed to query orphaned pipelines:', err);
  }
}
