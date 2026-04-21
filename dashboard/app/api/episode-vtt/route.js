import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import { videoIdFromS3Url } from '@/lib/videoId';

const DEFAULT_DB = process.env.MONGO_DATABASE || 'master';
const SHOWCACHE = process.env.MONGO_SHOWCACHE_COLLECTION || 'showcache';
const EPISODE_COLLECTION = process.env.MONGO_EPISODE_COLLECTION || 'episode';
const VTT_COLLECTION = process.env.MONGO_VTT_COLLECTION || 'episode_vtt';

/**
 * POST /api/episode-vtt — thumbnail WebP + VTT (delegates to VTT worker when configured).
 * Skip: 200 + { ok, skipped: true, message } if episode_vtt exists or vtt_url already set.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const episodeId = body.episodeId;
    const force = body.force === true;
    if (!episodeId) {
      return NextResponse.json({ error: 'episodeId is required' }, { status: 400 });
    }

    const client = await clientPromise();
    const masterDb = client.db(DEFAULT_DB);

    const showWithEp = await masterDb.collection(SHOWCACHE).findOne(
      { 'episodes.id': episodeId },
      { projection: { 'episodes.$': 1 } },
    );
    const ep = showWithEp?.episodes?.[0];
    if (!ep) {
      return NextResponse.json(
        { error: 'Episode not found in show catalog (showcache)' },
        { status: 404 },
      );
    }

    const s3Url = ep.s3_url;
    if (!s3Url) {
      return NextResponse.json({ error: 'No s3_url for this episode' }, { status: 400 });
    }

    const showId = showWithEp._id;
    const episodeMongoId = ep.id;
    const existingVttOnEpisode = ep.vtt_url;
    if (!force && existingVttOnEpisode && String(existingVttOnEpisode).trim()) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        message: 'vtt_url already present — skipped',
        vtt_url: String(existingVttOnEpisode).trim(),
      });
    }

    const episodeDoc = await masterDb.collection(EPISODE_COLLECTION).findOne(
      { id: episodeId },
      { projection: { vtt_url: 1 } },
    );
    if (!force && episodeDoc?.vtt_url && String(episodeDoc.vtt_url).trim()) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        message: 'vtt_url already present — skipped',
        vtt_url: String(episodeDoc.vtt_url).trim(),
      });
    }

    const videoId = videoIdFromS3Url(s3Url);
    if (!videoId) {
      return NextResponse.json({ error: 'Could not derive video_id from s3_url' }, { status: 400 });
    }

    const existingVtt = await masterDb.collection(VTT_COLLECTION).findOne(
      { video_id: videoId },
      { projection: { vtt_url: 1, sprite_url: 1 } },
    );
    if (!force && existingVtt) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        message: 'vtt_url already present — skipped',
        vtt_url: existingVtt.vtt_url || null,
        sprite_url: existingVtt.sprite_url || null,
      });
    }

    const workerUrl = (
      process.env.VTT_WORKER_URL
      || process.env.VTT_SERVICE_URL
      || ''
    ).replace(/\/$/, '');
    if (!workerUrl) {
      return NextResponse.json(
        {
          error:
            'VTT worker not configured (set VTT_WORKER_URL or VTT_SERVICE_URL). Run vtt-worker locally or deploy to Cloud Run.',
        },
        { status: 501 },
      );
    }

    const durationRaw = ep.duration;
    const durationSec = durationRaw != null && Number(durationRaw) > 0 ? Number(durationRaw) : 0;

    const secret = process.env.VTT_WORKER_SECRET;
    const headers = {
      'Content-Type': 'application/json',
    };
    if (secret) {
      headers['X-VTT-Worker-Secret'] = secret;
    }

    const payload = {
      episode_id: episodeId,
      s3_url: s3Url.trim(),
      video_id: videoId,
      duration_sec: durationSec,
      show_id: showId != null ? String(showId) : null,
      episode_mongo_id: episodeMongoId != null ? episodeMongoId : episodeId,
    };

    let workerRes;
    try {
      workerRes = await fetch(`${workerUrl}/process`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(900_000),
      });
    } catch (fetchErr) {
      console.error('[POST /api/episode-vtt] worker fetch', fetchErr);
      return NextResponse.json(
        { error: `VTT worker unreachable: ${fetchErr.message || fetchErr}` },
        { status: 502 },
      );
    }

    const text = await workerRes.text();
    let data = {};
    try {
      if (text) data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!workerRes.ok) {
      return NextResponse.json(
        { error: data.error || data.message || `VTT worker failed (${workerRes.status})` },
        { status: workerRes.status >= 400 && workerRes.status < 600 ? workerRes.status : 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      skipped: false,
      vtt_url: data.vtt_url ?? null,
      sprite_url: data.sprite_url ?? null,
      message: data.message || 'Thumbnail VTT generation complete',
    });
  } catch (err) {
    console.error('[POST /api/episode-vtt]', err);
    return NextResponse.json({ error: 'Failed to process episode VTT request' }, { status: 500 });
  }
}
