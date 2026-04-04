import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { buildDownloadConfig } from '@/lib/downloadConfig';
import { resolveDurationForLabEpisode } from '@/lib/labEpisodeDuration';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normUrl(u) {
  if (u == null || typeof u !== 'string') return '';
  return u.trim();
}

/**
 * POST /api/sync-showcache-episode
 * Body: { episodeId, signedPlaybackUrl, downloadConfig? }
 * Writes master.showcache episodes.$.signed_playback_url and download_config.
 */
export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const episodeId = body?.episodeId;
    const signedPlaybackUrl = normUrl(body?.signedPlaybackUrl);

    if (!episodeId || typeof episodeId !== 'string') {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }
    if (!signedPlaybackUrl) {
      return NextResponse.json({ error: 'signedPlaybackUrl is required' }, { status: 400 });
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    const ve = await labDb.collection('video_episodes').findOne(
      { episode_id: episodeId },
      {
        projection: {
          combined_master_m3u8_url: 1,
          golden_recipes: 1,
        },
      },
    );

    if (!ve?.combined_master_m3u8_url) {
      return NextResponse.json(
        { error: 'Combined master URL not in lab — create combined master first' },
        { status: 400 },
      );
    }

    const canonical = normUrl(ve.combined_master_m3u8_url);
    if (canonical && signedPlaybackUrl !== canonical) {
      return NextResponse.json(
        { error: 'signedPlaybackUrl does not match lab combined_master_m3u8_url' },
        { status: 400 },
      );
    }

    const show = await masterDb.collection('showcache').findOne({ 'episodes.id': episodeId });
    if (!show) {
      return NextResponse.json({ error: 'Episode not found in show catalog (showcache)' }, { status: 404 });
    }

    const ep = Array.isArray(show.episodes)
      ? show.episodes.find((e) => e && String(e.id) === String(episodeId))
      : null;
    if (!ep) {
      return NextResponse.json({ error: 'Episode id not in showcache episodes array' }, { status: 404 });
    }

    const { durationSeconds: durationSec, durationSource } = await resolveDurationForLabEpisode(
      labDb,
      ep,
      episodeId,
    );

    const downloadConfig = buildDownloadConfig(ve.golden_recipes, durationSec, durationSource);

    const result = await masterDb.collection('showcache').updateOne(
      { 'episodes.id': episodeId },
      {
        $set: {
          'episodes.$[ep].signed_playback_url': signedPlaybackUrl,
          'episodes.$[ep].download_config': downloadConfig,
        },
      },
      { arrayFilters: [{ 'ep.id': episodeId }] },
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: 'Show document not found for update' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      signed_playback_url: signedPlaybackUrl,
      download_config: downloadConfig,
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    console.error('[POST /api/sync-showcache-episode]', err);
    return NextResponse.json({ error: 'Failed to sync show catalog' }, { status: 500 });
  }
}
