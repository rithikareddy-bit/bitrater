import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const body = await request.json();
    const { showId } = body || {};
    if (!showId || typeof showId !== 'string') {
      return NextResponse.json({ error: 'showId is required' }, { status: 400 });
    }

    let showObjectId;
    try { showObjectId = new ObjectId(showId); } catch {
      return NextResponse.json({ error: 'Invalid showId' }, { status: 400 });
    }

    const client = await clientPromise();
    const labDb = client.db('chai_q_lab');
    const masterDb = client.db('master');

    // 1. Find show in showcase
    const show = await masterDb.collection('showcache').findOne({ _id: showObjectId });
    if (!show) return NextResponse.json({ error: 'Show not found' }, { status: 404 });

    // 2. Collect episode IDs from showcache
    const episodeIds = (Array.isArray(show.episodes) ? show.episodes : [])
      .map(ep => ep?.id)
      .filter(Boolean)
      .map(String);

    if (episodeIds.length === 0) {
      return NextResponse.json({ error: 'No episodes found in show' }, { status: 400 });
    }

    // 3. Read combined_master_m3u8_url for each episode from video_episodes
    const videoDocs = await labDb.collection('video_episodes')
      .find({ episode_id: { $in: episodeIds } }, { projection: { episode_id: 1, combined_master_m3u8_url: 1 } })
      .toArray();

    const urlMap = new Map(videoDocs.map(d => [d.episode_id, d.combined_master_m3u8_url || null]));
    const readyIds = episodeIds.filter(id => urlMap.get(id));

    if (readyIds.length === 0) {
      return NextResponse.json({ error: 'No episodes ready to sync (no combined URL found)' }, { status: 400 });
    }

    // 4. Sync each ready episode
    const baseUrl = process.env.APP_BASE_URL ||
      (process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:3000');

    const synced = [];
    const failed = [];

    for (const episodeId of readyIds) {
      const signedPlaybackUrl = urlMap.get(episodeId);
      try {
        const res = await fetch(`${baseUrl}/api/sync-showcache-episode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeId, signedPlaybackUrl }),
        });
        if (res.ok) {
          synced.push(episodeId);
        } else {
          const errData = await res.json().catch(() => ({}));
          failed.push({ episodeId, error: errData.error || `HTTP ${res.status}` });
        }
      } catch (err) {
        failed.push({ episodeId, error: err.message || 'Network error' });
      }
    }

    // 5. Update pipeline_run episode status → SYNCED (best-effort)
    if (synced.length > 0) {
      const now = new Date();
      try {
        const runs = await labDb.collection('pipeline_runs')
          .find({ show_id: showId, status: { $in: ['RUNNING', 'COMPLETED'] } }, { projection: { _id: 1 } })
          .toArray();

        for (const run of runs) {
          for (const episodeId of synced) {
            await labDb.collection('pipeline_runs').updateOne(
              { _id: run._id, 'episodes.episode_id': episodeId },
              { $set: { 'episodes.$.status': 'SYNCED', 'episodes.$.synced_at': now } },
            );
          }
        }
      } catch (err) {
        console.warn('[sync-all] Failed to update pipeline_run episode status:', err.message);
      }
    }

    return NextResponse.json({ synced, failed });
  } catch (err) {
    console.error('[POST /api/auto-pipeline/sync-all]', err);
    return NextResponse.json({ error: 'Failed to sync show' }, { status: 500 });
  }
}
