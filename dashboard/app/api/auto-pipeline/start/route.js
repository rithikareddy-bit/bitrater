import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { orchestrate } from '@/lib/pipelineOrchestrator';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const body = await request.json();
    const { showId } = body || {};
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

    // Guard: reject if a pipeline is already RUNNING for this show
    const existing = await labDb.collection('pipeline_runs').findOne(
      { show_id: showId, status: 'RUNNING' },
      { projection: { _id: 1 } },
    );
    if (existing) {
      return NextResponse.json(
        { error: 'Pipeline already running for this show', runId: String(existing._id) },
        { status: 409 },
      );
    }

    // Fetch show
    const show = await masterDb.collection('showcache').findOne({ _id: showObjectId });
    if (!show) return NextResponse.json({ error: 'Show not found' }, { status: 404 });

    const allEpisodes = Array.isArray(show.episodes) ? show.episodes : [];
    const eligible   = allEpisodes.filter(ep => ep?.s3_url && ep.s3_url.trim() !== '');
    const ineligible = allEpisodes.filter(ep => !ep?.s3_url || ep.s3_url.trim() === '');

    if (eligible.length === 0) {
      return NextResponse.json({ error: 'No eligible episodes (no s3_url found)' }, { status: 400 });
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

    const makeEpDoc = (ep, skipped) => {
      const existing = labStatusMap.get(String(ep.id));
      const labH264Done = !skipped && existing?.lab_status_h264 === 'COMPLETE';
      const labH265Done = !skipped && existing?.lab_status_h265 === 'COMPLETE';
      return {
        episode_id: String(ep.id),
        title: ep.title || String(ep.id) || '',
        s3_url: ep.s3_url || '',
        status: skipped ? 'SKIPPED' : 'QUEUED',
        lab_h264_status: labH264Done ? 'COMPLETE' : 'QUEUED',
        lab_h265_status: labH265Done ? 'COMPLETE' : 'QUEUED',
        gcp_h264_status: null,
        gcp_h265_status: null,
        retries: { lab_h264: 0, lab_h265: 0, gcp_h264: 0, gcp_h265: 0, combine: 0, qc: 0 },
        retry_after_lab_h264: null,
        retry_after_lab_h265: null,
        retry_after_h264: null,
        retry_after_h265: null,
        gcp_enqueued_h264: false,
        gcp_enqueued_h265: false,
        combined: false,
        current_step: labH264Done && labH265Done ? 'GCP_H264' : 'LAB_H264',
        error: skipped ? 'No s3_url' : null,
        started_at: labH264Done || labH265Done ? nowDate : null,
        finished_at: null,
        duration_ms: null,
        last_updated_at: nowDate,
        synced_at: null,
        transition_log: [],
      };
    };

    const episodeDocs = [
      ...eligible.map(ep => makeEpDoc(ep, false)),
      ...ineligible.map(ep => makeEpDoc(ep, true)),
    ];

    const runDoc = {
      show_id: showId,
      show_title: show.title || '',
      status: 'RUNNING',
      h264_workers: 18,
      h265_workers: 12,
      max_gcp: 20,
      locked_by: null,
      locked_at: null,
      created_at: nowDate,
      started_at: null,
      finished_at: null,
      total_episodes: allEpisodes.length,
      skipped_episodes: ineligible.length,
      episodes: episodeDocs,
      completed_count: 0,
      failed_count: 0,
      running_count: 0,
      skipped_count: ineligible.length,
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
