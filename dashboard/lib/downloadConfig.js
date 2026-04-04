/**
 * Golden bitrate consumption — same formula as episode Data Consumption table.
 * (bitrate_kbps × duration_seconds) / 8 / 1024 → MB
 */

export const RESOLUTIONS = ['1080p', '720p', '480p'];
export const CODEC_KEYS = ['h264', 'h265'];

const FORMULA_LABEL = '(bitrate_kbps * duration_seconds) / 8 / 1024';

/** Coerce to finite number for BSON Double in Mongo (not string). */
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Rounded MB as a plain JS number for BSON. */
function mbNumber(rawMb) {
  if (!Number.isFinite(rawMb)) return 0;
  return Math.round(rawMb * 1000) / 1000;
}

function roundSeconds(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

export function consumptionMb(kbps, durationSeconds) {
  if (kbps == null || !Number.isFinite(Number(kbps)) || durationSeconds == null || durationSeconds <= 0) {
    return 0;
  }
  return (Number(kbps) * Number(durationSeconds)) / 8 / 1024;
}

export function formatConsumptionCell(kbps, durationSeconds) {
  if (!kbps || !durationSeconds) return '--';
  return consumptionMb(kbps, durationSeconds).toFixed(1) + ' MB';
}

/** Prefer showcache episode.duration; else max VMAF timeline length from research docs. */
export function resolveDurationSeconds(episodeMeta, research) {
  const d = episodeMeta?.duration;
  if (d != null && Number(d) > 0) return Number(d);
  if (!Array.isArray(research)) return 0;
  return research.reduce((max, r) => Math.max(max, r.vmaf_timeline?.length || 0), 0);
}

export function durationSourceLabel(episodeMeta, research) {
  const d = episodeMeta?.duration;
  if (d != null && Number(d) > 0) return 'showcache';
  if (Array.isArray(research) && research.some((r) => (r.vmaf_timeline?.length || 0) > 0)) {
    return 'vmaf_timeline';
  }
  return 'unknown';
}

/**
 * @param {object|null} goldenRecipes
 * @param {number} durationSeconds
 * @param {string} durationSource
 */
export function buildDownloadConfig(goldenRecipes, durationSeconds, durationSource = 'unknown') {
  const resolutions = {};
  const dur = num(durationSeconds);
  const durationSec = dur != null && dur >= 0 ? dur : 0;

  for (const res of RESOLUTIONS) {
    resolutions[res] = { h264: null, h265: null };
    const resData = goldenRecipes?.resolutions?.[res];
    if (!resData) continue;
    for (const codec of CODEC_KEYS) {
      const cell = resData[codec];
      if (!cell || cell.bitrate_kbps == null) continue;
      const kbps = num(cell.bitrate_kbps);
      if (kbps == null) continue;
      const mb = consumptionMb(kbps, durationSec);
      const vmaf = cell.vmaf_attained;
      resolutions[res][codec] = {
        bitrate_kbps: kbps,
        vmaf_attained: vmaf == null ? null : num(vmaf),
        consumption_mb: mbNumber(mb),
      };
    }
  }

  // Plain nested object → Mongo stores as BSON document (Object), not a string.
  return {
    formula: FORMULA_LABEL,
    duration_seconds: roundSeconds(durationSec),
    duration_source: String(durationSource ?? 'unknown'),
    resolutions,
  };
}
