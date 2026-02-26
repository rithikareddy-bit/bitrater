import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function GET(request, { params }) {
  const { id } = params;

  try {
    const client = await clientPromise();
    const db = client.db('chai_q_lab');

    const [research, golden] = await Promise.all([
      db.collection('video_vmaf_research').find({ episode_id: id }).toArray(),
      db.collection('video_episodes').findOne({ episode_id: id }),
    ]);

    return NextResponse.json({ research, golden });
  } catch (err) {
    console.error('[GET /api/episode/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch episode data' }, { status: 500 });
  }
}
