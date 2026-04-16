import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

/**
 * GET /api/s3-notifications/episode/[episodeId]
 * Returns S3 URL changes for a specific episode.
 */
export async function GET(_request, { params }) {
  try {
    const episodeId = params.episodeId;
    if (!episodeId) {
      return NextResponse.json({ error: 'Missing episodeId' }, { status: 400 });
    }

    const client = await clientPromise();
    const db = client.db('master');

    const changes = await db
      .collection('s3_url_changes')
      .find({ episode_id: episodeId })
      .sort({ changed_at: -1 })
      .limit(50)
      .toArray();

    const items = changes.map((c) => ({
      _id: String(c._id),
      show_id: c.show_id,
      show_title: c.show_title,
      episode_id: c.episode_id,
      episode_title: c.episode_title,
      episode_number: c.episode_number,
      field: c.field,
      old_url: c.old_url,
      new_url: c.new_url,
      changed_by: c.changed_by,
      changed_at: c.changed_at,
    }));

    return NextResponse.json({ changes: items, total: items.length });
  } catch (err) {
    console.error('[GET /api/s3-notifications/episode/[episodeId]]', err);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}
