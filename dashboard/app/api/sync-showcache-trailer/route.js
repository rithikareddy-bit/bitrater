import { NextResponse } from 'next/server';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TRAILER_ID_RE = /^trailer_([a-f0-9]{24})_(.+)$/;

/**
 * POST /api/sync-showcache-trailer
 * Body: { episodeId }  (synthetic trailer id: `trailer_<showObjectId>_<_key>`)
 *
 * Invokes the resigner Lambda synchronously; resigner writes the signed URL
 * into master.showcache.trailers_playback_urls[*].gcpUrl for us.
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
    const match = TRAILER_ID_RE.exec(episodeId);
    if (!match) {
      return NextResponse.json(
        { error: 'episodeId is not a trailer id (expected trailer_<showObjectId>_<key>)' },
        { status: 400 },
      );
    }
    const trailerKey = match[2];

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
    const { ObjectId } = await import('mongodb');

    const ve = await labDb.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { combined_master_m3u8_url: 1 } },
    );

    let canonicalUrl = ve?.combined_master_m3u8_url || null;
    if (!canonicalUrl) {
      let showObjectId;
      try { showObjectId = new ObjectId(match[1]); } catch { showObjectId = null; }
      if (showObjectId) {
        const show = await masterDb.collection('showcache').findOne(
          { _id: showObjectId, 'trailers_playback_urls._key': trailerKey },
          { projection: { 'trailers_playback_urls.$': 1 } },
        );
        const trUrl = show?.trailers_playback_urls?.[0]?.gcpUrl;
        if (typeof trUrl === 'string' && trUrl.includes('_combined.m3u8')) {
          canonicalUrl = trUrl.split('?', 1)[0];
        }
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
      console.error('[POST /api/sync-showcache-trailer] Lambda error:', errMsg);
      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    if (resigner?.skipped) {
      return NextResponse.json(
        { error: `Resigner skipped this trailer: ${resigner.skipped}` },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      trailerKey,
      gcpUrl: resigner.signed_url,
      signed_playback_expires_at: resigner.expires,
    });
  } catch (err) {
    console.error('[POST /api/sync-showcache-trailer]', err);
    return NextResponse.json({ error: 'Failed to sync trailer to showcache' }, { status: 500 });
  }
}
