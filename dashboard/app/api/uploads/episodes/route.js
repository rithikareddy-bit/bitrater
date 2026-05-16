import { NextResponse } from 'next/server';
import { getProdShowcase } from '@/lib/uploadMongo';
import { sanitizeSlug } from '@/lib/uploadConfig';

export async function GET(request) {
  try {
    const { searchParams } = request.nextUrl;
    const slug = sanitizeSlug(searchParams.get('slug'));
    if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

    const col = await getProdShowcase();
    const show = await col.findOne({ slug }, { projection: { slug: 1, title: 1, episodes: 1 } });
    if (!show) return NextResponse.json({ error: 'show not found' }, { status: 404 });

    const episodes = (Array.isArray(show.episodes) ? show.episodes : [])
      .map((e) => ({
        id: e?.id || null,
        title: e?.title || null,
        episode_number: e?.episode_number ?? null,
        s3_url: e?.s3_url || null,
        s3_url_updated_at: e?.s3_url_updated_at || null,
        s3_url_previous: e?.s3_url_previous || null,
      }))
      .filter((e) => e.episode_number != null)
      .sort((a, b) => Number(a.episode_number) - Number(b.episode_number));

    return NextResponse.json({ slug: show.slug, title: show.title, episodes });
  } catch (err) {
    console.error('[GET /api/uploads/episodes]', err);
    return NextResponse.json({ error: err.message || 'fetch failed' }, { status: 500 });
  }
}
