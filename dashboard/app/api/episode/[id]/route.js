import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request, { params }) {
  const { id } = params;

  try {
    const client = await clientPromise();

    const labDb = client.db('chai_q_lab');
    const [research, golden] = await Promise.all([
      labDb.collection('video_vmaf_research').find({ episode_id: id }).limit(200).toArray(),
      labDb.collection('video_episodes').findOne({ episode_id: id }),
    ]);

    const masterDb = client.db('master');
    const showWithEp = await masterDb.collection('showcache').findOne(
      { 'episodes.id': id },
      { projection: { 'episodes.$': 1, title: 1 } }
    );
    const episodeMeta = showWithEp?.episodes?.[0] ?? null;
    const videoUrl = episodeMeta?.s3_url ?? null;

    return NextResponse.json(
      { research, golden, videoUrl, episodeMeta },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/episode/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch episode data' }, { status: 500 });
  }
}
