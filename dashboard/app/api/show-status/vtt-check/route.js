import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Basename of a URL, query string stripped. */
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
 * GET /api/show-status/vtt-check
 *
 * For every ACTIVE show in master.showcache, check that each episode has a
 * non-empty `vtt_url`. Returns the shows that have at least one episode
 * without one, with the offending episode names.
 *
 * Each missing episode is classified:
 *   - "unsynced"  : a VTT was generated (master.episode_vtt has one, matched by
 *                   episode_id or source-file stem) but was never written back
 *                   to showcache — a sync gap, no regeneration needed.
 *   - "no_source" : the episode has no s3_url, so there is no video to build a
 *                   VTT from. Not a VTT problem — an ingest problem.
 *   - "none"      : source exists, no VTT generated yet — run the worker.
 */
export async function GET() {
  try {
    const client = await clientPromise();
    const db = client.db('master');

    const docs = await db.collection('showcache')
      .find(
        { active: true },
        {
          projection: {
            _id: 1,
            slug: 1,
            title: 1,
            language: 1,
            'episodes.id': 1,
            'episodes.episode_number': 1,
            'episodes.title': 1,
            'episodes.vtt_url': 1,
            'episodes.s3_url': 1,
          },
        },
      )
      .toArray();

    let totalEpisodes = 0;
    let totalMissing = 0;

    // Pass 1: collect every episode with no vtt_url in showcache.
    const pending = [];
    for (const doc of docs) {
      const episodes = Array.isArray(doc.episodes) ? doc.episodes : [];
      totalEpisodes += episodes.length;

      const missing = episodes
        .filter((ep) => !String(ep?.vtt_url ?? '').trim())
        .map((ep) => ({
          id: ep?.id ?? null,
          episode_number: ep?.episode_number ?? null,
          title: ep?.title ?? null,
          stem: sourceStem(ep?.s3_url),
          state: String(ep?.s3_url ?? '').trim() ? 'none' : 'no_source',
        }));

      totalMissing += missing.length;
      if (missing.length > 0) pending.push({ doc, episodes, missing });
    }

    // Pass 2: which of those episodes already have a generated VTT (only the
    // showcache write is missing, not the VTT itself). Matched by episode_id,
    // then by source-file stem — episode ids are re-generated on re-ingest, so
    // an id-only lookup would miss re-ingested episodes. Must stay in step with
    // the matching in /api/show-status/vtt-sync.
    const generatedIds = new Set();
    const generatedStems = new Set();
    if (pending.length > 0) {
      const rows = await db.collection('episode_vtt')
        .find(
          { vtt_url: { $exists: true, $ne: '' } },
          { projection: { episode_id: 1, vtt_url: 1 } },
        )
        .toArray();
      for (const r of rows) {
        if (r.episode_id) generatedIds.add(r.episode_id);
        const stem = vttStem(r.vtt_url);
        if (stem) generatedStems.add(stem);
      }
    }

    let totalUnsynced = 0;
    let totalNoSource = 0;
    const shows = [];
    for (const { doc, episodes, missing } of pending) {
      let unsynced = 0;
      let noSource = 0;
      for (const ep of missing) {
        if ((ep.id && generatedIds.has(ep.id)) || (ep.stem && generatedStems.has(ep.stem))) {
          ep.state = 'unsynced';
          unsynced += 1;
        } else if (ep.state === 'no_source') {
          noSource += 1;
        }
      }
      totalUnsynced += unsynced;
      totalNoSource += noSource;

      shows.push({
        _id: doc._id,
        slug: doc.slug ?? null,
        title: doc.title ?? 'Untitled',
        language: doc.language ?? null,
        episode_total: episodes.length,
        missing_count: missing.length,
        unsynced_count: unsynced,
        no_source_count: noSource,
        no_vtt_count: missing.length - unsynced - noSource,
        missing,
      });
    }

    // Worst offenders first (all episodes missing, then by count).
    shows.sort((a, b) => {
      const fa = a.missing_count === a.episode_total ? 0 : 1;
      const fb = b.missing_count === b.episode_total ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return b.missing_count - a.missing_count;
    });

    return NextResponse.json(
      {
        active_shows: docs.length,
        shows_with_missing: shows.length,
        total_episodes: totalEpisodes,
        missing_episodes: totalMissing,
        unsynced_episodes: totalUnsynced,
        no_source_episodes: totalNoSource,
        no_vtt_episodes: totalMissing - totalUnsynced - totalNoSource,
        shows,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/show-status/vtt-check]', err);
    return NextResponse.json({ error: 'Failed to run VTT check' }, { status: 500 });
  }
}
