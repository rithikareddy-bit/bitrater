'use client';

const DEFAULT_THRESHOLDS = { '1080p': 88, '720p': 75, '480p': 48 };

/** Same winner rule as orchestrator/aggregator.py */
function pickWinner(rows, threshold) {
  if (!rows?.length) return null;
  const sorted = [...rows].sort((a, b) => a.bitrate_kbps - b.bitrate_kbps);
  const above = sorted.filter((r) => r.vmaf_score >= threshold);
  const w = above.length ? above[0] : sorted.reduce((a, b) => (a.vmaf_score >= b.vmaf_score ? a : b));
  return {
    bitrate_kbps: w.bitrate_kbps,
    vmaf_attained: w.vmaf_score,
  };
}

export default function BIHeader({
  golden,
  selectedRes = '1080p',
  research = [],
  vmafThreshold = DEFAULT_THRESHOLDS['1080p'],
}) {
  if (!golden && (!research || research.length === 0)) {
    return (
      <div
        style={{
          background: '#161616',
          border: '1px solid #2a2a2a',
          borderRadius: 10,
          padding: '16px 24px',
          color: '#555',
          fontSize: 14,
        }}
      >
        Run lab to see business intelligence metrics.
      </div>
    );
  }

  const resolutions = golden?.golden_recipes?.resolutions;
  let primary = resolutions?.[selectedRes];

  /* Fallback when aggregator hasn’t written golden_recipes yet (race after 21/21 Batch) */
  if (
    research?.length > 0 &&
    (!primary?.h264?.bitrate_kbps || !primary?.h265?.bitrate_kbps)
  ) {
    const resRows = research.filter((r) => r.resolution === selectedRes);
    const h264Rows = resRows.filter((r) => r.codec === 'libx264');
    const h265Rows = resRows.filter((r) => r.codec === 'libx265');
    const h264W = pickWinner(h264Rows, vmafThreshold);
    const h265W = pickWinner(h265Rows, vmafThreshold);
    if (h264W && h265W) {
      primary = {
        h264: h264W,
        h265: h265W,
      };
    }
  }

  if (!primary && golden && !research?.length) {
    return (
      <div
        style={{
          background: '#161616',
          border: '1px solid #2a2a2a',
          borderRadius: 10,
          padding: '16px 24px',
          color: '#555',
          fontSize: 14,
        }}
      >
        Run lab to see business intelligence metrics.
      </div>
    );
  }

  if (!primary) {
    primary = resolutions?.[selectedRes] || {};
  }

  const h264_bitrate = primary?.h264?.bitrate_kbps;
  const h265_bitrate = primary?.h265?.bitrate_kbps;
  const vmaf_attained = primary?.h265?.vmaf_attained ?? primary?.h264?.vmaf_attained;
  const efficiencyGain = golden?.efficiency_gain?.[selectedRes];

  const storageSaved =
    h264_bitrate && h265_bitrate
      ? ((1 - h265_bitrate / h264_bitrate) * 100).toFixed(1)
      : null;

  const metrics = [
    {
      label: `Storage Saved (${selectedRes})`,
      value: storageSaved != null ? `${storageSaved}%` : efficiencyGain || '—',
      color: '#22c55e',
    },
    {
      label: `Quality Floor (${selectedRes})`,
      value: vmaf_attained != null ? vmaf_attained.toFixed(1) : '—',
      color: '#4da6ff',
      suffix: ' VMAF',
    },
    {
      label: 'H.265 Bitrate',
      value: h265_bitrate ? `${h265_bitrate}k` : '—',
      color: '#a78bfa',
    },
    {
      label: 'H.264 Bitrate',
      value: h264_bitrate ? `${h264_bitrate}k` : '—',
      color: '#f59e0b',
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12,
      }}
    >
      {metrics.map(({ label, value, color, suffix }) => (
        <div
          key={label}
          style={{
            background: '#161616',
            border: '1px solid #2a2a2a',
            borderRadius: 10,
            padding: '16px 20px',
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: '#666',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 6,
            }}
          >
            {label}
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color }}>
            {value}
            {suffix && (
              <span style={{ fontSize: 13, color: '#888', fontWeight: 400 }}>{suffix}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
