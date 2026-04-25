import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const COMBINED_MARKER = '_combined.m3u8';

function isSigned(url) {
  return typeof url === 'string'
    && url.includes(COMBINED_MARKER)
    && url.includes('Signature=');
}

function expiresInSeconds(expiresAt) {
  if (!expiresAt) return null;
  const t = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 1000);
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = searchParams.get('filter') || 'all';
    const showFilter = searchParams.get('show') || null;

    const client = await clientPromise();
    const masterDb = client.db('master');
    const labDb = client.db('chai_q_lab');

    const query = showFilter ? { slug: showFilter } : {};
    const shows = await masterDb.collection('showcache')
      .find(query, {
        projection: {
          _id: 1,
          slug: 1,
          title: 1,
          'episodes.id': 1,
          'episodes.episode_number': 1,
          'episodes.title': 1,
          'episodes.signed_playback_url': 1,
          'episodes.signed_playback_expires_at': 1,
          'trailers_playback_urls._key': 1,
          'trailers_playback_urls.gcpUrl': 1,
          'trailers_playback_urls.signed_playback_expires_at': 1,
        },
      })
      .toArray();

    const latestRun = await labDb.collection('playback_resign_runs')
      .find({}, { projection: { errors: 1 } })
      .sort({ started_at: -1 })
      .limit(1)
      .next();
    const errorMap = new Map();
    for (const e of latestRun?.errors || []) {
      if (e?.episode_id) errorMap.set(e.episode_id, e.message);
    }

    const rows = [];
    for (const show of shows) {
      for (const ep of show.episodes || []) {
        const url = ep.signed_playback_url;
        if (typeof url !== 'string' || !url.includes(COMBINED_MARKER)) continue;
        rows.push({
          id: ep.id,
          kind: 'episode',
          show_slug: show.slug,
          show_title: show.title,
          episode_title: ep.title,
          episode_number: ep.episode_number,
          signed_url: url,
          is_signed: isSigned(url),
          expires_at: ep.signed_playback_expires_at || null,
          expires_in_seconds: expiresInSeconds(ep.signed_playback_expires_at),
          last_error: errorMap.get(ep.id) || null,
        });
      }
      for (const t of show.trailers_playback_urls || []) {
        const url = t.gcpUrl;
        if (typeof url !== 'string' || !url.includes(COMBINED_MARKER)) continue;
        const synthId = `trailer_${show._id}_${t._key}`;
        rows.push({
          id: synthId,
          kind: 'trailer',
          show_slug: show.slug,
          show_title: show.title,
          trailer_key: t._key,
          signed_url: url,
          is_signed: isSigned(url),
          expires_at: t.signed_playback_expires_at || null,
          expires_in_seconds: expiresInSeconds(t.signed_playback_expires_at),
          last_error: errorMap.get(synthId) || null,
        });
      }
    }

    let filtered = rows;
    if (filter === 'unsigned') {
      filtered = rows.filter(r => !r.is_signed);
    } else if (filter === 'near_expiry') {
      filtered = rows.filter(r => r.expires_in_seconds !== null && r.expires_in_seconds < 1800);
    } else if (filter === 'errored') {
      filtered = rows.filter(r => r.last_error);
    }

    return NextResponse.json({
      rows: filtered,
      total: rows.length,
      filter_count: filtered.length,
      latest_run_started_at: latestRun?.started_at || null,
    });
  } catch (err) {
    console.error('[GET /api/signing/status]', err);
    return NextResponse.json({ error: 'Failed to read signing status' }, { status: 500 });
  }
}
