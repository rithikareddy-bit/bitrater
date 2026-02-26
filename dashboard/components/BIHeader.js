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

  const {
    h264_bitrate_kbps,
    h265_bitrate_kbps,
    vmaf_attained,
    duration_s,
  } = golden;

  const storageSaved =
    h264_bitrate_kbps && h265_bitrate_kbps
      ? ((1 - h265_bitrate_kbps / h264_bitrate_kbps) * 100).toFixed(1)
      : null;

  const computeCost =
    duration_s != null
      ? (0.0174 * Math.ceil(duration_s / 3600)).toFixed(4)
      : null;

  const metrics = [
    {
      label: 'Storage Saved',
      value: storageSaved != null ? `${storageSaved}%` : '—',
      color: '#22c55e',
    },
    {
      label: 'Quality Floor',
      value: vmaf_attained != null ? vmaf_attained.toFixed(1) : '—',
      color: '#4da6ff',
      suffix: ' VMAF',
    },
    {
      label: 'Codec Winner',
      value: 'H.265',
      color: '#a78bfa',
    },
    {
      label: 'Compute Cost',
      value: computeCost != null ? `$${computeCost}` : '—',
      color: '#f59e0b',
      suffix: ' /run',
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
