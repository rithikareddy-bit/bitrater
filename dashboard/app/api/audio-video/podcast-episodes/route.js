import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

/**
 * GET /api/audio-video/podcast-episodes
 *
 * Flat list of every episode in master.podcast_showcache, for the Sync picker
 * on the Audio-Video page. The two catalogs do not share episode ids — a
 * podcast episode has its own UUID — so the operator picks the target episode
 * by title rather than the code guessing a mapping from slugs.
 */
export async function GET() {
  try {
    const client = await clientPromise();
    const shows = await client
      .db('master')
      .collection('podcast_showcache')
      .find({}, { projection: { slug: 1, title: 1, episodes: 1 } })
      .toArray();

    const episodes = [];
    for (const show of shows) {
      for (const ep of show.episodes || []) {
        if (!ep?.id) continue;
        episodes.push({
          id: String(ep.id),
          title: ep.title ?? null,
          episodeNumber: ep.episode_number ?? null,
          showSlug: show.slug ?? null,
          showTitle: show.title ?? null,
          hasVideoUrl: Boolean(ep.video_url),
          videoUrl: ep.video_url ?? null,
        });
      }
    }

    episodes.sort((a, b) => {
      const s = String(a.showSlug).localeCompare(String(b.showSlug));
      if (s !== 0) return s;
      return (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0);
    });

    return NextResponse.json({ episodes, total: episodes.length });
  } catch (err) {
    console.error('[GET /api/audio-video/podcast-episodes]', err);
    return NextResponse.json({ error: 'Failed to load podcast episodes' }, { status: 500 });
  }
}
