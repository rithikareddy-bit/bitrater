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

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function trailerSyntheticId(showObjectIdStr, key) {
  return `trailer_${showObjectIdStr}_${key}`;
}

/**
 * GET /api/shows/[id]/trailers-live
 * Bulk lab + golden + QC + GCP snapshot for all trailers in a show.
 *
 * Trailers live on master.showcache in `trailers_playback_urls[]` (camelCase,
 * mirrored from Sanity). Each entry has `_key` and `s3Url` as the source.
 * Pipeline state is stored in chai_q_lab.video_episodes under the synthetic id
 * `trailer_<showObjectId>_<_key>`.
 */
export async function GET(_request, { params }) {
  try {
    const rawId = params.id;
    if (!rawId || !ObjectId.isValid(rawId)) {
      return NextResponse.json({ error: 'Invalid show id' }, { status: 400 });
    }

    const client = await clientPromise();
    const masterDb = client.db('master');
    const labDb = client.db('chai_q_lab');

    const show = await masterDb.collection('showcache').findOne({ _id: new ObjectId(rawId) });
    if (!show) {
      return NextResponse.json({ error: 'Show not found' }, { status: 404 });
    }

    const trailers = Array.isArray(show.trailers_playback_urls) ? show.trailers_playback_urls : [];
    const ids = [
      ...new Set(
        trailers
          .map((t) => (t?._key ? trailerSyntheticId(rawId, t._key) : ''))
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
                  gcp_job_status_h264: 1,
                  gcp_job_status_h265: 1,
                  h264_master_m3u8_url: 1,
                  h265_master_m3u8_url: 1,
                  combined_master_m3u8_url: 1,
                },
              },
            )
            .toArray();

    const byEpisodeId = Object.fromEntries(labDocs.map((d) => [d.episode_id, d]));

    const durationById = await durationByEpisode(labDb, ids);

    const rows = trailers.map((t, index) => {
      const episodeId = t?._key ? trailerSyntheticId(rawId, t._key) : '';
      const doc = episodeId ? byEpisodeId[episodeId] : null;
      const gr = doc?.golden_recipes ?? null;

      const h264Golden = stripGolden(gr, 'h264');
      const h265Golden = stripGolden(gr, 'h265');
      const durationSeconds = episodeId ? durationById[episodeId] ?? 0 : 0;

      return {
        episodeId,
        episodeNumber: index + 1,
        trailerKey: t?._key ?? null,
        title: t?.title || `Trailer ${index + 1}`,
        durationSeconds,
        s3_url: t?.s3Url ?? t?.s3_url ?? null,
        existing_gcp_url: t?.gcpUrl ?? null,
        lab_h264: doc?.lab_status_h264 ?? null,
        lab_h265: doc?.lab_status_h265 ?? null,
        golden_h264: h264Golden,
        golden_h265: h265Golden,
        qc: qcLabel(doc?.quality_check),
        gcp_h264: gcpShort(doc?.gcp_job_status_h264),
        gcp_h265: gcpShort(doc?.gcp_job_status_h265),
        has_h264_url: Boolean(doc?.h264_master_m3u8_url),
        has_h265_url: Boolean(doc?.h265_master_m3u8_url),
        combined_url: doc?.combined_master_m3u8_url ?? null,
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
    console.error('[GET /api/shows/[id]/trailers-live]', err);
    return NextResponse.json({ error: 'Failed to load show trailers' }, { status: 500 });
  }
}
