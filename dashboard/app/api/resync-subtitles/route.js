import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const RESYNC_LAMBDA_ARN = process.env.RESYNC_SUBTITLES_LAMBDA_ARN;

async function listMissingForShow(showId) {
  const client = await clientPromise();
  const masterDb = client.db('master');

  const show = await masterDb.collection('showcache').findOne(
    { _id: new ObjectId(showId) },
    { projection: { 'episodes.id': 1, 'episodes.signed_playback_url': 1 } },
  );
  if (!show) return null;

  // Eligibility = episode has a _combined URL in showcache.
  return (show.episodes || [])
    .filter((e) => e.id && e.signed_playback_url?.includes('_combined'))
    .map((e) => String(e.id));
}

async function listAllCombinedEpisodes() {
  const client = await clientPromise();
  const shows = await client.db('master').collection('showcache').find(
    {},
    { projection: { 'episodes.id': 1, 'episodes.signed_playback_url': 1 } },
  ).toArray();

  const ids = [];
  for (const show of shows) {
    for (const ep of show.episodes || []) {
      if (ep.id && ep.signed_playback_url?.includes('_combined')) {
        ids.push(String(ep.id));
      }
    }
  }
  return ids;
}

async function invokeOneSync(episodeId) {
  const cmd = new InvokeCommand({
    FunctionName: RESYNC_LAMBDA_ARN,
    Payload: Buffer.from(JSON.stringify({ episode_id: episodeId })),
  });
  const result = await lambda.send(cmd);
  let body = {};
  try {
    body = JSON.parse(Buffer.from(result.Payload).toString() || '{}');
  } catch { /* tolerate non-JSON */ }
  if (result.FunctionError) {
    return { episode_id: episodeId, status: 'error', error: body?.errorMessage || 'lambda-error' };
  }
  return body;
}

async function invokeOneAsync(episodeId) {
  // Event-mode invoke: AWS queues the Lambda and returns ~immediately. Lambda
  // runs to completion in the background (Mongo + GCS state is the source of
  // truth). UI polls GET ?showId for remaining count.
  // Never throws — returns { status: 'queued' } or { status: 'invoke-error', error }.
  try {
    const cmd = new InvokeCommand({
      FunctionName: RESYNC_LAMBDA_ARN,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ episode_id: episodeId })),
    });
    await lambda.send(cmd);
    return { episode_id: episodeId, status: 'queued' };
  } catch (err) {
    console.error(`[invokeOneAsync] ${episodeId}:`, err.message);
    return { episode_id: episodeId, status: 'invoke-error', error: err.message };
  }
}

// Batch mode: fires one Lambda per shard of `batchSize` episodes.
// Each Lambda processes its shard serially and fires CDN invalidations
// sequentially at the end — same pattern as fix_subtitle_timestamp_map.py.
// Never throws.
async function invokeBatchAsync(episodeIds) {
  try {
    const cmd = new InvokeCommand({
      FunctionName: RESYNC_LAMBDA_ARN,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ episode_ids: episodeIds })),
    });
    await lambda.send(cmd);
    return { count: episodeIds.length, status: 'queued' };
  } catch (err) {
    console.error(`[invokeBatchAsync] shard of ${episodeIds.length}:`, err.message);
    return { count: episodeIds.length, status: 'invoke-error', error: err.message };
  }
}

/**
 * POST /api/resync-subtitles
 * Body: { episodeId } — single episode
 *   or  { showId }    — fan-out to every episode in the show that has a
 *                       combined master URL but no subtitles_injected.
 */
