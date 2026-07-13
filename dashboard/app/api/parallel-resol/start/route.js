import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { orchestrate } from '@/lib/pipelineOrchestrator';

export const dynamic = 'force-dynamic';

// Parallel Resol — a SEPARATE pipeline entry point from "Run Pipeline".
//
// Instead of the serial binary-search lab (1 Batch worker per lab), this runs
// every episode's full candidate grid through one work-conserving pool of ~120
// workers (see lib/parallelResolLab.js), then hands off to the same
// orchestrate() for GCP -> combine -> QC. The serial path is untouched.
//
// Body: { showId, limit?, codecs?, encodeWorkers? }
//   limit         — process only the first N eligible episodes (default: all)
//   codecs        — ['h264'] | ['h265'] | ['h264','h265'] (default both)
//   encodeWorkers — pool size, clamped to [1,128] in the engine (default 120)
export async function POST(request) {
  try {
    const body = await request.json();
    const { showId } = body || {};
    const limit = Number.isInteger(body?.limit) && body.limit > 0 ? body.limit : null;
    const codecs = Array.isArray(body?.codecs) && body.codecs.length
      ? body.codecs.filter((c) => c === 'h264' || c === 'h265')
      : ['h264', 'h265'];
    const encodeWorkers = Number.isInteger(body?.encodeWorkers) ? body.encodeWorkers : null;

    if (!showId || typeof showId !== 'string') {
      return NextResponse.json({ error: 'showId is required' }, { status: 400 });
    }
    let showObjectId;
    try {
      showObjectId = new ObjectId(showId);
    } catch {
      return NextResponse.json({ error: 'Invalid showId' }, { status: 400 });
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    // Guard: refuse if ANY run (serial "Run Pipeline" OR a prior Parallel Resol)
    // is already active for this show — they share video_vmaf_research /
    // golden_recipes / lab_status, so concurrent runs on the same show would
    // clobber each other. (The serial start route has its own guard; this covers
    // the parallel-vs-serial overlap from this side.)
    const existing = await labDb.collection('pipeline_runs').findOne(
      { show_id: showId, status: 'RUNNING' },
      { projection: { _id: 1, mode: 1 } },
    );
    if (existing) {
      const which = existing.mode === 'parallel_resol' ? 'A Parallel Resol run' : 'A pipeline run';
      return NextResponse.json(
        { error: `${which} is already active for this show — wait for it to finish or cancel it`, runId: String(existing._id) },
        { status: 409 },
      );
    }

    const show = await masterDb.collection('showcache').findOne({ _id: showObjectId });
    if (!show) return NextResponse.json({ error: 'Show not found' }, { status: 404 });

    const allItems = Array.isArray(show.episodes) ? show.episodes : [];
    const hasSource = (ep) => ep?.s3_url && ep.s3_url.trim() !== '';
    let eligible = allItems.filter(hasSource);
    if (eligible.length === 0) {
      return NextResponse.json({ error: 'No eligible episodes (no s3_url found)' }, { status: 400 });
    }
    if (limit) eligible = eligible.slice(0, limit);

    const nowDate = new Date();
    const eligibleIds = eligible.map((ep) => String(ep.id));

    // Snapshot pre-run video_episodes so /api/auto-pipeline/cancel can restore
    // (this is a re-lab run — it will overwrite golden_recipes / lab_status).
    const existingDocs = await labDb
      .collection('video_episodes')
      .find({ episode_id: { $in: eligibleIds } })
      .toArray();
    const priorStateMap = new Map(
      existingDocs.map((d) => {
        const { _id, ...rest } = d;
        return [d.episode_id, rest];
      }),
    );

    const makeEpDoc = (ep) => ({
      episode_id: String(ep.id),
      trailer_key: null,
      title: ep.title || String(ep.id) || '',
      s3_url: ep.s3_url || '',
      status: 'QUEUED',
      lab_h264_status: 'QUEUED',
      lab_h265_status: 'QUEUED',
      gcp_h264_status: null,
      gcp_h265_status: null,
      h264_master_m3u8_url: null,
      h265_master_m3u8_url: null,
      combined_master_m3u8_url: null,
      retries: { lab_h264: 0, lab_h265: 0, gcp_h264: 0, gcp_h265: 0, combine: 0, qc: 0, sync: 0 },
      retry_after_lab_h264: null,
      retry_after_lab_h265: null,
      retry_after_h264: null,
      retry_after_h265: null,
      gcp_enqueued_h264: false,
      gcp_enqueued_h265: false,
      combined: false,
      current_step: 'LAB_H264',
      error: null,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      last_updated_at: nowDate,
      synced_at: null,
      transition_log: [],
      prior_state: priorStateMap.get(String(ep.id)) || null,
    });

    const episodeDocs = eligible.map(makeEpDoc);

    const runDoc = {
      show_id: showId,
      show_slug: show.slug || null,
      show_title: show.title || '',
      kind: 'episode',
      mode: 'parallel_resol', // distinguishes this from serial "Run Pipeline" runs
      force_rerun: true, // Parallel Resol always re-labs from scratch
      status: 'RUNNING',
      codecs,
      encode_workers: encodeWorkers, // null -> engine default (120)
      max_gcp: 20, // reused by orchestrate() hand-off for GCP -> combine -> QC
      locked_by: null,
      locked_at: null,
      created_at: nowDate,
      started_at: null, // left null so orchestrate() fresh-starts on hand-off
      finished_at: null,
      total_episodes: eligible.length,
      skipped_episodes: 0,
      episodes: episodeDocs,
      completed_count: 0,
      failed_count: 0,
      running_count: 0,
      skipped_count: 0,
      eta_ms: null,
      gcp_queue_h264: [],
      gcp_queue_h265: [],
      gcp_paused_until: null,
    };

    // Fresh re-lab: reset lab status + clear prior golden recipes for the codecs
    // we're about to run, BEFORE the driver starts. Otherwise orchestrate()'s
    // pollLabs could read a stale lab_status_<codec>='COMPLETE' from a previous
    // run and enqueue GCP with old recipes before the engine has re-labbed.
    const resetSet = {};
    const resetUnset = { efficiency_gain: '' };
    for (const codec of codecs) {
      resetSet[`lab_status_${codec}`] = 'RUNNING';
      for (const res of ['1080p', '720p', '480p']) {
        resetUnset[`golden_recipes.resolutions.${res}.${codec}`] = '';
      }
    }
    await labDb.collection('video_episodes').updateMany(
      { episode_id: { $in: eligibleIds } },
      { $set: resetSet, $unset: resetUnset },
    );

    const result = await labDb.collection('pipeline_runs').insertOne(runDoc);
    const runId = String(result.insertedId);

    // orchestrate() is the run DRIVER (GCP → combine → QC, per episode). For
    // mode:'parallel_resol' it kicks the encode-pool lab engine instead of
    // dispatching serial labs, so GCP pipelines per episode as each grid finishes.
    setImmediate(() => {
      orchestrate(runId).catch((err) => {
        console.error('[parallel-resol/start] orchestrate error for runId', runId, err);
      });
    });

    return NextResponse.json({ runId, episodes: eligible.length, codecs });
  } catch (err) {
    console.error('[POST /api/parallel-resol/start]', err);
    return NextResponse.json({ error: 'Failed to start Parallel Resol run' }, { status: 500 });
  }
}
