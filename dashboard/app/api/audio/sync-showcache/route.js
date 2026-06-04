import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// The audio playback URL lives in chai_q_lab.audio_episodes.public_master_url.
// "Sync" copies it into master.podcast_showcache.episodes[].signed_playback_url
// (a new field, created on $set if absent) so the catalog points at the rendition.
// Audio is served unsigned (public bucket / unsigned CDN path), so this is a plain
// copy — no signer Lambda involved. See AUDIO-MONGO-REFERENCE.md / AUDIO-PIPELINE-PLAN.md.

const PLAYBACK_FIELD = 'signed_playback_url';

// Write the playback URL onto one showcache episode, keyed off episodes.id
// (same convention as video's showcache). $set creates the field if missing.
async function writeOne(masterDb, episodeId, url) {
  const res = await masterDb.collection('podcast_showcache').updateOne(
    { 'episodes.id': episodeId },
    { $set: { [`episodes.$[ep].${PLAYBACK_FIELD}`]: url } },
    { arrayFilters: [{ 'ep.id': episodeId }] },
  );
  return res.modifiedCount > 0 || res.matchedCount > 0;
}

/**
 * POST /api/audio/sync-showcache
 * Body: { episodeId }  — sync one episode
 *   or  { slug }       — sync every episode of the show that has a playback URL
 *
 * Reads public_master_url from chai_q_lab.audio_episodes and writes it to
 * master.podcast_showcache.episodes[].signed_playback_url.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { episodeId, slug } = body || {};

  try {
    const client = await clientPromise();
    const masterDb = client.db('master');
    const labDb = client.db('chai_q_lab');

    // ── single episode ────────────────────────────────────────────────
    if (episodeId && typeof episodeId === 'string') {
      const labDoc = await labDb.collection('audio_episodes').findOne(
        { episode_id: episodeId },
        { projection: { public_master_url: 1 } },
      );
      const url = labDoc?.public_master_url;
      if (!url) {
        return NextResponse.json(
          { error: 'No playback URL yet — convert this episode (and let the public copy finish) first' },
          { status: 400 },
        );
      }
      const matched = await writeOne(masterDb, episodeId, url);
      if (!matched) {
        return NextResponse.json({ error: 'Episode not found in podcast_showcache' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, episodeId, signed_playback_url: url });
    }

    // ── whole show ────────────────────────────────────────────────────
    if (slug && typeof slug === 'string') {
      const show = await masterDb.collection('podcast_showcache').findOne(
        { slug },
        { projection: { 'episodes.id': 1 } },
      );
      if (!show) {
        return NextResponse.json({ error: 'podcast not found' }, { status: 404 });
      }
      const ids = (show.episodes || []).map((e) => e.id).filter(Boolean);
      if (ids.length === 0) {
        return NextResponse.json({ slug, synced: 0, skipped: 0, message: 'No episodes to sync' });
      }

      const labDocs = await labDb
        .collection('audio_episodes')
        .find({ episode_id: { $in: ids } }, { projection: { episode_id: 1, public_master_url: 1 } })
        .toArray();
      const urlById = Object.fromEntries(
        labDocs.filter((d) => d.public_master_url).map((d) => [d.episode_id, d.public_master_url]),
      );

      const ready = ids.filter((id) => urlById[id]);
      if (ready.length === 0) {
        return NextResponse.json({
          slug,
          synced: 0,
          skipped: ids.length,
          message: 'No episodes have a playback URL yet — run the pipeline first',
        });
      }

      // One bulk write: a $set per ready episode, each scoped to its own array element.
      const ops = ready.map((id) => ({
        updateOne: {
          filter: { 'episodes.id': id },
          update: { $set: { [`episodes.$[ep].${PLAYBACK_FIELD}`]: urlById[id] } },
          arrayFilters: [{ 'ep.id': id }],
        },
      }));
      const result = await masterDb.collection('podcast_showcache').bulkWrite(ops);

      return NextResponse.json({
        slug,
        synced: ready.length,
        skipped: ids.length - ready.length,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      });
    }

    return NextResponse.json({ error: 'Provide episodeId or slug' }, { status: 400 });
  } catch (err) {
    console.error('[POST /api/audio/sync-showcache]', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
