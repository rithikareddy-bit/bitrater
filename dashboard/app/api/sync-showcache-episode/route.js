import { NextResponse } from 'next/server';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import clientPromise from '@/lib/mongodb';
import { buildDownloadConfig } from '@/lib/downloadConfig';
import { resolveDurationForLabEpisode } from '@/lib/labEpisodeDuration';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * POST /api/sync-showcache-episode
 * Body: { episodeId }
 *
 * Invokes the resigner Lambda synchronously so showcache is updated with a
 * freshly-signed URL. Also writes download_config alongside (derived from the
 * lab's golden_recipes + episode duration).
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
    if (!episodeId || typeof episodeId !== 'string') {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const lambdaArn = process.env.RESIGN_PLAYBACK_URLS_LAMBDA_ARN;
    if (!lambdaArn) {
      return NextResponse.json(
        { error: 'RESIGN_PLAYBACK_URLS_LAMBDA_ARN not configured' },
        { status: 500 },
      );
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    const ve = await labDb.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { combined_master_m3u8_url: 1, golden_recipes: 1 } },
    );

    // Prefer canonical URL from lab DB; fall back to showcache for legacy episodes
    // whose video_episodes doc was cleared but still have a combined URL live in showcache.
    let canonicalUrl = ve?.combined_master_m3u8_url || null;
    if (!canonicalUrl) {
      const show = await masterDb.collection('showcache').findOne(
        { 'episodes.id': episodeId },
        { projection: { 'episodes.$': 1 } },
      );
      const epUrl = show?.episodes?.[0]?.signed_playback_url;
      if (typeof epUrl === 'string' && epUrl.includes('_combined.m3u8')) {
        canonicalUrl = epUrl.split('?', 1)[0];
      }
    }

    if (!canonicalUrl) {
      return NextResponse.json(
        { error: 'No combined master URL found in lab DB or showcache — run Create Combined URL first' },
        { status: 400 },
      );
    }

    const payload = JSON.stringify({
      episode_id: episodeId,
      canonical_url: canonicalUrl,
    });
    const result = await lambda.send(new InvokeCommand({
      FunctionName: lambdaArn,
      Payload: Buffer.from(payload),
    }));
    const resigner = JSON.parse(Buffer.from(result.Payload).toString());

    if (result.FunctionError) {
      const errMsg = resigner?.errorMessage || 'Resigner Lambda invocation failed';
      console.error('[POST /api/sync-showcache-episode] Lambda error:', errMsg);
      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    if (resigner?.skipped) {
      return NextResponse.json(
        { error: `Resigner skipped this episode: ${resigner.skipped}` },
        { status: 400 },
      );
    }

    const show = await masterDb.collection('showcache').findOne({ 'episodes.id': episodeId });
    const ep = Array.isArray(show?.episodes)
      ? show.episodes.find((e) => e && String(e.id) === String(episodeId))
      : null;

    const { durationSeconds: durationSec, durationSource } = await resolveDurationForLabEpisode(
      labDb,
      ep,
      episodeId,
    );
    const downloadConfig = buildDownloadConfig(ve?.golden_recipes, durationSec, durationSource);

    const dcResult = await masterDb.collection('showcache').updateOne(
      { 'episodes.id': episodeId },
      { $set: { 'episodes.$[ep].download_config': downloadConfig } },
      { arrayFilters: [{ 'ep.id': episodeId }] },
    );

    return NextResponse.json({
      ok: true,
      signed_playback_url: resigner.signed_url,
      signed_playback_expires_at: resigner.expires,
      download_config: downloadConfig,
      modifiedCount: dcResult.modifiedCount,
    });
  } catch (err) {
    console.error('[POST /api/sync-showcache-episode]', err);
    return NextResponse.json({ error: 'Failed to sync show catalog' }, { status: 500 });
  }
}
