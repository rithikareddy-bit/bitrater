import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';

const STOP_LAB_BASE = typeof process !== 'undefined'
  ? (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`)
  : 'http://localhost:3000';

export const dynamic = 'force-dynamic';

async function stopLabForEpisode(episodeId, codec) {
  try {
    const res = await fetch(`${STOP_LAB_BASE}/api/stop-lab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId, codec }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { runId } = body || {};
    if (!runId || typeof runId !== 'string') {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }

    let oid;
    try { oid = new ObjectId(runId); } catch {
      return NextResponse.json({ error: 'Invalid runId' }, { status: 400 });
    }

    const client = await clientPromise();
    const col = client.db('chai_q_lab').collection('pipeline_runs');

    // 1. Mark pipeline as CANCELLED
    const result = await col.updateOne(
      { _id: oid, status: 'RUNNING' },
      { $set: { status: 'CANCELLED', finished_at: new Date(), locked_by: null, locked_at: null } },
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: 'Pipeline not found or not currently running' }, { status: 409 });
    }

    // 2. Fetch the run to get episode list
    const run = await col.findOne({ _id: oid });
    if (!run || !run.episodes) {
      return NextResponse.json({ ok: true, stoppedLabs: 0 });
    }

    const nowDate = new Date();
    let stoppedLabs = 0;

    // 3. Stop all running labs and mark all non-terminal episodes as CANCELLED
    const stopPromises = [];

    for (const ep of run.episodes) {
      const isTerminal = ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED' ||
                         ep.status === 'SKIPPED' || ep.status === 'FAILED';
      if (isTerminal) continue;

      // Stop running lab Step Functions + Batch jobs
      if (ep.lab_h264_status === 'STARTING' || ep.lab_h264_status === 'RUNNING') {
        stopPromises.push(stopLabForEpisode(ep.episode_id, 'h264').then(ok => { if (ok) stoppedLabs++; }));
      }
      if (ep.lab_h265_status === 'STARTING' || ep.lab_h265_status === 'RUNNING') {
        stopPromises.push(stopLabForEpisode(ep.episode_id, 'h265').then(ok => { if (ok) stoppedLabs++; }));
      }

      // Update episode status + all sub-statuses in the pipeline_runs doc
      const cancelFields = {
        'episodes.$.status': 'CANCELLED',
        'episodes.$.error': 'Pipeline cancelled by user',
        'episodes.$.finished_at': nowDate,
        'episodes.$.last_updated_at': nowDate,
        'episodes.$.duration_ms': ep.started_at
          ? nowDate.getTime() - new Date(ep.started_at).getTime()
          : null,
      };

      // Cancel all non-complete lab/GCP sub-statuses so UI shows everything as cancelled
      if (ep.lab_h264_status !== 'COMPLETE') cancelFields['episodes.$.lab_h264_status'] = 'CANCELLED';
      if (ep.lab_h265_status !== 'COMPLETE') cancelFields['episodes.$.lab_h265_status'] = 'CANCELLED';
      if (ep.gcp_h264_status !== 'SUCCEEDED') cancelFields['episodes.$.gcp_h264_status'] = 'CANCELLED';
      if (ep.gcp_h265_status !== 'SUCCEEDED') cancelFields['episodes.$.gcp_h265_status'] = 'CANCELLED';

      await col.updateOne(
        { _id: oid, 'episodes.episode_id': ep.episode_id },
        { $set: cancelFields },
      );
    }

    // Wait for all stop-lab calls to finish (fire in parallel)
    await Promise.allSettled(stopPromises);

    return NextResponse.json({ ok: true, stoppedLabs });
  } catch (err) {
    console.error('[POST /api/auto-pipeline/cancel]', err);
    return NextResponse.json({ error: 'Failed to cancel pipeline' }, { status: 500 });
  }
}
