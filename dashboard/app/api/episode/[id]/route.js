import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { resolveDurationForLabEpisode } from '@/lib/labEpisodeDuration';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request, { params }) {
  const { id } = params;

  try {
    const client = await clientPromise();

    const labDb = client.db('chai_q_lab');
    const [research, golden] = await Promise.all([
      // No cap: an arbitrary .limit() can drop an entire codec from the R-D chart while
      // lab_status / golden_recipes still reflect a complete run (aggregator has no limit).
      labDb.collection('video_vmaf_research').find({ episode_id: id }).toArray(),
      labDb.collection('video_episodes').findOne({ episode_id: id }),
    ]);

    const masterDb = client.db('master');
    const showWithEp = await masterDb.collection('showcache').findOne(
      { 'episodes.id': id },
      { projection: { 'episodes.$': 1, title: 1 } }
    );
    const episodeMeta = showWithEp?.episodes?.[0] ?? null;
    const videoUrl = episodeMeta?.s3_url ?? null;

    const { durationSeconds, durationSource } = await resolveDurationForLabEpisode(
      labDb,
      episodeMeta,
      id,
    );

    return NextResponse.json(
      { research, golden, videoUrl, episodeMeta, durationSeconds, durationSource },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/episode/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch episode data' }, { status: 500 });
  }
}
