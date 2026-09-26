import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { DB_LAB, DB_MASTER } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/audio-video/sync-podcast
 * { episodeId, podcastEpisodeId }
 *
 * Writes the Audio-Video run's untokenised master (podcastvideo.m3u8) to
 * master.podcast_showcache.episodes[].video_url on the episode the operator
 * picked. Deliberately narrow:
 *   - only ever writes `video_url`, never audio_url or signed_playback_url
 *   - only ever touches podcast_showcache, never showcache
 *   - refuses unless the podcastvideo master actually exists
 */
export async function POST(request) {
  try {
    const { episodeId, podcastEpisodeId } = await request.json();
    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }
    if (!podcastEpisodeId) {
      return NextResponse.json({ error: 'Select a podcast episode first' }, { status: 400 });
    }

    const client = await clientPromise();
    const labDb = client.db(DB_LAB);
    const masterDb = client.db(DB_MASTER);

    const doc = await labDb.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { podcastvideo_m3u8_url: 1 } },
    );
    const videoUrl = doc?.podcastvideo_m3u8_url;
    if (!videoUrl) {
      return NextResponse.json(
        { error: 'No podcastvideo.m3u8 for this episode — create it first' },
        { status: 400 },
      );
    }

    const show = await masterDb.collection('podcast_showcache').findOne(
      { 'episodes.id': podcastEpisodeId },
      { projection: { slug: 1, title: 1, 'episodes.$': 1 } },
    );
    if (!show) {
      return NextResponse.json(
        { error: `No podcast episode found with id ${podcastEpisodeId}` },
        { status: 404 },
      );
    }

    const result = await masterDb.collection('podcast_showcache').updateOne(
      { 'episodes.id': podcastEpisodeId },
      { $set: { 'episodes.$[ep].video_url': videoUrl } },
      { arrayFilters: [{ 'ep.id': podcastEpisodeId }] },
    );

    return NextResponse.json({
      ok: true,
      video_url: videoUrl,
      podcastEpisodeId,
      episodeTitle: show.episodes?.[0]?.title ?? null,
      showSlug: show.slug ?? null,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    console.error('[POST /api/audio-video/sync-podcast]', err);
    return NextResponse.json({ error: err.message || 'Sync failed' }, { status: 500 });
  }
}
