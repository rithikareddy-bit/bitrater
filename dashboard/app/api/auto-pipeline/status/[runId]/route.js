import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { DB_LAB } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request, { params }) {
  const { runId } = params;
  try {
    let oid;
    try { oid = new ObjectId(runId); } catch {
      return NextResponse.json({ error: 'Invalid runId' }, { status: 400 });
    }

    const client = await clientPromise();
    const run = await client.db(DB_LAB).collection('pipeline_runs').findOne(
      { _id: oid },
      {
        projection: {
          locked_by: 0,
          locked_at: 0,
          // prior_state is the full pre-rerun video_episodes snapshot used by
          // /api/auto-pipeline/cancel. It's several KB per episode (golden
          // recipes + quality_check) and the UI never reads it — keep it out
          // of the polled status payload.
          'episodes.prior_state': 0,
        },
      },
    );

    if (!run) return NextResponse.json({ error: 'Pipeline run not found' }, { status: 404 });

    return NextResponse.json(run, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (err) {
    console.error('[GET /api/auto-pipeline/status]', err);
    return NextResponse.json({ error: 'Failed to fetch pipeline status' }, { status: 500 });
  }
}
