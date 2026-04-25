import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10) || 20, 100);

    const client = await clientPromise();
    const runs = await client.db('chai_q_lab')
      .collection('playback_resign_runs')
      .find({}, {
        projection: {
          started_at: 1,
          finished_at: 1,
          duration_s: 1,
          updated_count: 1,
          skipped_count: 1,
          errors: 1,
        },
      })
      .sort({ started_at: -1 })
      .limit(limit)
      .toArray();

    return NextResponse.json({ runs });
  } catch (err) {
    console.error('[GET /api/signing/runs]', err);
    return NextResponse.json({ error: 'Failed to read resign runs' }, { status: 500 });
  }
}
