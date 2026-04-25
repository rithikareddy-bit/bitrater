import { NextResponse } from 'next/server';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TRAILER_ID_RE = /^trailer_([a-f0-9]{24})_(.+)$/;

/**
 * POST /api/signing/resign
 * Body: { episode_id?: string }
 *
 * With episode_id → targeted re-sign. Without → full sweep.
 * For targeted mode, prefer canonical from lab DB; fall back to showcache for
 * legacy items whose video_episodes doc was cleared but still hold a combined
 * URL live in showcache. Mirrors the sync-route contract.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const episodeId = body?.episode_id;

    const lambdaArn = process.env.RESIGN_PLAYBACK_URLS_LAMBDA_ARN;
    if (!lambdaArn) {
      return NextResponse.json(
        { error: 'RESIGN_PLAYBACK_URLS_LAMBDA_ARN not configured' },
        { status: 500 },
      );
    }

    let payload;
    if (episodeId) {
      const client = await clientPromise();
      const labDb = client.db('chai_q_lab');
      const masterDb = client.db('master');

      const ve = await labDb.collection('video_episodes').findOne(
        { episode_id: episodeId },
        { projection: { combined_master_m3u8_url: 1 } },
      );

      let canonicalUrl = ve?.combined_master_m3u8_url || null;

      if (!canonicalUrl) {
        const trailerMatch = TRAILER_ID_RE.exec(episodeId);
        if (trailerMatch) {
          const { ObjectId } = await import('mongodb');
          const trailerKey = trailerMatch[2];
          let showObjectId;
          try { showObjectId = new ObjectId(trailerMatch[1]); } catch { showObjectId = null; }
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
        } else {
          const show = await masterDb.collection('showcache').findOne(
            { 'episodes.id': episodeId },
            { projection: { 'episodes.$': 1 } },
          );
          const epUrl = show?.episodes?.[0]?.signed_playback_url;
          if (typeof epUrl === 'string' && epUrl.includes('_combined.m3u8')) {
            canonicalUrl = epUrl.split('?', 1)[0];
          }
        }
      }

      if (!canonicalUrl) {
        return NextResponse.json(
          { error: 'No combined master URL found in lab DB or showcache' },
          { status: 400 },
        );
      }

      payload = { episode_id: episodeId, canonical_url: canonicalUrl };
    } else {
      payload = {};
    }

    const result = await lambda.send(new InvokeCommand({
      FunctionName: lambdaArn,
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    const response = JSON.parse(Buffer.from(result.Payload).toString());

    if (result.FunctionError) {
      const errMsg = response?.errorMessage || 'Resigner Lambda invocation failed';
      console.error('[POST /api/signing/resign] Lambda error:', errMsg);
      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    return NextResponse.json(response);
  } catch (err) {
    console.error('[POST /api/signing/resign]', err);
    return NextResponse.json({ error: 'Failed to invoke resigner' }, { status: 500 });
  }
}
