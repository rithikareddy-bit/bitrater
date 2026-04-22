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
      await Promise.all(allItems.map(async ep => {
        if (!isCombinedUrl(ep._gcpUrl)) return;
        if (!ep.s3_url) return;
        const drifted = await hasS3UrlDrifted({ episodeId: String(ep.id), s3Url: ep.s3_url });
        if (!drifted) alreadyCombinedIds.add(String(ep.id));
      }));
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

    // Check video_episodes for already-completed lab results so we skip re-running lab
    const eligibleIds = eligible.map(ep => String(ep.id));
    const existingLabDocs = await labDb.collection('video_episodes')
      .find(
        { episode_id: { $in: eligibleIds } },
        { projection: { episode_id: 1, lab_status_h264: 1, lab_status_h265: 1 } },
      )
      .toArray();
    const labStatusMap = new Map(existingLabDocs.map(d => [d.episode_id, d]));

    // Trailer fast path: probe FPS + write synthetic golden_recipes so the lab
    // step is skipped entirely. Per-trailer probe errors get captured here and
    // converted to SKIPPED docs below so one broken source doesn't block the batch.
    const probeErrors = new Map();
    if (kind === 'trailer') {
      await Promise.all(eligible.map(async ep => {
        try {
          await prepareTrailer({ episodeId: String(ep.id), s3Url: ep.s3_url });
          labStatusMap.set(String(ep.id), {
            episode_id: String(ep.id),
            lab_status_h264: 'COMPLETE',
            lab_status_h265: 'COMPLETE',
          });
        } catch (err) {
          probeErrors.set(String(ep.id), err?.message || 'probe failed');
        }
      }));
    }

    const probeFailed = eligible.filter(ep => probeErrors.has(String(ep.id)));
    const runnable = eligible.filter(ep => !probeErrors.has(String(ep.id)));

    const makeEpDoc = (ep, { skipped, skipReason } = {}) => {
      const existing = labStatusMap.get(String(ep.id));
      const labH264Done = !skipped && existing?.lab_status_h264 === 'COMPLETE';
      const labH265Done = !skipped && existing?.lab_status_h265 === 'COMPLETE';
      return {
        episode_id: String(ep.id),
        trailer_key: ep.trailer_key ?? null,
        title: ep.title || String(ep.id) || '',
        s3_url: ep.s3_url || '',
        status: skipped ? 'SKIPPED' : 'QUEUED',
        lab_h264_status: labH264Done ? 'COMPLETE' : 'QUEUED',
        lab_h265_status: labH265Done ? 'COMPLETE' : 'QUEUED',
        gcp_h264_status: null,
        gcp_h265_status: null,
        retries: { lab_h264: 0, lab_h265: 0, gcp_h264: 0, gcp_h265: 0, combine: 0, qc: 0, sync: 0 },
        retry_after_lab_h264: null,
        retry_after_lab_h265: null,
        retry_after_h264: null,
        retry_after_h265: null,
        gcp_enqueued_h264: false,
        gcp_enqueued_h265: false,
        combined: false,
        current_step: labH264Done && labH265Done ? 'GCP_H264' : 'LAB_H264',
        error: skipped ? skipReason : null,
        started_at: labH264Done || labH265Done ? nowDate : null,
        finished_at: null,
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
      completed_count: 0,
      failed_count: 0,
      running_count: 0,
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
