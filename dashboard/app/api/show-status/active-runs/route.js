import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Per-codec lab/GCP states that consume one worker slot each.
// An episode runs H264 + H265 in parallel, so a single LAB_RUNNING episode
// occupies up to 2 lab worker slots — we count them separately here.
const LAB_ACTIVE = new Set(['STARTING', 'RUNNING']);
const GCP_ACTIVE = new Set(['STARTING', 'RUNNING']);

const AWS_WORKER_CAPACITY = 128;
const GCP_WORKER_CAPACITY = 45;

export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db('chai_q_lab');

    const runs = await db.collection('pipeline_runs')
      .find(
        { status: 'RUNNING' },
        {
          projection: {
            show_id: 1,
            show_slug: 1,
            show_title: 1,
            kind: 1,
            lab_workers: 1,
            max_gcp: 1,
            'episodes.status': 1,
            'episodes.episode_id': 1,
            'episodes.lab_h264_status': 1,
            'episodes.lab_h265_status': 1,
            'episodes.gcp_h264_status': 1,
            'episodes.gcp_h265_status': 1,
          },
        },
      )
      .toArray();

    const perShow = new Map();
    let awsUsed = 0;
    let gcpUsed = 0;

    for (const run of runs) {
      const key = String(run.show_id || run._id);
      let row = perShow.get(key);
      if (!row) {
        row = {
          show_id: key,
          show_slug: run.show_slug || null,
          show_title: run.show_title || 'Untitled',
          kind: run.kind || 'episode',
          aws_h264: 0,
          aws_h265: 0,
          aws_running: 0,
          gcp_h264: 0,
          gcp_h265: 0,
          gcp_running: 0,
        };
        perShow.set(key, row);
      }

      const eps = Array.isArray(run.episodes) ? run.episodes : [];
      for (const ep of eps) {
        // Per-codec lab worker slots (H264 + H265 run in parallel per episode).
        if (LAB_ACTIVE.has(ep.lab_h264_status)) { row.aws_h264 += 1; row.aws_running += 1; awsUsed += 1; }
        if (LAB_ACTIVE.has(ep.lab_h265_status)) { row.aws_h265 += 1; row.aws_running += 1; awsUsed += 1; }
        // Per-codec GCP worker slots. COMBINING is a post-GCP single slot — bucket under H264 col.
        if (GCP_ACTIVE.has(ep.gcp_h264_status)) { row.gcp_h264 += 1; row.gcp_running += 1; gcpUsed += 1; }
        if (GCP_ACTIVE.has(ep.gcp_h265_status)) { row.gcp_h265 += 1; row.gcp_running += 1; gcpUsed += 1; }
        if (ep.status === 'COMBINING')          { row.gcp_h264 += 1; row.gcp_running += 1; gcpUsed += 1; }
      }
    }

    const shows = [...perShow.values()].sort(
      (a, b) => (b.aws_running + b.gcp_running) - (a.aws_running + a.gcp_running),
    );

    // ── Reruns: episodes active in `video_episodes` but NOT covered by any
    // active pipeline_runs doc (per-episode reruns bypass the run wrapper).
    // We still need their worker consumption in the totals, otherwise the
    // AWS/GCP "Used" counts under-report what the cloud is actually doing.
    const epIdsInRuns = new Set();
    for (const run of runs) {
      for (const ep of run.episodes || []) {
        if (ep.episode_id) epIdsInRuns.add(String(ep.episode_id));
      }
    }

    const activeVideoEps = await db.collection('video_episodes')
      .find(
        {
          $or: [
            { lab_status_h264: { $in: [...LAB_ACTIVE] } },
            { lab_status_h265: { $in: [...LAB_ACTIVE] } },
            { gcp_job_status_h264: { $in: [...GCP_ACTIVE] } },
            { gcp_job_status_h265: { $in: [...GCP_ACTIVE] } },
          ],
        },
        {
          projection: {
            episode_id: 1,
            lab_status_h264: 1,
            lab_status_h265: 1,
            gcp_job_status_h264: 1,
            gcp_job_status_h265: 1,
          },
        },
      )
      .toArray();

    const orphanEps = activeVideoEps.filter(d => !epIdsInRuns.has(String(d.episode_id)));

    // Resolve episode_id → {show_id, show_title, show_slug} via master.showcache.
    // Only scan if there are orphans, and pull only what we need.
    const perRerunShow = new Map();
    if (orphanEps.length > 0) {
      const orphanIds = new Set(orphanEps.map(d => String(d.episode_id)));
      const masterDb = client.db('master');
      const showsForLookup = await masterDb.collection('showcache')
        .find({ 'episodes.id': { $in: [...orphanIds] } }, { projection: { _id: 1, slug: 1, title: 1, 'episodes.id': 1 } })
        .toArray();

      const epToShow = new Map();
      for (const s of showsForLookup) {
        for (const ep of s.episodes || []) {
          if (ep?.id && orphanIds.has(String(ep.id))) {
            epToShow.set(String(ep.id), { show_id: String(s._id), show_slug: s.slug || null, show_title: s.title || 'Untitled' });
          }
        }
      }

      for (const d of orphanEps) {
        const meta = epToShow.get(String(d.episode_id)) || { show_id: '_unknown', show_slug: null, show_title: 'Unknown show' };
        let row = perRerunShow.get(meta.show_id);
        if (!row) {
          row = {
            show_id: meta.show_id,
            show_slug: meta.show_slug,
            show_title: meta.show_title,
            aws_h264: 0, aws_h265: 0, aws_running: 0,
            gcp_h264: 0, gcp_h265: 0, gcp_running: 0,
          };
          perRerunShow.set(meta.show_id, row);
        }
        if (LAB_ACTIVE.has(d.lab_status_h264))     { row.aws_h264 += 1; row.aws_running += 1; awsUsed += 1; }
        if (LAB_ACTIVE.has(d.lab_status_h265))     { row.aws_h265 += 1; row.aws_running += 1; awsUsed += 1; }
        if (GCP_ACTIVE.has(d.gcp_job_status_h264)) { row.gcp_h264 += 1; row.gcp_running += 1; gcpUsed += 1; }
        if (GCP_ACTIVE.has(d.gcp_job_status_h265)) { row.gcp_h265 += 1; row.gcp_running += 1; gcpUsed += 1; }
      }
    }

    const reruns = [...perRerunShow.values()].sort(
      (a, b) => (b.aws_running + b.gcp_running) - (a.aws_running + a.gcp_running),
    );

    const workers = {
      aws: { used: awsUsed, total: AWS_WORKER_CAPACITY, left: Math.max(0, AWS_WORKER_CAPACITY - awsUsed) },
      gcp: { used: gcpUsed, total: GCP_WORKER_CAPACITY, left: Math.max(0, GCP_WORKER_CAPACITY - gcpUsed) },
    };

    return NextResponse.json(
      { shows, reruns, workers, active_runs: runs.length },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/show-status/active-runs]', err);
    return NextResponse.json({ error: 'Failed to load active runs' }, { status: 500 });
  }
}
