import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { resolveShowPosterUrl } from '@/lib/posterUrl';

export async function GET(_request, { params }) {
  try {
    const id = params.id;
    if (!id || !ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid show id' }, { status: 400 });
    }

    const client = await clientPromise();
    const db = client.db('master');
    const show = await db.collection('showcache').findOne({ _id: new ObjectId(id) });

    if (!show) {
      return NextResponse.json({ error: 'Show not found' }, { status: 404 });
    }

    const episodeCount =
      typeof show.episode_count === 'number'
        ? show.episode_count
        : Array.isArray(show.episodes)
          ? show.episodes.length
          : 0;
    const posterUrl = resolveShowPosterUrl(show);
    const thumbnail =
      posterUrl || show.thumbnail || show.s3_primary_poster_id || show.preview_gif || null;

    const updatedAt =
      show.updated_at instanceof Date
        ? show.updated_at.toISOString()
        : typeof show.updated_at === 'string'
          ? show.updated_at
          : null;
    const createdAt =
      show.created_at instanceof Date
        ? show.created_at.toISOString()
        : typeof show.created_at === 'string'
          ? show.created_at
          : null;

    return NextResponse.json({
      ...show,
      posterUrl,
      thumbnail,
      episodeCount,
      updatedAt,
      createdAt,
    });
  } catch (err) {
    console.error('[GET /api/shows/[id]]', err);
    return NextResponse.json({ error: 'Failed to fetch show' }, { status: 500 });
  }
}