import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normUrl(u) {
  if (u == null || typeof u !== 'string') return '';
  return u.trim();
}

const TRAILER_ID_RE = /^trailer_([a-f0-9]{24})_(.+)$/;

/**
 * POST /api/sync-showcache-trailer
 * Body: { episodeId, signedPlaybackUrl }
 *   episodeId is the synthetic id `trailer_<showObjectId>_<_key>`.
 * Writes master.showcache.trailers_playback_urls.$[t].gcpUrl for the matching _key.
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
    const match = TRAILER_ID_RE.exec(episodeId);
    if (!match) {
      return NextResponse.json(
        { error: 'episodeId is not a trailer id (expected trailer_<showObjectId>_<key>)' },
        { status: 400 },
      );
    }
    const [, showIdHex, trailerKey] = match;
    if (!signedPlaybackUrl) {
      return NextResponse.json({ error: 'signedPlaybackUrl is required' }, { status: 400 });
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    const ve = await labDb.collection('video_episodes').findOne(
      { episode_id: episodeId },
      { projection: { combined_master_m3u8_url: 1 } },
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

    let showObjectId;
    try { showObjectId = new ObjectId(showIdHex); } catch {
      return NextResponse.json({ error: 'Invalid show id in episodeId' }, { status: 400 });
    }

    const result = await masterDb.collection('showcache').updateOne(
      { _id: showObjectId, 'trailers_playback_urls._key': trailerKey },
      { $set: { 'trailers_playback_urls.$[t].gcpUrl': signedPlaybackUrl } },
      { arrayFilters: [{ 't._key': trailerKey }] },
    );

    if (result.matchedCount === 0) {
      return NextResponse.json(
        { error: 'Trailer not found in showcache for the given key' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      trailerKey,
      gcpUrl: signedPlaybackUrl,
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    console.error('[POST /api/sync-showcache-trailer]', err);
    return NextResponse.json({ error: 'Failed to sync trailer to showcache' }, { status: 500 });
  }
}
