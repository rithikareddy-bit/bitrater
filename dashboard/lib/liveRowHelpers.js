import { VMAF_THRESHOLDS } from '@/lib/constants';

const RESOLUTIONS = ['1080p', '720p', '480p'];

export function stripGolden(gr, codec) {
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

export function qcLabel(qc) {
  if (!qc || typeof qc !== 'object') return { key: 'none', label: '—' };
  const o = qc.overall;
  if (o === 'RUNNING') return { key: 'running', label: 'Checking…' };
  if (o === 'PASS') return { key: 'pass', label: 'PASS' };
  if (o === 'ISSUES_FOUND') return { key: 'issues', label: 'Issues' };
  return { key: 'none', label: '—' };
}

export function gcpShort(status) {
  if (!status) return '—';
  if (status === 'SUCCEEDED' || status === 'COMPLETE') return 'Done';
  if (status === 'RUNNING' || status === 'PENDING') return '…';
  if (status === 'FAILED') return 'Fail';
  return status;
}

export function sumLadderKbps(golden) {
  let s = 0;
  for (const res of RESOLUTIONS) {
    const kb = golden?.[res]?.bitrate_kbps;
    if (kb != null && Number.isFinite(Number(kb))) s += Number(kb);
  }
  return s;
}

export function singleResKbps(golden, resTag) {
  const kb = golden?.[resTag]?.bitrate_kbps;
  if (kb == null || !Number.isFinite(Number(kb))) return 0;
  return Number(kb);
}

export function kbpsSecondsToEpisodePageMb(kbpsSum, seconds) {
  if (!kbpsSum || !seconds) return 0;
  return (kbpsSum * seconds) / 8 / 1024;
}

export async function durationByEpisode(labDb, episodeIds) {
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

export function formatDurationHMS(totalSec) {
  if (!totalSec || totalSec < 1) return '—';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function buildShowStats(rows, durationById) {
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
      h264_full_ladder_mb: Math.round(h264LadderMb * 10) / 10,
      h265_full_ladder_mb: Math.round(h265LadderMb * 10) / 10,
      h264_full_ladder_display: fmtMb(h264LadderMb),
      h265_full_ladder_display: fmtMb(h265LadderMb),
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
