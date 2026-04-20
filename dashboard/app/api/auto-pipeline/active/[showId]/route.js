import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/auto-pipeline/active/[showId]?kind=episode|trailer
 * Returns the most recent active (RUNNING) or last completed pipeline_run for this show.
 * If kind is provided, filter to runs of that kind; otherwise default to episode runs
 * (backward compatible with existing UI that doesn't pass kind).
 */
export async function GET(request, { params }) {
  const { showId } = params;
  const kindParam = request.nextUrl.searchParams.get('kind');
  const kind = kindParam === 'trailer' ? 'trailer' : 'episode';
  try {
    const client = await clientPromise();
    const col = client.db('chai_q_lab').collection('pipeline_runs');

    // Match docs that either explicitly have the requested kind, or
    // (for legacy episode runs written before kind was introduced) have no kind field.
    const kindMatch = kind === 'episode'
      ? { $or: [{ kind: 'episode' }, { kind: { $exists: false } }] }
      : { kind: 'trailer' };

    // First try to find a RUNNING run
    let run = await col.findOne(
      { show_id: showId, status: 'RUNNING', ...kindMatch },
      { projection: { locked_by: 0, locked_at: 0 } },
    );

    // Fall back to most recently completed/failed/cancelled run
    if (!run) {
      run = await col
        .find({
          show_id: showId,
          status: { $in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
          ...kindMatch,
        })
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
