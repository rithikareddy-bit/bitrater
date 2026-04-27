import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { orchestrate } from '@/lib/pipelineOrchestrator';
import { isCombinedUrl, prepareTrailer, hasS3UrlDrifted } from '@/lib/trailerPrep';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const body = await request.json();
    const { showId } = body || {};
    const kind = body?.kind === 'trailer' ? 'trailer' : 'episode';
    const force = body?.force === true;
    if (!showId || typeof showId !== 'string') {
      return NextResponse.json({ error: 'showId is required' }, { status: 400 });
    }

    let showObjectId;
    try { showObjectId = new ObjectId(showId); } catch {
      return NextResponse.json({ error: 'Invalid showId' }, { status: 400 });
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    // Guard: reject if a pipeline of this kind is already RUNNING for this show.
    // Legacy runs written before `kind` existed default to 'episode'.
    const kindMatch = kind === 'trailer'
      ? { kind: 'trailer' }
      : { $or: [{ kind: 'episode' }, { kind: { $exists: false } }] };
    const existing = await labDb.collection('pipeline_runs').findOne(
      { show_id: showId, status: 'RUNNING', ...kindMatch },
      { projection: { _id: 1 } },
    );
    if (existing) {
      return NextResponse.json(
        { error: `${kind === 'trailer' ? 'Trailer' : 'Episode'} pipeline already running for this show`, runId: String(existing._id) },
        { status: 409 },
      );
    }

    // Fetch show
    const show = await masterDb.collection('showcache').findOne({ _id: showObjectId });
    if (!show) return NextResponse.json({ error: 'Show not found' }, { status: 404 });

    // Normalize the source items to a common shape {id, s3_url, title, ...}
    // so the orchestrator / downstream routes can stay identical.
    let allItems;
    const alreadyCombinedIds = new Set();
    if (kind === 'trailer') {
      const trailers = Array.isArray(show.trailers_playback_urls) ? show.trailers_playback_urls : [];
      allItems = trailers.map((t, i) => {
        const id = `trailer_${showId}_${t?._key ?? `idx${i}`}`;
        return {
          id,
          trailer_key: t?._key ?? null,
          s3_url: t?.s3Url || t?.s3_url || '',
          title: t?.title || `Trailer ${i + 1}`,
          _gcpUrl: t?.gcpUrl || null,
        };
      });

      // A trailer is "already combined" only when its gcpUrl ends with
      // _combined.m3u8 AND the current s3Url matches the one we last encoded.
      // Drift forces a re-run even if the old gcpUrl happens to be combined.
      // force=true (Run Pipeline) skips this entirely — rerun no matter what.
      if (!force) {
        await Promise.all(allItems.map(async ep => {
          if (!isCombinedUrl(ep._gcpUrl)) return;
          if (!ep.s3_url) return;
          const drifted = await hasS3UrlDrifted({ episodeId: String(ep.id), s3Url: ep.s3_url });
          if (!drifted) alreadyCombinedIds.add(String(ep.id));
        }));
      }
    } else {
      allItems = Array.isArray(show.episodes) ? show.episodes : [];
    }

    // Also skip trailers that are already being processed by another RUNNING
    // trailer run (e.g. the scanner's batch). Same episode_id in two runs
    // would cause duplicate GCP jobs.
    const activeInOtherRuns = new Set();
    if (kind === 'trailer') {
      const runs = await labDb.collection('pipeline_runs')
        .find({ kind: 'trailer', status: 'RUNNING' }, { projection: { 'episodes.episode_id': 1, 'episodes.status': 1 } })
        .toArray();
      for (const run of runs) {
        for (const ep of run.episodes || []) {
          if (ep.status === 'SKIPPED' || ep.status === 'SYNCED' ||
              ep.status === 'FAILED' || ep.status === 'CANCELLED') continue;
          if (ep.episode_id) activeInOtherRuns.add(ep.episode_id);
        }
      }
    }

    const hasSource = ep => ep?.s3_url && ep.s3_url.trim() !== '';
    const eligible   = allItems.filter(ep => hasSource(ep) && !alreadyCombinedIds.has(String(ep.id)) && !activeInOtherRuns.has(String(ep.id)));
    const ineligible = allItems.filter(ep => !hasSource(ep));
    const combinedSkips = allItems.filter(ep => hasSource(ep) && alreadyCombinedIds.has(String(ep.id)));
    const activeSkips = allItems.filter(ep => hasSource(ep) && activeInOtherRuns.has(String(ep.id)));

    if (eligible.length === 0) {
      let trailerErr;
      if (activeSkips.length > 0 && combinedSkips.length === 0) {
        trailerErr = 'All trailers are already running in another pipeline (likely the scanner batch)';
      } else if (combinedSkips.length > 0) {
        trailerErr = 'All trailers already have a combined gcpUrl — nothing to do';
      } else {
        trailerErr = 'No eligible trailers (no s3Url found)';
      }
      return NextResponse.json(
        {
          error: kind === 'trailer' ? trailerErr : 'No eligible episodes (no s3_url found)',
        },
        { status: 400 },
      );
    }

    const nowDate = new Date();

    // For "Continue Lab" (force=false), read every persistent stage marker from
    // video_episodes so we can resume past whatever already finished —
    // lab → GCP → combine → QC. For "Run Pipeline" (force=true) we ignore all
    // prior state and start fresh.
    const QC_DONE = new Set(['PASS', 'ISSUES_FOUND']);
    const eligibleIds = eligible.map(ep => String(ep.id));
    const existingDocs = force
      ? []
      : await labDb.collection('video_episodes')
          .find(
            { episode_id: { $in: eligibleIds } },
            {
              projection: {
                episode_id: 1,
                lab_status_h264: 1,
                lab_status_h265: 1,
                h264_master_m3u8_url: 1,
                h265_master_m3u8_url: 1,
                combined_master_m3u8_url: 1,
                quality_check: 1,
              },
            },
          )
          .toArray();
    const epStateMap = new Map(existingDocs.map(d => [d.episode_id, d]));

    // Trailer fast path: probe FPS + write synthetic golden_recipes so the lab
    // step is skipped entirely. Per-trailer probe errors get captured here and
    // converted to SKIPPED docs below so one broken source doesn't block the batch.
    // Trailers have no real lab — lab_status_h*='COMPLETE' is synthetic and must
    // hold for both force=true and force=false.
    const probeErrors = new Map();
    if (kind === 'trailer') {
      await Promise.all(eligible.map(async ep => {
        try {
          const result = await prepareTrailer({ episodeId: String(ep.id), s3Url: ep.s3_url });
          const prev = epStateMap.get(String(ep.id)) || { episode_id: String(ep.id) };
          prev.lab_status_h264 = 'COMPLETE';
          prev.lab_status_h265 = 'COMPLETE';
          // Drift = source file was replaced. Any prior GCP/combine outputs
          // came from the old source and must be re-encoded — drop them from
          // the resume map so makeEpDoc seeds gcp/combine as not-done.
          if (result?.driftDetected) {
            prev.h264_master_m3u8_url = null;
            prev.h265_master_m3u8_url = null;
            prev.combined_master_m3u8_url = null;
            prev.quality_check = null;
          }
          epStateMap.set(String(ep.id), prev);
        } catch (err) {
          probeErrors.set(String(ep.id), err?.message || 'probe failed');
        }
      }));
    }

    const probeFailed = eligible.filter(ep => probeErrors.has(String(ep.id)));
    const runnable = eligible.filter(ep => !probeErrors.has(String(ep.id)));

    const makeEpDoc = (ep, { skipped, skipReason } = {}) => {
      const state = !skipped ? epStateMap.get(String(ep.id)) : null;
      const labH264Done = state?.lab_status_h264 === 'COMPLETE';
      const labH265Done = state?.lab_status_h265 === 'COMPLETE';
      const gcpH264Done = !!state?.h264_master_m3u8_url;
      const gcpH265Done = !!state?.h265_master_m3u8_url;
      const combineDone = !!state?.combined_master_m3u8_url;
      const qcDone = QC_DONE.has(state?.quality_check?.overall);
      const allDone = labH264Done && labH265Done && gcpH264Done && gcpH265Done && combineDone && qcDone;

      // Map the per-stage flags to a seeded run-doc state. The orchestrator
      // already has separate paths for each stage; we just need to set the
      // statuses + URLs so each stage's gate sees "done" for prior work.
      let status;
      let currentStep;
      let finishedAt = null;
      if (skipped) {
        status = 'SKIPPED';
        currentStep = 'LAB_H264';
      } else if (allDone) {
        // Trailers auto-sync at step 6.5; episodes terminate at READY_TO_SYNC
        // and wait for the manual Sync Show button.
        if (kind === 'trailer') {
          status = 'SYNC_PENDING';
          currentStep = 'SYNC';
        } else {
          status = 'READY_TO_SYNC';
          currentStep = 'DONE';
          finishedAt = nowDate;
        }
      } else if (combineDone) {
        // Combine done but QC pending (or QC FAILED/RUNNING) — pollQC picks up.
        status = 'COMBINING';
        currentStep = 'QC';
      } else if (gcpH264Done && gcpH265Done) {
        // Both GCP done, combine pending — combine step picks up.
        status = 'QUEUED';
        currentStep = 'COMBINE';
      } else if (labH264Done && labH265Done) {
        status = 'QUEUED';
        currentStep = 'GCP_H264';
      } else {
        status = 'QUEUED';
        currentStep = 'LAB_H264';
      }

      const anyPriorWork = labH264Done || labH265Done || gcpH264Done || gcpH265Done || combineDone || qcDone;

      return {
        episode_id: String(ep.id),
        trailer_key: ep.trailer_key ?? null,
        title: ep.title || String(ep.id) || '',
        s3_url: ep.s3_url || '',
        status,
        lab_h264_status: !skipped && labH264Done ? 'COMPLETE' : 'QUEUED',
        lab_h265_status: !skipped && labH265Done ? 'COMPLETE' : 'QUEUED',
        gcp_h264_status: !skipped && gcpH264Done ? 'SUCCEEDED' : null,
        gcp_h265_status: !skipped && gcpH265Done ? 'SUCCEEDED' : null,
        // Cache GCP/combine URLs on the run doc so combine + auto-sync don't
        // need an extra /api/gcp-status fetch on the first tick.
        h264_master_m3u8_url: !skipped ? state?.h264_master_m3u8_url ?? null : null,
        h265_master_m3u8_url: !skipped ? state?.h265_master_m3u8_url ?? null : null,
        combined_master_m3u8_url: !skipped ? state?.combined_master_m3u8_url ?? null : null,
        retries: { lab_h264: 0, lab_h265: 0, gcp_h264: 0, gcp_h265: 0, combine: 0, qc: 0, sync: 0 },
        retry_after_lab_h264: null,
        retry_after_lab_h265: null,
        retry_after_h264: null,
        retry_after_h265: null,
        // gcp_enqueued_h*=true on resume prevents the orchestrator's fresh-start
        // GCP enqueue path from queueing a job for a codec that's already done.
        gcp_enqueued_h264: !skipped && gcpH264Done,
        gcp_enqueued_h265: !skipped && gcpH265Done,
        combined: !skipped && combineDone,
        current_step: currentStep,
        error: skipped ? skipReason : null,
        started_at: !skipped && anyPriorWork ? nowDate : null,
        finished_at: finishedAt,
        duration_ms: null,
        last_updated_at: nowDate,
        synced_at: null,
        transition_log: [],
      };
    };

    const ineligibleDocs = ineligible.map(ep => makeEpDoc(ep, { skipped: true, skipReason: 'No s3_url' }));
    const combinedSkipDocs = combinedSkips.map(ep => makeEpDoc(ep, { skipped: true, skipReason: 'Already combined' }));
    const activeSkipDocs = (activeSkips || []).map(ep => makeEpDoc(ep, { skipped: true, skipReason: 'Already running in another pipeline' }));
    const probeFailedDocs = probeFailed.map(ep => makeEpDoc(ep, {
      skipped: true,
      skipReason: `probe failed: ${probeErrors.get(String(ep.id))}`,
    }));
    const runnableDocs = runnable.map(ep => makeEpDoc(ep));

    const episodeDocs = [...runnableDocs, ...ineligibleDocs, ...combinedSkipDocs, ...activeSkipDocs, ...probeFailedDocs];
    const skippedCount = ineligibleDocs.length + combinedSkipDocs.length + activeSkipDocs.length + probeFailedDocs.length;

    // Continue Lab can seed episodes as already-completed (READY_TO_SYNC / SYNCED)
    // or already-in-progress (COMBINING / SYNC_PENDING). The orchestrator's step 8
    // recomputes these counters in the poll loop, but the fresh-start early-exit
    // (when every episode is terminal) skips that loop. Seed the counters here so
    // the run doc is accurate from insert and during the brief window before the
    // orchestrator's first tick.
    const completedCount = episodeDocs.filter(d => d.status === 'READY_TO_SYNC' || d.status === 'SYNCED').length;
    const failedCount    = episodeDocs.filter(d => d.status === 'FAILED').length;
    const runningCount   = episodeDocs.filter(d =>
      d.status === 'LAB_RUNNING' || d.status === 'GCP_RUNNING' ||
      d.status === 'COMBINING'   || d.status === 'SYNC_PENDING'
    ).length;

    if (runnable.length === 0) {
      return NextResponse.json(
        { error: kind === 'trailer' ? 'No trailers runnable after probe' : 'No episodes runnable' },
        { status: 400 },
      );
    }

    // Trailer runs cap GCP at 10 concurrent jobs (= 5 trailers in parallel ×
    // 2 codecs) — a ceiling, not a target. The scanner also restricts to 1
    // trailer run in flight at a time, so trailers never exceed 10 GCP jobs
    // globally. Episode runs keep the original 20-wide budget.
    const maxGcpForThisRun = kind === 'trailer' ? 10 : 20;

    const runDoc = {
      show_id: showId,
      show_slug: show.slug || null,
      show_title: show.title || '',
      kind,
      status: 'RUNNING',
      lab_workers: 30,
      max_gcp: maxGcpForThisRun,
      locked_by: null,
      locked_at: null,
      created_at: nowDate,
      started_at: null,
      finished_at: null,
      total_episodes: allItems.length,
      skipped_episodes: skippedCount,
      episodes: episodeDocs,
      completed_count: completedCount,
      failed_count: failedCount,
      running_count: runningCount,
      skipped_count: skippedCount,
      eta_ms: null,
      gcp_queue_h264: [],
      gcp_queue_h265: [],
      gcp_paused_until: null,
    };

    const result = await labDb.collection('pipeline_runs').insertOne(runDoc);
    const runId = String(result.insertedId);

    setImmediate(() => {
      orchestrate(runId).catch(err => {
        console.error('[auto-pipeline/start] Orchestrator error for runId', runId, err);
      });
    });

    return NextResponse.json({ runId });
  } catch (err) {
    console.error('[POST /api/auto-pipeline/start]', err);
    return NextResponse.json({ error: 'Failed to start pipeline' }, { status: 500 });
  }
}
