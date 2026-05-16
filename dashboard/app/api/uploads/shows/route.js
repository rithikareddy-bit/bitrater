import { NextResponse } from 'next/server';
import { getProdShowcase } from '@/lib/uploadMongo';

export async function GET() {
  try {
    const col = await getProdShowcase();
    const docs = await col
      .find({}, { projection: { slug: 1, title: 1, episode_count: 1, episodes: 1, updated_at: 1 } })
      .sort({ updated_at: -1, _id: -1 })
      .limit(500)
      .toArray();

    const shows = docs.map((s) => ({
      _id: String(s._id),
      slug: s.slug,
      title: s.title || s.slug,
      episodeCount: typeof s.episode_count === 'number'
        ? s.episode_count
        : Array.isArray(s.episodes) ? s.episodes.length : 0,
    }));
    return NextResponse.json({ shows });
  } catch (err) {
    console.error('[GET /api/uploads/shows]', err);
    return NextResponse.json({ error: err.message || 'fetch failed' }, { status: 500 });
  }
}
