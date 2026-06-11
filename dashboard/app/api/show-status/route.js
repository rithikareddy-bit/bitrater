import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const COMBINED_KEYWORD = 'combined';

const LANG_ALIAS = { kan: 'kn' }; // legacy "kan" → "kn"
function normalizeLang(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  return LANG_ALIAS[s] || s;
}

function urlHasCombined(url) {
  return typeof url === 'string' && url.toLowerCase().includes(COMBINED_KEYWORD);
}

/**
 * GET /api/show-status?language=te
 *
 * For every show that matches the language filter, report whether each
 * episode's signed playback URL is a "combined" master (keyword check
 * against the GCP/CDN URL). Shows are bucketed:
 *   - full    : every episode has a combined URL
 *   - partial : at least one (but not all) episodes have a combined URL
 *   - none    : zero episodes have a combined URL
 *
 * `language` accepts: te, hi, kn (kan is canonicalised), en, etc., or
 * "unknown" / "all". Default is "all".
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const wantLang = (searchParams.get('language') || 'all').toLowerCase();

    let langMatch = null;
    if (wantLang && wantLang !== 'all') {
      if (wantLang === 'unknown' || wantLang === 'null' || wantLang === 'none') {
        langMatch = { $or: [{ language: { $exists: false } }, { language: null }, { language: '' }] };
      } else if (wantLang === 'kn' || wantLang === 'kan') {
        langMatch = { language: { $in: ['kn', 'kan', 'KN', 'KAN'] } };
      } else {
        langMatch = { language: wantLang };
      }
    }

    const client = await clientPromise();
    const db = client.db('master');

    const docs = await db.collection('showcache')
      .find(langMatch || {}, {
        projection: {
          _id: 1,
          slug: 1,
          title: 1,
          language: 1,
          updated_at: 1,
          'episodes.id': 1,
          'episodes.episode_number': 1,
          'episodes.title': 1,
          'episodes.signed_playback_url': 1,
        },
      })
      .toArray();

    const shows = docs.map((doc) => {
      const episodes = Array.isArray(doc.episodes) ? doc.episodes : [];
      const total = episodes.length;
      let combinedCount = 0;
      let noUrlCount = 0;
      const missing = [];
      for (const ep of episodes) {
        if (urlHasCombined(ep?.signed_playback_url)) {
          combinedCount += 1;
        } else {
          const hasUrl = Boolean(ep?.signed_playback_url);
          if (!hasUrl) noUrlCount += 1;
          missing.push({
            id: ep?.id ?? null,
            episode_number: ep?.episode_number ?? null,
            title: ep?.title ?? null,
            has_url: hasUrl,
          });
        }
      }

      let status;
      if (total === 0) status = 'empty';
      else if (combinedCount === 0) status = 'none';
      else if (combinedCount === total) status = 'full';
      else status = 'partial';

      return {
        _id: doc._id,
        slug: doc.slug ?? null,
        title: doc.title ?? 'Untitled',
        language: normalizeLang(doc.language),
        episode_total: total,
        episode_combined: combinedCount,
        status,
        missing_sample: missing.slice(0, 5),
        missing_count: missing.length,
        no_url_count: noUrlCount,
        updated_at: doc.updated_at instanceof Date
          ? doc.updated_at.toISOString()
          : (doc.updated_at ?? null),
      };
    });

    // Sort: partial first (the actionable bucket), then none, then full,
    // then empty. Within bucket, larger shows first.
    const order = { partial: 0, none: 1, full: 2, empty: 3 };
    shows.sort((a, b) => {
      const oa = order[a.status] ?? 9;
      const ob = order[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      return (b.episode_total || 0) - (a.episode_total || 0);
    });

    const summary = shows.reduce(
      (acc, s) => {
        acc[s.status] = (acc[s.status] || 0) + 1;
        acc.total_shows += 1;
        acc.total_episodes += s.episode_total;
        acc.total_combined_episodes += s.episode_combined;
        return acc;
      },
      { full: 0, partial: 0, none: 0, empty: 0, total_shows: 0, total_episodes: 0, total_combined_episodes: 0 },
    );

    return NextResponse.json(
      { language: wantLang, summary, shows },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/show-status]', err);
    return NextResponse.json({ error: 'Failed to load show status' }, { status: 500 });
  }
}