export async function POST(request) {
  if (!RESYNC_LAMBDA_ARN) {
    return NextResponse.json(
      { error: 'RESYNC_SUBTITLES_LAMBDA_ARN not configured' },
      { status: 500 },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { episodeId, showId, all } = body || {};

  if (episodeId && typeof episodeId === 'string') {
    try {
      const result = await invokeOneSync(episodeId);
      const status = result.status === 'error' ? 500 : 200;
      return NextResponse.json(result, { status });
    } catch (err) {
      console.error('[POST /api/resync-subtitles single]', err);
      return NextResponse.json({ error: err.message || 'Lambda invocation failed' }, { status: 500 });
    }
  }

  if (showId && typeof showId === 'string') {
    if (!ObjectId.isValid(showId)) {
      return NextResponse.json({ error: 'Invalid showId' }, { status: 400 });
    }
    try {
      const targets = await listMissingForShow(showId);
      if (targets === null) {
        return NextResponse.json({ error: 'Show not found' }, { status: 404 });
      }
      if (targets.length === 0) {
        return NextResponse.json({ showId, queued: 0, message: 'No episodes have a combined master yet — nothing to resync' });
      }
      // Async fan-out: AppRunner edge cuts at ~120s; per-episode Lambda is
      // 300s. Queue all invocations in parallel then return — UI polls GET
      // ?showId for the eligible-count to drop.
      const results = await Promise.all(targets.map(invokeOneAsync));
      const failed = results.filter((r) => r.status === 'invoke-error');
      const queued = results.length - failed.length;
      const resp = { showId, queued };
      if (failed.length) resp.invokeErrors = failed.length;
      return NextResponse.json(resp);
    } catch (err) {
      console.error('[POST /api/resync-subtitles show]', err);
      return NextResponse.json({ error: err.message || 'Show fan-out failed' }, { status: 500 });
    }
  }

  if (all === true) {
    try {
      const targets = await listAllCombinedEpisodes();
      if (targets.length === 0) {
        return NextResponse.json({ all: true, queued: 0, message: 'No combined episodes found' });
      }
      // Fire one Lambda per shard of 8 episodes (batch mode).
      // Each Lambda processes its shard serially (~20-25s per episode) and fires
      // CDN invalidations sequentially at the end — avoids CDN rate limiting,
      // same as local script. Shard size 8 gives ~100s margin within 300s timeout.
      const SHARD = 8;
      const shards = [];
      for (let i = 0; i < targets.length; i += SHARD) {
        shards.push(targets.slice(i, i + SHARD));
      }
      const results = await Promise.all(shards.map((s) => invokeBatchAsync(s)));
      const failed = results.filter((r) => r.status === 'invoke-error');
      const queued = results.filter((r) => r.status === 'queued').reduce((s, r) => s + r.count, 0);
      const resp = { all: true, queued, total: targets.length, shards: shards.length };
      if (failed.length) resp.invokeErrors = failed.length;
      return NextResponse.json(resp);
    } catch (err) {
      console.error('[POST /api/resync-subtitles all]', err);
      return NextResponse.json({ error: err.message || 'All-shows fan-out failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Provide episodeId, showId, or all:true' }, { status: 400 });
}

/**
 * GET /api/resync-subtitles?showId=...
 *   → { eligible: ["epId", ...], total }
 * GET /api/resync-subtitles?episodeId=...
 *   → { eligible: bool, hasCombined: bool, subtitlesInjected: number|null }
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const episodeId = searchParams.get('episodeId');
  const showId = searchParams.get('showId');

  try {
    if (episodeId) {
      const client = await clientPromise();
      const doc = await client.db('chai_q_lab').collection('video_episodes').findOne(
        { episode_id: episodeId },
        { projection: { combined_master_m3u8_url: 1, subtitles_injected: 1 } },
      );
      const hasCombined = Boolean(doc?.combined_master_m3u8_url);
      const subs = doc?.subtitles_injected ?? null;
      // Eligible whenever a combined master exists. Resync is force-overwrite:
      // strips existing entries and rewrites from the current source_language.
      return NextResponse.json({
        eligible: hasCombined,
        hasCombined,
        subtitlesInjected: subs,
      });
    }

    if (showId) {
      if (!ObjectId.isValid(showId)) {
        return NextResponse.json({ error: 'Invalid showId' }, { status: 400 });
      }
      const targets = await listMissingForShow(showId);
      if (targets === null) {
        return NextResponse.json({ error: 'Show not found' }, { status: 404 });
      }
      return NextResponse.json({ eligible: targets, total: targets.length });
    }

    return NextResponse.json({ error: 'Provide episodeId or showId' }, { status: 400 });
  } catch (err) {
    console.error('[GET /api/resync-subtitles]', err);
    return NextResponse.json({ error: 'Failed to check eligibility' }, { status: 500 });
  }
}
