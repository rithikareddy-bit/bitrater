import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import {
  stripGolden,
  qcLabel,
  gcpShort,
  durationByEpisode,
  buildShowStats,
} from '@/lib/liveRowHelpers';
import { DB_LAB, DB_MASTER } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function pickEpisodeNumber(ep, index) {
  const n =
    ep.episode_number ??
    ep.episodeNumber ??
    ep.number ??
    ep.episode ??
    ep.seq ??
    ep.position ??
    ep.index;
  if (n != null && Number.isFinite(Number(n))) return Number(n);
  return index + 1;
}

/**
 * GET /api/shows/[id]/episodes-live
 * Bulk lab + golden + QC + GCP snapshot for all episodes in a show (single round-trip).
 * ?source=podcast → the show is in master.podcast_showcache instead of showcache.
 */
export async function GET(request, { params }) {
  try {
    const rawId = params.id;
    if (!rawId || !ObjectId.isValid(rawId)) {
      return NextResponse.json({ error: 'Invalid show id' }, { status: 400 });
    }

    const client = await clientPromise();
    const masterDb = client.db(DB_MASTER);
    const labDb = client.db(DB_LAB);

    // ?source=podcast reads master.podcast_showcache (Audio-Video page); anything
    // else keeps the showcache default.
    const isPodcast = request?.nextUrl?.searchParams.get('source') === 'podcast';
    const collection = isPodcast ? 'podcast_showcache' : 'showcache';
    // Podcast episodes run through Audio-Video, whose GCP status lives in the
    // `av_` fields and whose output is podcastvideo.m3u8, not the combined master.
    const gcpPfx = isPodcast ? 'av_' : '';
    const show = await masterDb.collection(collection).findOne({ _id: new ObjectId(rawId) });
    if (!show) {
      return NextResponse.json({ error: 'Show not found' }, { status: 404 });
    }

    const episodes = Array.isArray(show.episodes) ? show.episodes : [];
    const ids = [
      ...new Set(
        episodes
          .map((e) => (e?.id != null ? String(e.id) : e?._id != null ? String(e._id) : ''))
          .filter(Boolean),
      ),
    ];

    const labDocs =
      ids.length === 0
        ? []
        : await labDb
            .collection('video_episodes')
            .find(
              { episode_id: { $in: ids } },
              {
                projection: {
                  episode_id: 1,
                  golden_recipes: 1,
                  lab_status_h264: 1,
                  lab_status_h265: 1,
                  quality_check: 1,
                  [`${gcpPfx}gcp_job_status_h264`]: 1,
                  [`${gcpPfx}gcp_job_status_h265`]: 1,
                  h264_master_m3u8_url: 1,
                  h265_master_m3u8_url: 1,
                  combined_master_m3u8_url: 1,
                  podcastvideo_m3u8_url: 1,
                },
              },
            )
            .toArray();

    const byEpisodeId = Object.fromEntries(labDocs.map((d) => [d.episode_id, d]));

    const durationById = await durationByEpisode(labDb, ids);

    const rows = episodes.map((ep, index) => {
      const episodeId = ep?.id != null ? String(ep.id) : ep?._id != null ? String(ep._id) : '';
      const doc = episodeId ? byEpisodeId[episodeId] : null;
      const gr = doc?.golden_recipes ?? null;

      const h264Golden = stripGolden(gr, 'h264');
      const h265Golden = stripGolden(gr, 'h265');
      const durationSeconds = episodeId ? durationById[episodeId] ?? 0 : 0;

      return {
        episodeId,
        episodeNumber: pickEpisodeNumber(ep, index),
        title: ep?.title ?? null,
        durationSeconds,
        s3_url: ep?.s3_url ?? null,
        lab_h264: doc?.lab_status_h264 ?? null,
        lab_h265: doc?.lab_status_h265 ?? null,
        golden_h264: h264Golden,
        golden_h265: h265Golden,
        qc: qcLabel(doc?.quality_check),
        gcp_h264: gcpShort(doc?.[`${gcpPfx}gcp_job_status_h264`]),
        gcp_h265: gcpShort(doc?.[`${gcpPfx}gcp_job_status_h265`]),
        has_h264_url: Boolean(doc?.h264_master_m3u8_url),
        has_h265_url: Boolean(doc?.h265_master_m3u8_url),
        combined_url: (isPodcast ? doc?.podcastvideo_m3u8_url : doc?.combined_master_m3u8_url) ?? null,
      };
    });

    const stats = buildShowStats(rows, durationById);

    const anyRunningLab = rows.some(
      (r) => r.lab_h264 === 'RUNNING' || r.lab_h265 === 'RUNNING',
    );
    const anyRunningGcp = rows.some((r) => r.gcp_h264 === '…' || r.gcp_h265 === '…');
    const anyRunningQc = rows.some((r) => r.qc.key === 'running');

    return NextResponse.json(
      {
        showId: rawId,
        showTitle: show.title ?? 'Untitled',
        fetchedAt: new Date().toISOString(),
        episodeCount: rows.length,
        episodes: rows,
        stats,
        hints: {
          anyRunningLab,
          anyRunningGcp,
          anyRunningQc,
          suggestPollMs: anyRunningLab || anyRunningGcp || anyRunningQc ? 8000 : 20000,
        },
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    console.error('[GET /api/shows/[id]/episodes-live]', err);
    return NextResponse.json({ error: 'Failed to load show episodes' }, { status: 500 });
  }
}
