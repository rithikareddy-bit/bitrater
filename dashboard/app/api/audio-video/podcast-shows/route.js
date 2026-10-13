import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { DB_MASTER } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/audio-video/podcast-shows
 *
 * Show picker for the Audio-Video page — podcasts only, straight from
 * master.podcast_showcache (not showcache). Episode sources are each
 * episode's s3_url; withS3Url counts how many have one.
 */
export async function GET() {
  try {
    const client = await clientPromise();
    const docs = await client
      .db(DB_MASTER)
      .collection('podcast_showcache')
      .find({}, { projection: { title: 1, slug: 1, language: 1, active: 1, 'episodes.s3_url': 1 } })
      .toArray();

    const shows = docs.map((d) => {
      const eps = Array.isArray(d.episodes) ? d.episodes : [];
      return {
        _id: String(d._id),
        title: d.title ?? d.slug ?? 'Untitled',
        slug: d.slug ?? null,
        language: d.language ?? null,
        active: d.active ?? null,
        episodeCount: eps.length,
        withS3Url: eps.filter((e) => e?.s3_url).length,
      };
    });
    shows.sort((a, b) => String(a.title).localeCompare(String(b.title)));

    return NextResponse.json({ shows, total: shows.length });
  } catch (err) {
    console.error('[GET /api/audio-video/podcast-shows]', err);
    return NextResponse.json({ error: 'Failed to load podcast shows' }, { status: 500 });
  }
}
