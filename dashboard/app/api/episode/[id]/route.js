import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { resolveDurationForLabEpisode } from '@/lib/labEpisodeDuration';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const TRAILER_ID_RE = /^trailer_([a-f0-9]{24})_(.+)$/;

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
    const trailerMatch = TRAILER_ID_RE.exec(id);
    let episodeMeta = null;
    let videoUrl = null;
    if (trailerMatch) {
      const [, showIdHex, trailerKey] = trailerMatch;
      const showDoc = await masterDb.collection('showcache').findOne(
        { _id: new ObjectId(showIdHex), 'trailers_playback_urls._key': trailerKey },
        { projection: { 'trailers_playback_urls.$': 1, title: 1, slug: 1 } },
      );
      const trailer = showDoc?.trailers_playback_urls?.[0] ?? null;
      if (trailer) {
        videoUrl = trailer.s3Url || trailer.s3_url || null;
        episodeMeta = {
          id,
          _key: trailer._key,
          title: `Trailer ${trailerKey.slice(0, 6)}`,
          s3_url: videoUrl,
          kind: 'trailer',
          show_title: showDoc.title || null,
          show_slug: showDoc.slug || null,
          duration: trailer.duration ?? null,
          existing_gcp_url: trailer.gcpUrl ?? null,
        };
      }
    } else {
      const showWithEp = await masterDb.collection('showcache').findOne(
        { 'episodes.id': id },
        { projection: { 'episodes.$': 1, title: 1 } },
      );
      episodeMeta = showWithEp?.episodes?.[0] ?? null;
      videoUrl = episodeMeta?.s3_url ?? null;
    }

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
