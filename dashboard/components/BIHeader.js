'use client';

export default function BIHeader({ golden }) {
  if (!golden) {
    return (
      <div style={{
        background: '#161616',
        border: '1px solid #2a2a2a',
        borderRadius: 10,
        padding: '16px 24px',
        color: '#555',
        fontSize: 14,
      }}>
        Run lab to see business intelligence metrics.
      </div>
    );
  }

  const resolutions = golden?.golden_recipes?.resolutions;
  const primary = resolutions?.['1080p'];

  const h264_bitrate = primary?.h264?.bitrate_kbps;
  const h265_bitrate = primary?.h265?.bitrate_kbps;
  const vmaf_attained = primary?.h265?.vmaf_attained ?? primary?.h264?.vmaf_attained;
  const efficiencyGain = golden?.efficiency_gain?.['1080p'];

  const storageSaved =
    h264_bitrate && h265_bitrate
      ? ((1 - h265_bitrate / h264_bitrate) * 100).toFixed(1)
      : null;

  const metrics = [
    {
      label: 'Storage Saved (1080p)',
      value: storageSaved != null ? `${storageSaved}%` : efficiencyGain || '—',
      color: '#22c55e',
    },
    {
      label: 'Quality Floor (1080p)',
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
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 12,
    }}>
      {metrics.map(({ label, value, color, suffix }) => (
        <div key={label} style={{
          background: '#161616',
          border: '1px solid #2a2a2a',
          borderRadius: 10,
          padding: '16px 20px',
        }}>
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            {label}
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, color }}>
            {value}
            {suffix && <span style={{ fontSize: 13, color: '#888', fontWeight: 400 }}>{suffix}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
