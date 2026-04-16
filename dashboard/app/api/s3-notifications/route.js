import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

/**
 * GET /api/s3-notifications
 * Returns all S3 URL changes sorted by date (newest first).
 * Optional query param: ?showId=xxx to filter by show.
 */
export async function GET(request) {
  try {
    const { searchParams } = request.nextUrl;
    const showId = searchParams.get('showId');
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 200);

    const client = await clientPromise();
    const db = client.db('master');

    const filter = {};
    if (showId) filter.show_id = showId;

    const changes = await db
      .collection('s3_url_changes')
      .find(filter)
      .sort({ changed_at: -1 })
      .limit(limit)
      .toArray();

    // Group by date for the UI
    const grouped = {};
    for (const change of changes) {
      const dateKey = change.changed_at
        ? new Date(change.changed_at).toISOString().split('T')[0]
        : 'unknown';
      if (!grouped[dateKey]) grouped[dateKey] = [];
      grouped[dateKey].push({
        _id: String(change._id),
        show_id: change.show_id,
        show_title: change.show_title,
        episode_id: change.episode_id,
        episode_title: change.episode_title,
        episode_number: change.episode_number,
        field: change.field,
        old_url: change.old_url,
        new_url: change.new_url,
        changed_by: change.changed_by,
        changed_at: change.changed_at,
      });
    }

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

    return NextResponse.json({ changes: items, grouped, total: items.length });
  } catch (err) {
    console.error('[GET /api/s3-notifications]', err);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}
