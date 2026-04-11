import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';
import { VMAF_THRESHOLDS } from '@/lib/constants';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RESOLUTIONS = ['1080p', '720p', '480p'];

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

function stripGolden(gr, codec) {
  const out = {};
  for (const res of RESOLUTIONS) {
    const w = gr?.resolutions?.[res]?.[codec];
    if (!w) {
      out[res] = null;
      continue;
    }
    const vmaf = w.vmaf_attained;
    const thr = VMAF_THRESHOLDS[res];
    const pass =
      vmaf == null || thr == null ? null : Number(vmaf) >= Number(thr);
    out[res] = {
      bitrate_kbps: w.bitrate_kbps ?? null,
      vmaf_attained: vmaf ?? null,
      threshold: thr,
      pass,
    };
  }
  return out;
}

function qcLabel(qc) {
  if (!qc || typeof qc !== 'object') return { key: 'none', label: '—' };
  const o = qc.overall;
  if (o === 'RUNNING') return { key: 'running', label: 'Checking…' };
  if (o === 'PASS') return { key: 'pass', label: 'PASS' };
  if (o === 'ISSUES_FOUND') return { key: 'issues', label: 'Issues' };
  return { key: 'none', label: '—' };
}

function gcpShort(status) {
  if (!status) return '—';
  if (status === 'SUCCEEDED' || status === 'COMPLETE') return 'Done';
  if (status === 'RUNNING' || status === 'PENDING') return '…';
  if (status === 'FAILED') return 'Fail';
  return status;
}

/** Sum golden bitrates (kbps) across 1080/720/480 where present — proxy for full-ladder storage. */
function sumLadderKbps(golden) {
  let s = 0;
  for (const res of RESOLUTIONS) {
    const kb = golden?.[res]?.bitrate_kbps;
    if (kb != null && Number.isFinite(Number(kb))) s += Number(kb);
  }
  return s;
}

function singleResKbps(golden, resTag) {
  const kb = golden?.[resTag]?.bitrate_kbps;
  if (kb == null || !Number.isFinite(Number(kb))) return 0;
  return Number(kb);
}

/**
 * Same convention as episode page `calcSizeMB`: (kbps_sum × duration_s) / 8 / 1024 → "MB" label.
 */
function kbpsSecondsToEpisodePageMb(kbpsSum, seconds) {
  if (!kbpsSum || !seconds) return 0;
  return (kbpsSum * seconds) / 8 / 1024;
}

async function durationByEpisode(labDb, episodeIds) {
  if (!episodeIds.length) return {};
  const agg = await labDb
    .collection('video_vmaf_research')
    .aggregate([
      { $match: { episode_id: { $in: episodeIds } } },
      {
        $project: {
          episode_id: 1,
          tl: { $size: { $ifNull: ['$vmaf_timeline', []] } },
        },
      },
      { $group: { _id: '$episode_id', durationSeconds: { $max: '$tl' } } },
    ])
    .toArray();
  return Object.fromEntries(
    agg.map((d) => [d._id, Number(d.durationSeconds) || 0]),
  );
}

function buildShowStats(rows, durationById) {
  let totalDurationSec = 0;
  let withDuration = 0;
  let h264LadderMb = 0;
  let h265LadderMb = 0;
  let h264_1080_only_mb = 0;
  let h265_1080_only_mb = 0;
  let episodesWithH264Recipe = 0;
  let episodesWithH265Recipe = 0;

  let lab264Done = 0;
  let lab265Done = 0;
  let lab264Fail = 0;
  let lab265Fail = 0;
  let qcPass = 0;
  let qcIssues = 0;
  let gcp264Done = 0;
  let gcp265Done = 0;

  for (const row of rows) {
    const d = durationById[row.episodeId] ?? 0;
    if (d > 0) {
      withDuration += 1;
      totalDurationSec += d;
    }

    if (row.lab_h264 === 'COMPLETE') lab264Done += 1;
    else if (row.lab_h264 === 'FAILED') lab264Fail += 1;
    if (row.lab_h265 === 'COMPLETE') lab265Done += 1;
    else if (row.lab_h265 === 'FAILED') lab265Fail += 1;

    if (row.qc.key === 'pass') qcPass += 1;
    else if (row.qc.key === 'issues') qcIssues += 1;

    if (row.gcp_h264 === 'Done') gcp264Done += 1;
    if (row.gcp_h265 === 'Done') gcp265Done += 1;

    const sum264 = sumLadderKbps(row.golden_h264);
    const sum265 = sumLadderKbps(row.golden_h265);
    if (sum264 > 0) episodesWithH264Recipe += 1;
    if (sum265 > 0) episodesWithH265Recipe += 1;

    if (d > 0) {
      if (sum264 > 0) h264LadderMb += kbpsSecondsToEpisodePageMb(sum264, d);
      if (sum265 > 0) h265LadderMb += kbpsSecondsToEpisodePageMb(sum265, d);
      const b1080a = singleResKbps(row.golden_h264, '1080p');
      const b1080b = singleResKbps(row.golden_h265, '1080p');
      if (b1080a > 0) h264_1080_only_mb += kbpsSecondsToEpisodePageMb(b1080a, d);
      if (b1080b > 0) h265_1080_only_mb += kbpsSecondsToEpisodePageMb(b1080b, d);
    }
  }

  const n = rows.length;
  const fmtMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`);

  return {
    catalogEpisodes: n,
    episodesWithDuration: withDuration,
    totalDurationSeconds: Math.round(totalDurationSec),
    totalDurationLabel: formatDurationHMS(totalDurationSec),
    consumption: {
      /** All golden renditions (1080+720+480) summed — same MB formula as episode page */
      h264_full_ladder_mb: Math.round(h264LadderMb * 10) / 10,
      h265_full_ladder_mb: Math.round(h265LadderMb * 10) / 10,
      h264_full_ladder_display: fmtMb(h264LadderMb),
      h265_full_ladder_display: fmtMb(h265LadderMb),
      /** Single 1080p stream only */
      h264_1080_only_mb: Math.round(h264_1080_only_mb * 10) / 10,
      h265_1080_only_mb: Math.round(h265_1080_only_mb * 10) / 10,
      h264_1080_only_display: fmtMb(h264_1080_only_mb),
      h265_1080_only_display: fmtMb(h265_1080_only_mb),
      episodesCountedH264: episodesWithH264Recipe,
      episodesCountedH265: episodesWithH265Recipe,
    },
    rollup: {
      lab_h264_complete: lab264Done,
      lab_h264_failed: lab264Fail,
      lab_h265_complete: lab265Done,
      lab_h265_failed: lab265Fail,
      qc_pass: qcPass,
      qc_issues: qcIssues,
      gcp_h264_done: gcp264Done,
      gcp_h265_done: gcp265Done,
    },
    note:
      'Duration from max VMAF timeline length in research (same as episode page). Per-episode MB = (kbps×s)/8/1024 (episode page formula); show totals sum those. GB shown when total ≥ 1024 MB (÷1024).',
  };
}

function formatDurationHMS(totalSec) {
  if (!totalSec || totalSec < 1) return '—';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * GET /api/shows/[id]/episodes-live
 * Bulk lab + golden + QC + GCP snapshot for all episodes in a show (single round-trip).
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
    console.error('[GET /api/shows/[id]/episodes-live]', err);
    return NextResponse.json({ error: 'Failed to load show episodes' }, { status: 500 });
  }
}
