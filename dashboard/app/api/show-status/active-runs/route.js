import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { listActiveJobs, describeJobs as describeWorkerJobs } from '@/lib/jobs';
import { CLOUD_PROVIDER, DB_LAB, DB_MASTER } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GCP transcode runs on GCP, so GCP worker counts stay Mongo-derived. Lab worker
// counts come from the configured Batch backend directly (AWS or Azure) because one
// episode can fan out to many workers: Run Lab = 1, Resol = 3, Bitrate Resol
// = ~25. Counting 1 per active episode-codec (the old approach) under-reported.
const GCP_ACTIVE = new Set(['STARTING', 'RUNNING']);

const LAB_WORKER_CAPACITY = Math.max(0, Number.parseInt(process.env.LAB_WORKER_CAPACITY || '128', 10) || 0);
const LAB_COMPUTE_PROVIDER = (process.env.LAB_COMPUTE_PROVIDER || CLOUD_PROVIDER || 'aws').toLowerCase();
const GCP_WORKER_CAPACITY = 45;

// AWS queue: as before (defaults to chai-q-queue on AWS). On Azure only listed if
// BATCH_JOB_QUEUE is set explicitly; the Azure Batch lab job is always included.
const BATCH_QUEUE = process.env.BATCH_JOB_QUEUE || (CLOUD_PROVIDER === 'aws' ? 'chai-q-queue' : undefined);

// Batch statuses that occupy a compute slot (an actually-running worker).
const BATCH_ACTIVE_STATUSES = ['RUNNING', 'STARTING'];

async function listJobIds(status) {
  const jobs = await listActiveJobs('lab', { jobQueue: BATCH_QUEUE, statuses: [status], throwOnError: true });
  return jobs.map((j) => j.jobId);
}

// Describe jobs (chunks of 100) and pull EPISODE_ID + CODEC from each job's env.
async function describeJobs(jobIds) {
  const jobs = await describeWorkerJobs(jobIds);
  return jobs.map((j) => ({
    status: j.status, episodeId: j.environment.EPISODE_ID || null, codec: j.environment.CODEC || null,
  }));
}

async function resolveEpisodesToShows(client, episodeIds) {
  const map = new Map();
  if (!episodeIds.length) return map;
  const masterDb = client.db(DB_MASTER);
  const lookup = await masterDb.collection('showcache')
    .find({ 'episodes.id': { $in: episodeIds } }, { projection: { _id: 1, slug: 1, title: 1, 'episodes.id': 1 } })
    .toArray();
  const wanted = new Set(episodeIds);
  for (const s of lookup) {
    for (const ep of s.episodes || []) {
      if (ep?.id && wanted.has(String(ep.id))) {
        map.set(String(ep.id), { show_id: String(s._id), show_slug: s.slug || null, show_title: s.title || 'Untitled' });
      }
    }
  }
  return map;
}

