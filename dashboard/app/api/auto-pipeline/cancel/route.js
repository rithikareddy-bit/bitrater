import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const STOP_LAB_BASE = typeof process !== 'undefined'
  ? (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`)
  : 'http://localhost:3000';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

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

// Stop the GCP transcoder Step Function. Without this, an in-flight GCP
// execution would write a NEW h*_master_m3u8_url to video_episodes minutes
// after Cancel returned, overriding the snapshot restore.
async function stopGcpExecution(execArn) {
  if (!execArn) return false;
  try {
    await sfn.send(new StopExecutionCommand({
      executionArn: execArn,
      cause: 'Pipeline cancelled by user',
    }));
    return true;
  } catch {
    // Already terminal or transient SFN error — nothing more we can do.
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
    const labDb = client.db('chai_q_lab');
    const col = labDb.collection('pipeline_runs');
    const videoEpisodesCol = labDb.collection('video_episodes');

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
    let stoppedGcp = 0;
    // Per-episode video_episodes field writes for in-flight codecs. The episode
    // table reads lab_status_${codec} / gcp_job_status_${codec} from
    // video_episodes — stop-lab only writes 'FAILED' when an execution ARN
    // exists, and SFN stop doesn't write gcp_job_status at all. Without these
    // writes the UI keeps spinning even though the backend is stopped.
    const veWrites = new Map(); // episode_id -> { $set: {...} }
    const addVeSet = (episodeId, field, value) => {
      let plan = veWrites.get(episodeId);
      if (!plan) { plan = { $set: {} }; veWrites.set(episodeId, plan); }
      plan.$set[field] = value;
    };

    // Pre-fetch GCP execution ARNs from video_episodes for episodes whose GCP
    // is in-flight in pipeline_runs. We need these because cancel must stop
    // the GCP step functions too — otherwise GCP completes after restore and
    // writes a new h*_master_m3u8_url, leaking past the cancel.
    const gcpEpIds = run.episodes
      .filter(ep => {
        const isTerminal = ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED' ||
                           ep.status === 'SKIPPED' || ep.status === 'FAILED';
        if (isTerminal) return false;
        return ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING' ||
               ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING';
      })
      .map(ep => ep.episode_id);
    const gcpArnByEp = new Map();
    if (gcpEpIds.length > 0) {
      const docs = await videoEpisodesCol.find(
        { episode_id: { $in: gcpEpIds } },
        { projection: { episode_id: 1, gcp_execution_arn_h264: 1, gcp_execution_arn_h265: 1 } },
      ).toArray();
      for (const d of docs) gcpArnByEp.set(d.episode_id, d);
    }

    // 3. Stop all running labs and mark all non-terminal episodes as CANCELLED
    const stopPromises = [];

    for (const ep of run.episodes) {
      const isTerminal = ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED' ||
                         ep.status === 'SKIPPED' || ep.status === 'FAILED';
      if (isTerminal) continue;

      // Stop in-flight lab SFN/Batch only when there's actually a running job
      // to stop. Mark CANCELLED for every non-COMPLETE codec — including
      // QUEUED — because the run is dead and they'll never execute. Codecs
      // that already finished (COMPLETE) are preserved.
      if (ep.lab_h264_status === 'STARTING' || ep.lab_h264_status === 'RUNNING') {
        stopPromises.push(stopLabForEpisode(ep.episode_id, 'h264').then(ok => { if (ok) stoppedLabs++; }));
      }
      if (ep.lab_h264_status !== 'COMPLETE') {
        addVeSet(ep.episode_id, 'lab_status_h264', 'CANCELLED');
      }
      if (ep.lab_h265_status === 'STARTING' || ep.lab_h265_status === 'RUNNING') {
        stopPromises.push(stopLabForEpisode(ep.episode_id, 'h265').then(ok => { if (ok) stoppedLabs++; }));
      }
      if (ep.lab_h265_status !== 'COMPLETE') {
        addVeSet(ep.episode_id, 'lab_status_h265', 'CANCELLED');
      }

      // Same rule for GCP: stop only when in-flight, mark every non-SUCCEEDED
      // codec as CANCELLED.
      const gcpDoc = gcpArnByEp.get(ep.episode_id);
      if (ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING') {
        if (gcpDoc?.gcp_execution_arn_h264) {
          stopPromises.push(stopGcpExecution(gcpDoc.gcp_execution_arn_h264).then(ok => { if (ok) stoppedGcp++; }));
        }
      }
      if (ep.gcp_h264_status !== 'SUCCEEDED') {
        addVeSet(ep.episode_id, 'gcp_job_status_h264', 'CANCELLED');
      }
      if (ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING') {
        if (gcpDoc?.gcp_execution_arn_h265) {
          stopPromises.push(stopGcpExecution(gcpDoc.gcp_execution_arn_h265).then(ok => { if (ok) stoppedGcp++; }));
        }
      }
      if (ep.gcp_h265_status !== 'SUCCEEDED') {
        addVeSet(ep.episode_id, 'gcp_job_status_h265', 'CANCELLED');
      }

      // If this episode was in the COMBINING step (between create-combined-master
      // and QC verdict), video_episodes.quality_check.overall is left as 'RUNNING'
      // by /api/quality-check. The UI's qcLabel('RUNNING') renders 'Checking…'
      // forever after cancel. Clear it so the row falls back to '—'. The async
      // QC Lambda may still write a real verdict later, which is fine — it
      // overwrites the null with PASS / ISSUES_FOUND / FAILED.
      if (ep.status === 'COMBINING') {
        addVeSet(ep.episode_id, 'quality_check', null);
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

      // Mirror the video_episodes logic: cancel every non-finished codec
      // (including QUEUED), preserve only COMPLETE / SUCCEEDED.
      if (ep.lab_h264_status !== 'COMPLETE') cancelFields['episodes.$.lab_h264_status'] = 'CANCELLED';
      if (ep.lab_h265_status !== 'COMPLETE') cancelFields['episodes.$.lab_h265_status'] = 'CANCELLED';
      if (ep.gcp_h264_status !== 'SUCCEEDED') cancelFields['episodes.$.gcp_h264_status'] = 'CANCELLED';
      if (ep.gcp_h265_status !== 'SUCCEEDED') cancelFields['episodes.$.gcp_h265_status'] = 'CANCELLED';

      await col.updateOne(
        { _id: oid, 'episodes.episode_id': ep.episode_id },
        { $set: cancelFields },
      );
    }

    // Wait for stop-lab to finish before writing CANCELLED markers, so
    // stop-lab's FAILED writeback (only fired when an exec ARN exists) doesn't
    // land AFTER our CANCELLED write.
    await Promise.allSettled(stopPromises);

    if (veWrites.size > 0) {
      await Promise.allSettled(
        Array.from(veWrites.entries()).map(([episodeId, update]) =>
          videoEpisodesCol.updateOne({ episode_id: episodeId }, update).catch(err => {
            console.warn(`[auto-pipeline/cancel] video_episodes cancel write failed for ${episodeId}:`, err?.message);
          }),
        ),
      );
    }

    return NextResponse.json({ ok: true, stoppedLabs, stoppedGcp });
  } catch (err) {
    console.error('[POST /api/auto-pipeline/cancel]', err);
    return NextResponse.json({ error: 'Failed to cancel pipeline' }, { status: 500 });
  }
}
