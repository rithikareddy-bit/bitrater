import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/auto-pipeline/active/[showId]
 * Returns the most recent active (RUNNING) or last completed pipeline_run for this show.
 * Used by the UI to restore pipeline status on page load / show select.
 */
export async function GET(request, { params }) {
  const { showId } = params;
  try {
    const client = await clientPromise();
    const col = client.db('chai_q_lab').collection('pipeline_runs');

    // First try to find a RUNNING run
    let run = await col.findOne(
      { show_id: showId, status: 'RUNNING' },
      { projection: { locked_by: 0, locked_at: 0 } },
    );

    // Fall back to most recently completed/failed/cancelled run
    if (!run) {
      run = await col
        .find({ show_id: showId, status: { $in: ['COMPLETED', 'FAILED', 'CANCELLED'] } })
        .sort({ created_at: -1 })
        .limit(1)
        .project({ locked_by: 0, locked_at: 0 })
        .next();
    }

    if (!run) return NextResponse.json({ run: null }, { headers: { 'Cache-Control': 'no-store' } });

    return NextResponse.json({ run }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[GET /api/auto-pipeline/active]', err);
    return NextResponse.json({ error: 'Failed to fetch active run' }, { status: 500 });
  }
}
