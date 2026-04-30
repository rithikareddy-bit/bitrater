import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import clientPromise from '@/lib/mongodb';

const STOP_LAB_BASE = typeof process !== 'undefined'
  ? (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`)
  : 'http://localhost:3000';

const sfn = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Fields the Run Pipeline snapshot stores per episode. Must stay in sync with
// PRIOR_STATE_PROJECTION in /api/auto-pipeline/start. We enumerate explicitly
// (instead of Object.entries(prior)) so a snapshot field that was ABSENT in
// the original video_episodes doc still gets $unset on restore — otherwise
// /api/push's writes (e.g. lab_status='RUNNING') would persist forever.
const RESTORE_FIELDS = [
  'lab_status_h264',
  'lab_status_h265',
  'golden_recipes',
  'gcp_job_status_h264',
  'gcp_job_status_h265',
  'h264_master_m3u8_url',
  'h265_master_m3u8_url',
  'combined_master_m3u8_url',
  'quality_check',
];

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
    // Only force-rerun (Run Pipeline) runs are destructive and need restore.
    // Continue Lab (force=false) is read-only on prior video_episodes state.
    const isForceRun = run.force_rerun === true;
    let stoppedLabs = 0;
    let stoppedGcp = 0;
    let restoredEpisodes = 0;

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
    // Build restore plans as we iterate; execute them only AFTER stop-lab
    // completes so the restore overwrites stop-lab's FAILED writeback.
    const restorePlans = [];

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

      // Stop running GCP Step Functions per codec (their completion writes
      // h*_master_m3u8_url to video_episodes, which would clobber the restore).
      const gcpDoc = gcpArnByEp.get(ep.episode_id);
      if (gcpDoc?.gcp_execution_arn_h264 &&
          (ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING')) {
        stopPromises.push(stopGcpExecution(gcpDoc.gcp_execution_arn_h264).then(ok => { if (ok) stoppedGcp++; }));
      }
      if (gcpDoc?.gcp_execution_arn_h265 &&
          (ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING')) {
        stopPromises.push(stopGcpExecution(gcpDoc.gcp_execution_arn_h265).then(ok => { if (ok) stoppedGcp++; }));
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

      // Plan a restore for force-rerun runs. Run Pipeline destroys lab status,
      // golden_recipes, GCP/combine URLs, and quality_check via /api/push,
      // /api/gcp, /api/create-combined-master, /api/quality-check. Restoring
      // here means the show looks exactly as it did before Run Pipeline.
      // - prior is an object → $set its fields, $unset any missing canonical field.
      // - prior is null/missing (force-rerun on a never-before-run episode):
      //   /api/push upserted a doc with lab_status='RUNNING' + cleared recipes;
      //   $unset every RESTORE_FIELD so the doc returns to "as if never run".
      // Continue Lab (force=false) skips this entire block.
      if (isForceRun) {
        const prior = ep.prior_state;
        const priorIsObject = prior && typeof prior === 'object';
        const setFields = {};
        const unsetFields = {};
        for (const key of RESTORE_FIELDS) {
          const val = priorIsObject ? prior[key] : undefined;
          if (val === undefined || val === null) {
            unsetFields[key] = '';
          } else {
            setFields[key] = val;
          }
        }
        const update = {};
        if (Object.keys(setFields).length > 0) update.$set = setFields;
        if (Object.keys(unsetFields).length > 0) update.$unset = unsetFields;
        if (Object.keys(update).length > 0) {
          restorePlans.push({ episodeId: ep.episode_id, update });
        }
      }
    }

    // Wait for stop-lab to finish FIRST. /api/stop-lab writes
    // video_episodes.lab_status_${codec}='FAILED' for the labs it stops, so the
    // restore must run AFTER to overwrite that FAILED with the snapshotted
    // pre-Run-Pipeline status (typically 'COMPLETE' or null).
    await Promise.allSettled(stopPromises);

    await Promise.allSettled(restorePlans.map(({ episodeId, update }) =>
      videoEpisodesCol.updateOne({ episode_id: episodeId }, update)
        .then(() => { restoredEpisodes++; })
        .catch(err => {
          console.warn(`[auto-pipeline/cancel] restore failed for ${episodeId}:`, err?.message);
        }),
    ));

    return NextResponse.json({ ok: true, stoppedLabs, stoppedGcp, restoredEpisodes });
  } catch (err) {
    console.error('[POST /api/auto-pipeline/cancel]', err);
    return NextResponse.json({ error: 'Failed to cancel pipeline' }, { status: 500 });
  }
}
