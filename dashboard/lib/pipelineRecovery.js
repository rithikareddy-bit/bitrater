import clientPromise from '@/lib/mongodb';
import { orchestrate } from '@/lib/pipelineOrchestrator';
import { DB_LAB } from '@/lib/config';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_STALE_MS = 6 * 60 * 1000; // > orchestrate()'s 5-min stale-lock takeover
let sweepTimer;

/**
 * Called on server startup via instrumentation.ts.
 * Scans for pipeline_runs with status=RUNNING and re-spawns the orchestrator
 * for each one. The orchestrator itself will acquire the lock, so concurrent
 * calls are safe — only one instance will win per run.
 */
export async function recoverOrphanedPipelines({ staleOnly = false } = {}) {
  try {
    const client = await clientPromise();
    const col = client.db(DB_LAB).collection('pipeline_runs');

    // staleOnly (periodic sweep): only runs nobody is driving — no lock, or a lock
    // not renewed past orchestrate()'s 5-min takeover window — so a live loop
    // (renews every ~10 s) is never disturbed.
    const filter = staleOnly
      ? { status: 'RUNNING', $or: [{ locked_by: null }, { locked_at: { $lt: new Date(Date.now() - SWEEP_STALE_MS) } }] }
      : { status: 'RUNNING' };
    const orphans = await col.find(filter).toArray();
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

/**
 * Re-adopt orphaned runs periodically, not just at startup: a replica restart
 * (revision update, liveness restart, node move) can overlap with the old
 * replica still holding the lock, so the startup pass alone may find the lock
 * live and give up, leaving the run stuck at RUNNING.
 */
export function startOrphanSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    recoverOrphanedPipelines({ staleOnly: true }).catch(err => console.error('[pipelineRecovery] sweep error:', err));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  console.log(`[pipelineRecovery] orphan sweeper started — every ${SWEEP_INTERVAL_MS / 1000}s`);
}
