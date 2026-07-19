import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/** Basename of a URL, query string and extension stripped. */
function basename(url) {
  const raw = String(url ?? '').split('?')[0].split('/').pop() || '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** "…/1779366388522-EP_01.mp4"  ->  "1779366388522-EP_01" */
function sourceStem(s3Url) {
  return basename(s3Url).replace(/\.[^.]+$/, '');
}

/** "…/1779366388522-EP_01-thumbnails.vtt"  ->  "1779366388522-EP_01" */
function vttStem(vttUrl) {
  return basename(vttUrl).replace(/\.vtt$/i, '').replace(/-thumbnails$/, '');
}

/**
 * POST /api/show-status/vtt-sync
 * Body: { slug?: string, confirm?: boolean }
 *
 * Writes ONLY when `confirm: true` is explicitly present. Anything else — an
 * empty body, malformed JSON, a stray curl — is treated as a dry run, so a
 * mistaken request can never mutate the catalog.
 *
 * Node port of Sprite/sync_vtt_to_showcache.py. Copies vtt_url from
 * master.episode_vtt into showcache.episodes[].vtt_url (and the `episode`
 * collection).
 *
 * Matching: episode_id first, then a fallback on the source-video filename
 * stem (episode.s3_url basename === vtt_url basename minus "-thumbnails.vtt").
 * Episode ids are re-generated on re-ingest, which orphans the episode_vtt
 * doc's episode_id; the s3 stem is derived from the source file itself and
 * survives that churn. Verified across all 3850 active episodes that already
 * carry a vtt_url: the stem matches its own episode's s3_url 3850/3850.
 *
 * Only fills episodes that are MISSING vtt_url in showcache but HAVE one in
 * episode_vtt — an existing showcache vtt_url is never overwritten. When an
 * episode_id appears in several episode_vtt docs (re-uploads), the most recent
 * by `updated_at` wins so a stale URL is never synced.
 *
 * Scope is active shows only, matching what /vtt-check reports. `slug` narrows
 * to a single show by slug or title (case-insensitive, exact).
 */
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    // Fail-safe: only an explicit confirm:true writes. Missing/garbled body =>
    // dry run.
    const dryRun = body.confirm !== true;

    const client = await clientPromise();
    const db = client.db('master');
    const showcache = db.collection('showcache');

    const query = { active: true };
    if (slug) {
      const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { slug: { $regex: `^${esc}$`, $options: 'i' } },
        { title: { $regex: `^${esc}$`, $options: 'i' } },
      ];
    }

    const shows = await showcache
      .find(query, { projection: { _id: 1, slug: 1, title: 1, 'episodes.id': 1, 'episodes.episode_number': 1, 'episodes.title': 1, 'episodes.vtt_url': 1, 'episodes.s3_url': 1 } })
      .toArray();

    if (shows.length === 0) {
      return NextResponse.json(
        { error: slug ? `No active show matched "${slug}"` : 'No active shows found' },
        { status: 404 },
      );
    }

    // Candidates: episodes with no vtt_url in showcache.
    const candidates = [];
    for (const show of shows) {
      const name = show.title || show.slug || String(show._id);
      for (const ep of Array.isArray(show.episodes) ? show.episodes : []) {
        const existing = String(ep?.vtt_url ?? '').trim();
        if (existing && existing !== 'None') continue;
        if (!ep?.id) continue;
        candidates.push({
          show_id: show._id,
          show_title: name,
          episode_id: ep.id,
          episode_number: ep.episode_number ?? null,
          episode_title: ep.title ?? null,
          stem: sourceStem(ep.s3_url),
        });
      }
    }

    if (candidates.length === 0) {
      return NextResponse.json({
        dry_run: dryRun,
        scanned_shows: shows.length,
        candidates: 0,
        synced: 0,
        no_vtt_available: 0,
        showcache_updated: 0,
        episode_updated: 0,
        details: [],
      });
    }

    // Index episode_vtt twice: by episode_id and by source stem. Newest
    // updated_at wins on both so a re-upload never syncs a stale URL.
    const byEpisodeId = new Map();
    const byStem = new Map();
    const seenId = new Map();
    const seenStem = new Map();
    const rows = await db.collection('episode_vtt')
      .find(
        { vtt_url: { $exists: true, $ne: '' } },
        { projection: { episode_id: 1, vtt_url: 1, updated_at: 1 } },
      )
      .toArray();
    for (const r of rows) {
      const url = String(r?.vtt_url ?? '').trim();
      if (!url || url === 'None') continue;
      const upd = String(r.updated_at ?? '');
      if (r.episode_id && (!byEpisodeId.has(r.episode_id) || upd >= (seenId.get(r.episode_id) ?? ''))) {
        byEpisodeId.set(r.episode_id, url);
        seenId.set(r.episode_id, upd);
      }
      const stem = vttStem(url);
      if (stem && (!byStem.has(stem) || upd >= (seenStem.get(stem) ?? ''))) {
        byStem.set(stem, url);
        seenStem.set(stem, upd);
      }
    }

    // episode_id first; fall back to the source stem when the id has churned.
    const details = [];
    for (const c of candidates) {
      let url = c.episode_id ? byEpisodeId.get(c.episode_id) : undefined;
      let matchedBy = url ? 'episode_id' : null;
      if (!url && c.stem) {
        url = byStem.get(c.stem);
        if (url) matchedBy = 's3_stem';
      }
      if (!url) continue;
      details.push({
        show_title: c.show_title,
        episode_number: c.episode_number,
        episode_title: c.episode_title,
        episode_id: c.episode_id,
        matched_by: matchedBy,
        vtt_url: url,
        show_id: c.show_id,
      });
    }
    const toSync = details;
    const matchedByStem = details.filter((d) => d.matched_by === 's3_stem').length;

    if (dryRun) {
      return NextResponse.json({
        dry_run: true,
        scanned_shows: shows.length,
        candidates: candidates.length,
        synced: toSync.length,
        no_vtt_available: candidates.length - toSync.length,
        matched_by_stem: matchedByStem,
        showcache_updated: 0,
        episode_updated: 0,
        details,
      });
    }

    let showcacheUpdated = 0;
    let episodeUpdated = 0;
    for (const c of toSync) {
      const url = c.vtt_url;
      const r1 = await showcache.updateOne(
        { _id: c.show_id, 'episodes.id': c.episode_id },
        { $set: { 'episodes.$.vtt_url': url } },
      );
      showcacheUpdated += r1.modifiedCount;
      const r2 = await db.collection('episode').updateOne(
        { id: c.episode_id },
        { $set: { vtt_url: url } },
      );
      episodeUpdated += r2.modifiedCount;
    }

    return NextResponse.json({
      dry_run: false,
      scanned_shows: shows.length,
      candidates: candidates.length,
      synced: toSync.length,
      no_vtt_available: candidates.length - toSync.length,
      matched_by_stem: matchedByStem,
      showcache_updated: showcacheUpdated,
      episode_updated: episodeUpdated,
      details,
    });
  } catch (err) {
    console.error('[POST /api/show-status/vtt-sync]', err);
    return NextResponse.json({ error: 'Failed to sync VTTs' }, { status: 500 });
  }
}