export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db(DB_LAB);

    // 1. Active pipeline_runs — show metadata + GCP counts + which episodes are
    //    part of a run (vs a standalone rerun).
    const runs = await db.collection('pipeline_runs').find(
      { status: 'RUNNING' },
      {
        projection: {
          show_id: 1, show_slug: 1, show_title: 1, kind: 1,
          'episodes.status': 1, 'episodes.episode_id': 1,
          'episodes.gcp_h264_status': 1, 'episodes.gcp_h265_status': 1,
        },
      },
    ).toArray();

    const epIdsInRuns = new Set();
    for (const run of runs) {
      for (const ep of run.episodes || []) if (ep.episode_id) epIdsInRuns.add(String(ep.episode_id));
    }

    // 2. Real Batch jobs = accurate worker count (captures Resol/Bitrate fan-out).
    const activeIds = (await Promise.all(BATCH_ACTIVE_STATUSES.map(listJobIds))).flat();
    const activeJobs = activeIds.length ? await describeJobs(activeIds) : [];
    const computeUsed = activeJobs.length;
    const videoJobs = activeJobs.filter(
      (j) => (j.codec === 'libx264' || j.codec === 'libx265') && j.episodeId,
    );

    const epToShow = await resolveEpisodesToShows(client, [...new Set(videoJobs.map((j) => j.episodeId))]);

    const shows = new Map();  // show_id -> row (episode in an active pipeline_run)
    const reruns = new Map(); // show_id -> row (standalone rerun activity)
    const blankRow = (meta) => ({
      show_id: meta.show_id, show_slug: meta.show_slug, show_title: meta.show_title, kind: 'episode',
      compute_h264: 0, compute_h265: 0, compute_running: 0,
      gcp_h264: 0, gcp_h265: 0, gcp_running: 0,
    });

    // 3. GCP counts (Mongo) — seed show rows from active runs.
    let gcpUsed = 0;
    for (const run of runs) {
      const meta = { show_id: String(run.show_id || run._id), show_slug: run.show_slug || null, show_title: run.show_title || 'Untitled' };
      let row = shows.get(meta.show_id);
      if (!row) { row = blankRow(meta); row.kind = run.kind || 'episode'; shows.set(meta.show_id, row); }
      for (const ep of run.episodes || []) {
        if (GCP_ACTIVE.has(ep.gcp_h264_status)) { row.gcp_h264 += 1; row.gcp_running += 1; gcpUsed += 1; }
        if (GCP_ACTIVE.has(ep.gcp_h265_status)) { row.gcp_h265 += 1; row.gcp_running += 1; gcpUsed += 1; }
        if (ep.status === 'COMBINING')          { row.gcp_h264 += 1; row.gcp_running += 1; gcpUsed += 1; }
      }
    }

    // 4. Batch counts — attribute each running video job to its show/codec.
    for (const j of videoJobs) {
      const meta = epToShow.get(j.episodeId) || { show_id: '_unknown', show_slug: null, show_title: 'Unknown show' };
      const map = epIdsInRuns.has(j.episodeId) ? shows : reruns;
      let row = map.get(meta.show_id);
      if (!row) { row = blankRow(meta); map.set(meta.show_id, row); }
      row.compute_running += 1;
      if (j.codec === 'libx264') row.compute_h264 += 1; else row.compute_h265 += 1;
    }

    // 5. GCP reruns — episodes running GCP outside any pipeline_run wrapper.
    const activeVideoEps = await db.collection('video_episodes').find(
      { $or: [
        { gcp_job_status_h264: { $in: [...GCP_ACTIVE] } },
        { gcp_job_status_h265: { $in: [...GCP_ACTIVE] } },
      ] },
      { projection: { episode_id: 1, gcp_job_status_h264: 1, gcp_job_status_h265: 1 } },
    ).toArray();
    const gcpOrphans = activeVideoEps.filter((d) => !epIdsInRuns.has(String(d.episode_id)));
    if (gcpOrphans.length) {
      const orphanToShow = await resolveEpisodesToShows(client, [...new Set(gcpOrphans.map((d) => String(d.episode_id)))]);
      for (const d of gcpOrphans) {
        const meta = orphanToShow.get(String(d.episode_id)) || { show_id: '_unknown', show_slug: null, show_title: 'Unknown show' };
        let row = reruns.get(meta.show_id);
        if (!row) { row = blankRow(meta); reruns.set(meta.show_id, row); }
        if (GCP_ACTIVE.has(d.gcp_job_status_h264)) { row.gcp_h264 += 1; row.gcp_running += 1; gcpUsed += 1; }
        if (GCP_ACTIVE.has(d.gcp_job_status_h265)) { row.gcp_h265 += 1; row.gcp_running += 1; gcpUsed += 1; }
      }
    }

    // Only surface rows that are actually consuming a worker right now.
    const sortRows = (m) => [...m.values()]
      .filter((r) => r.compute_running + r.gcp_running > 0)
      .sort((a, b) => (b.compute_running + b.gcp_running) - (a.compute_running + a.gcp_running));

    const workers = {
      compute: {
        provider: LAB_COMPUTE_PROVIDER,
        used: computeUsed,
        total: LAB_WORKER_CAPACITY,
        left: Math.max(0, LAB_WORKER_CAPACITY - computeUsed),
      },
      gcp: { used: gcpUsed, total: GCP_WORKER_CAPACITY, left: Math.max(0, GCP_WORKER_CAPACITY - gcpUsed) },
    };

    return NextResponse.json(
      { shows: sortRows(shows), reruns: sortRows(reruns), workers, active_runs: runs.length },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/show-status/active-runs]', err);
    return NextResponse.json({ error: 'Failed to load active runs' }, { status: 500 });
  }
}
