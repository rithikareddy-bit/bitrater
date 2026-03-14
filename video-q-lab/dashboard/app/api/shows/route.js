import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db('master');
    const shows = await db
      .collection('showcache')
      .find({}, { projection: { _id: 1, title: 1, thumbnail: 1, episodes: 1 } })
      .toArray();

    return NextResponse.json(shows);
  } catch (err) {
    console.error('[GET /api/shows]', err);
    return NextResponse.json({ error: 'Failed to fetch shows' }, { status: 500 });
  }
}
