import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

/**
 * GET /api/s3-notifications/[showId]
 * Returns S3 URL changes for a specific show (all episodes + show-level changes).
 * showId can be either a MongoDB ObjectId or a Sanity document ID.
 */
export async function GET(_request, { params }) {
  try {
    const rawId = params.showId;
    if (!rawId) {
      return NextResponse.json({ error: 'Missing showId' }, { status: 400 });
    }

    const client = await clientPromise();
    const db = client.db('master');

    // If the ID looks like an ObjectId, resolve it to the Sanity `id` field
    let sanityShowId = rawId;
    if (ObjectId.isValid(rawId)) {
      const show = await db.collection('showcache').findOne(
        { _id: new ObjectId(rawId) },
        { projection: { id: 1 } }
      );
      if (show?.id) sanityShowId = show.id;
    }

    const changes = await db
      .collection('s3_url_changes')
      .find({ show_id: sanityShowId })
      .sort({ changed_at: -1 })
      .limit(100)
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
    console.error('[GET /api/s3-notifications/[showId]]', err);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}
