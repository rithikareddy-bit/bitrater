import { NextResponse } from 'next/server';
import { getProdShowcase } from '@/lib/uploadMongo';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const col = await getProdShowcase();
    // Count episodes inside Mongo via $size instead of projecting the full
    // `episodes` arrays back to the app (which pulled ~5.8 MB for ~177 shows
    // and made this route take ~8s, causing client JSON-parse timeouts).
    const docs = await col.aggregate([
      { $project: {
          slug: 1,
          title: 1,
          updated_at: 1,
          episodeCount: {
            $cond: [
              { $isNumber: '$episode_count' },
              '$episode_count',
              { $size: { $ifNull: ['$episodes', []] } },
            ],
          },
      } },
      { $sort: { updated_at: -1, _id: -1 } },
      { $limit: 500 },
    ]).toArray();

    const shows = docs.map((s) => ({
      _id: String(s._id),
      slug: s.slug,
      title: s.title || s.slug,
      episodeCount: s.episodeCount || 0,
    }));
    return NextResponse.json({ shows });
  } catch (err) {
    console.error('[GET /api/uploads/shows]', err);
    return NextResponse.json({ error: err.message || 'fetch failed' }, { status: 500 });
  }
}
