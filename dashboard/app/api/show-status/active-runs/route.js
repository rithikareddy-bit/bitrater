import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const AWS_STATUSES = new Set(['LAB_RUNNING']);
const GCP_STATUSES = new Set(['GCP_RUNNING', 'COMBINING']);

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
          },
        },
      )
      .toArray();

    const perShow = new Map();
    let awsUsed = 0;
    let gcpUsed = 0;
    let awsTotal = 0;
    let gcpTotal = 0;

    for (const run of runs) {
      awsTotal += Number(run.lab_workers || 0);
      gcpTotal += Number(run.max_gcp || 0);

      const key = String(run.show_id || run._id);
      let row = perShow.get(key);
      if (!row) {
        row = {
          show_id: key,
          show_slug: run.show_slug || null,
          show_title: run.show_title || 'Untitled',
          kind: run.kind || 'episode',
          aws_running: 0,
          gcp_running: 0,
          total_in_run: 0,
        };
        perShow.set(key, row);
      }

      const eps = Array.isArray(run.episodes) ? run.episodes : [];
      for (const ep of eps) {
        row.total_in_run += 1;
        if (AWS_STATUSES.has(ep.status)) {
          row.aws_running += 1;
          awsUsed += 1;
        } else if (GCP_STATUSES.has(ep.status)) {
          row.gcp_running += 1;
          gcpUsed += 1;
        }
      }
    }

    const shows = [...perShow.values()].sort(
      (a, b) => (b.aws_running + b.gcp_running) - (a.aws_running + a.gcp_running),
    );

    const workers = {
      aws: { used: awsUsed, total: awsTotal, left: Math.max(0, awsTotal - awsUsed) },
      gcp: { used: gcpUsed, total: gcpTotal, left: Math.max(0, gcpTotal - gcpUsed) },
    };

    return NextResponse.json(
      { shows, workers, active_runs: runs.length },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/show-status/active-runs]', err);
    return NextResponse.json({ error: 'Failed to load active runs' }, { status: 500 });
  }
}
