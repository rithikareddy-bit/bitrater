/**
 * Lab search candidate bitrates (kbps) — keep in sync with
 * orchestrator/search_orchestrator.py SEARCH_CONFIG resolutions.*.candidates
 */
export const RD_CANDIDATES_KBPS = {
  '1080p': {
    h264: [1800, 2000, 2300, 2500, 2700, 3000, 3300, 3600, 3900, 4200, 4400, 4600, 4800],
    h265: [800, 1000, 1200, 1500, 1800, 2100, 2300, 2600, 2900, 3200],
  },
  '720p': {
    h264: [700, 900, 1100, 1300, 1500, 1700, 1900],
    h265: [500, 700, 900, 1200, 1350, 1500, 1650],
  },
  '480p': {
    h264: [200, 300, 400, 500, 600],
    h265: [100, 200, 300, 400, 500],
  },
};

/**
 * X-axis range from candidate ladders (both codecs) plus padding.
 */
export function bitrateAxisFromCandidates(resolutionTag) {
  const pack = RD_CANDIDATES_KBPS[resolutionTag] || RD_CANDIDATES_KBPS['1080p'];
  const all = [...pack.h264, ...pack.h265];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const pad = Math.max(40, Math.round(span * 0.08));
  return {
    min: Math.max(0, lo - pad),
    max: hi + pad,
  };
}

/**
 * Widen axis to include all plotted points so nothing clips at the edges.
 */
export function mergeBitrateAxisWithData(axis, researchData) {
  const xs = researchData
    .map((r) => r.bitrate)
    .filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (xs.length === 0) return axis;
  const dLo = Math.min(...xs);
  const dHi = Math.max(...xs);
  const span = dHi - dLo || 1;
  const edge = Math.max(20, Math.round(span * 0.06));
  return {
    min: Math.max(0, Math.min(axis.min, dLo - edge)),
    max: Math.max(axis.max, dHi + edge),
  };
}
