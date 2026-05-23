import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { SFNClient, StopExecutionCommand } from '@aws-sdk/client-sfn';
import { BatchClient, ListJobsCommand, TerminateJobCommand } from '@aws-sdk/client-batch';
import clientPromise from '@/lib/mongodb';

const region = process.env.AWS_REGION || 'us-east-1';
const sfn = new SFNClient({ region });
const batch = new BatchClient({ region });

const BATCH_ACTIVE_STATUSES = ['SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING'];

export const dynamic = 'force-dynamic';

// Stop one in-flight lab SFN execution. Called directly (not via
// /api/stop-lab) — an internal HTTP hop can silently fail in production
// (wrong APP_BASE_URL, sandboxed loopback) and leave the SFN running.
async function stopLabSfn(execArn) {
  if (!execArn) return false;
  try {
    await sfn.send(new StopExecutionCommand({
      executionArn: execArn,
      cause: 'Pipeline cancelled by user',
    }));
    return true;
  } catch {
    return false;
  }
}

// Terminate every active Batch job whose name starts with any episode prefix
// in `episodeIds`. Done in one pass per status (with pagination) instead of
// per-episode, so cost is O(statuses × pages) not O(episodes × statuses).
// Why prefix-based and not arn-based: there's a race in /api/push where SFN
// starts BEFORE lab_execution_arn_* is written to video_episodes. If Cancel
// snapshots video_episodes mid-window, we have no arn — but the Batch jobs
// the SFN spawned already exist and must still be killed. Prefix matching is
// the safety net.
async function terminateBatchJobsForEpisodes(episodeIds) {
  const queue = process.env.BATCH_JOB_QUEUE;
  if (!queue || episodeIds.length === 0) return 0;
  const prefixes = episodeIds.map(id => `ChaiQSearch-${id.slice(0, 24)}-`);
  let terminated = 0;
  for (const status of BATCH_ACTIVE_STATUSES) {
    let nextToken;
    do {
      let resp;
      try {
        resp = await batch.send(new ListJobsCommand({
          jobQueue: queue,
          jobStatus: status,
          nextToken,
        }));
      } catch {
        break;
      }
      for (const job of resp.jobSummaryList || []) {
        if (!job.jobName) continue;
        if (!prefixes.some(p => job.jobName.startsWith(p))) continue;
        try {
          await batch.send(new TerminateJobCommand({
            jobId: job.jobId,
            reason: 'Pipeline cancelled by user',
          }));
          terminated++;
        } catch { /* may have already finished */ }
      }
      nextToken = resp.nextToken;
    } while (nextToken);
  }
  return terminated;
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

    // Fetch live status from video_episodes for ALL non-terminal episodes.
    // pipeline_runs.episodes[] lags behind the orchestrator tick — a lab/GCP
    // can have finished (and written its real status to video_episodes) while
    // pipeline_runs still says STARTING/RUNNING. Without this check, Cancel
    // would stop nothing (the job is already done) but would still overwrite
    // the completed status with CANCELLED, hiding the bitrates/VMAFs the user
    // already got. Truth = video_episodes; pipeline_runs is just a cache.
    const liveEpIds = run.episodes
      .filter(ep => {
        const isTerminal = ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED' ||
                           ep.status === 'SKIPPED' || ep.status === 'FAILED';
        return !isTerminal;
      })
      .map(ep => ep.episode_id);
    const liveByEp = new Map();
    if (liveEpIds.length > 0) {
      const docs = await videoEpisodesCol.find(
        { episode_id: { $in: liveEpIds } },
        { projection: {
            episode_id: 1,
            lab_status_h264: 1, lab_status_h265: 1,
            lab_execution_arn_h264: 1, lab_execution_arn_h265: 1,
            gcp_job_status_h264: 1, gcp_job_status_h265: 1,
            gcp_execution_arn_h264: 1, gcp_execution_arn_h265: 1,
        } },
      ).toArray();
      for (const d of docs) liveByEp.set(d.episode_id, d);
    }

    // 3. Stop all running labs and mark all non-terminal episodes as CANCELLED
    const stopPromises = [];

    for (const ep of run.episodes) {
      const isTerminal = ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED' ||
                         ep.status === 'SKIPPED' || ep.status === 'FAILED';
      if (isTerminal) continue;

      // Read live truth from video_episodes. If a codec is already COMPLETE /
      // SUCCEEDED there, it's done regardless of what pipeline_runs says —
      // skip stopping it AND skip the CANCELLED writeback so we don't bury
      // real bitrates/VMAF the user already earned.
      const live = liveByEp.get(ep.episode_id);
      const labH264Done = live?.lab_status_h264 === 'COMPLETE';
      const labH265Done = live?.lab_status_h265 === 'COMPLETE';
      const gcpH264Done = live?.gcp_job_status_h264 === 'SUCCEEDED';
      const gcpH265Done = live?.gcp_job_status_h265 === 'SUCCEEDED';

      // Decide what to stop from LIVE video_episodes state, not pipeline_runs
      // ep.lab_h*_status — the latter lags by up to one orchestrator tick, so a
      // job that started seconds before Cancel could still read as QUEUED here
      // and be skipped, leaving the SFN/Batch running. The presence of an
      // execution ARN combined with a non-terminal live status is the real
      // signal that something is in flight.
      const liveLab264 = live?.lab_status_h264;
      const liveLab265 = live?.lab_status_h265;
      const liveGcp264 = live?.gcp_job_status_h264;
      const liveGcp265 = live?.gcp_job_status_h265;
      const labTerminal = s => s === 'COMPLETE' || s === 'FAILED' || s === 'CANCELLED';
      const gcpTerminal = s => s === 'SUCCEEDED' || s === 'FAILED' || s === 'CANCELLED';

      if (!labH264Done && live?.lab_execution_arn_h264 && !labTerminal(liveLab264)) {
        stopPromises.push(stopLabSfn(live.lab_execution_arn_h264)
          .then(ok => { if (ok) stoppedLabs++; }));
      }
      if (!labH264Done && ep.lab_h264_status !== 'COMPLETE') {
        addVeSet(ep.episode_id, 'lab_status_h264', 'CANCELLED');
      }
      if (!labH265Done && live?.lab_execution_arn_h265 && !labTerminal(liveLab265)) {
        stopPromises.push(stopLabSfn(live.lab_execution_arn_h265)
          .then(ok => { if (ok) stoppedLabs++; }));
      }
      if (!labH265Done && ep.lab_h265_status !== 'COMPLETE') {
        addVeSet(ep.episode_id, 'lab_status_h265', 'CANCELLED');
      }

      if (!gcpH264Done && live?.gcp_execution_arn_h264 && !gcpTerminal(liveGcp264)) {
        stopPromises.push(stopGcpExecution(live.gcp_execution_arn_h264)
          .then(ok => { if (ok) stoppedGcp++; }));
      }
      if (!gcpH264Done && ep.gcp_h264_status !== 'SUCCEEDED') {
        addVeSet(ep.episode_id, 'gcp_job_status_h264', 'CANCELLED');
      }
      if (!gcpH265Done && live?.gcp_execution_arn_h265 && !gcpTerminal(liveGcp265)) {
        stopPromises.push(stopGcpExecution(live.gcp_execution_arn_h265)
          .then(ok => { if (ok) stoppedGcp++; }));
      }
      if (!gcpH265Done && ep.gcp_h265_status !== 'SUCCEEDED') {
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
      // (including QUEUED), preserve only COMPLETE / SUCCEEDED. If
      // video_episodes already shows terminal-success, fast-forward
      // pipeline_runs to match instead of overwriting with CANCELLED.
      if (labH264Done) cancelFields['episodes.$.lab_h264_status'] = 'COMPLETE';
      else if (ep.lab_h264_status !== 'COMPLETE') cancelFields['episodes.$.lab_h264_status'] = 'CANCELLED';
      if (labH265Done) cancelFields['episodes.$.lab_h265_status'] = 'COMPLETE';
      else if (ep.lab_h265_status !== 'COMPLETE') cancelFields['episodes.$.lab_h265_status'] = 'CANCELLED';
      if (gcpH264Done) cancelFields['episodes.$.gcp_h264_status'] = 'SUCCEEDED';
      else if (ep.gcp_h264_status !== 'SUCCEEDED') cancelFields['episodes.$.gcp_h264_status'] = 'CANCELLED';
      if (gcpH265Done) cancelFields['episodes.$.gcp_h265_status'] = 'SUCCEEDED';
      else if (ep.gcp_h265_status !== 'SUCCEEDED') cancelFields['episodes.$.gcp_h265_status'] = 'CANCELLED';

      await col.updateOne(
        { _id: oid, 'episodes.episode_id': ep.episode_id },
        { $set: cancelFields },
      );
    }

    // Wait for SFN stops to finish before the safety-net Batch sweep, so
    // SFN-driven terminal callbacks don't race the CANCELLED writes below.
    await Promise.allSettled(stopPromises);

    // Safety net for two races:
    //  (a) /api/push starts SFN BEFORE writing lab_execution_arn_* — if Cancel
    //      snapshots video_episodes in that window we miss the SFN arn entirely
    //      and the Batch jobs it spawns would orphan.
    //  (b) Orchestrator's isCancelled() check fires BEFORE /api/push; a lab can
    //      start during cancel's stop loop and our snapshot won't have its arn.
    // Re-fetch arns and terminate-by-Batch-name-prefix to catch both.
    const nonTerminalEpIds = run.episodes
      .filter(ep => {
        const isT = ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED' ||
                    ep.status === 'SKIPPED' || ep.status === 'FAILED';
        return !isT;
      })
      .map(ep => ep.episode_id);

    if (nonTerminalEpIds.length > 0) {
      const lateDocs = await videoEpisodesCol.find(
        { episode_id: { $in: nonTerminalEpIds } },
        { projection: {
            episode_id: 1,
            lab_execution_arn_h264: 1, lab_execution_arn_h265: 1,
            lab_status_h264: 1, lab_status_h265: 1,
            gcp_execution_arn_h264: 1, gcp_execution_arn_h265: 1,
            gcp_job_status_h264: 1, gcp_job_status_h265: 1,
        } },
      ).toArray();

      const lateLabTerminal = s => s === 'COMPLETE' || s === 'FAILED' || s === 'CANCELLED';
      const lateGcpTerminal = s => s === 'SUCCEEDED' || s === 'FAILED' || s === 'CANCELLED';
      const latePromises = [];
      for (const d of lateDocs) {
        const seenLab264 = liveByEp.get(d.episode_id)?.lab_execution_arn_h264;
        const seenLab265 = liveByEp.get(d.episode_id)?.lab_execution_arn_h265;
        const seenGcp264 = liveByEp.get(d.episode_id)?.gcp_execution_arn_h264;
        const seenGcp265 = liveByEp.get(d.episode_id)?.gcp_execution_arn_h265;
        if (d.lab_execution_arn_h264 && d.lab_execution_arn_h264 !== seenLab264 &&
            !lateLabTerminal(d.lab_status_h264)) {
          latePromises.push(stopLabSfn(d.lab_execution_arn_h264).then(ok => { if (ok) stoppedLabs++; }));
        }
        if (d.lab_execution_arn_h265 && d.lab_execution_arn_h265 !== seenLab265 &&
            !lateLabTerminal(d.lab_status_h265)) {
          latePromises.push(stopLabSfn(d.lab_execution_arn_h265).then(ok => { if (ok) stoppedLabs++; }));
        }
        if (d.gcp_execution_arn_h264 && d.gcp_execution_arn_h264 !== seenGcp264 &&
            !lateGcpTerminal(d.gcp_job_status_h264)) {
          latePromises.push(stopGcpExecution(d.gcp_execution_arn_h264).then(ok => { if (ok) stoppedGcp++; }));
        }
        if (d.gcp_execution_arn_h265 && d.gcp_execution_arn_h265 !== seenGcp265 &&
            !lateGcpTerminal(d.gcp_job_status_h265)) {
          latePromises.push(stopGcpExecution(d.gcp_execution_arn_h265).then(ok => { if (ok) stoppedGcp++; }));
        }
      }
      await Promise.allSettled(latePromises);

      // Always do the prefix-based Batch sweep — covers the case where SFN
      // started but its arn was never written to video_episodes.
      const terminatedBatch = await terminateBatchJobsForEpisodes(nonTerminalEpIds);
      if (terminatedBatch > 0) stoppedLabs += terminatedBatch;
    }

    // Per-field conditional writes. Between our liveByEp snapshot above and
    // this write, the lab Batch callback or the GCP step function's terminal
    // handler can flip a status to COMPLETE / SUCCEEDED. Gate each field on
    // "not already terminal" so we never bury a success that landed mid-cancel.
    // Done one updateOne per (field,value) so each field carries its own guard.
    const TERMINAL_BY_FIELD = {
      lab_status_h264: 'COMPLETE',
      lab_status_h265: 'COMPLETE',
      gcp_job_status_h264: 'SUCCEEDED',
      gcp_job_status_h265: 'SUCCEEDED',
    };
    if (veWrites.size > 0) {
      const ops = [];
      for (const [episodeId, update] of veWrites.entries()) {
        for (const [field, value] of Object.entries(update.$set)) {
          const guard = TERMINAL_BY_FIELD[field];
          const filter = { episode_id: episodeId };
          if (guard && value === 'CANCELLED') filter[field] = { $ne: guard };
          ops.push(
            videoEpisodesCol.updateOne(filter, { $set: { [field]: value } }).catch(err => {
              console.warn(`[auto-pipeline/cancel] video_episodes cancel write failed for ${episodeId}.${field}:`, err?.message);
            }),
          );
        }
      }
      await Promise.allSettled(ops);
    }

    return NextResponse.json({ ok: true, stoppedLabs, stoppedGcp });
  } catch (err) {
    console.error('[POST /api/auto-pipeline/cancel]', err);
    return NextResponse.json({ error: 'Failed to cancel pipeline' }, { status: 500 });
  }
}
