'use client';

import { useState } from 'react';

const QUALITY_THRESHOLD_HIGH = 93.5;
const QUALITY_THRESHOLD_MID = 85;

function vmafToColor(score) {
  if (score >= QUALITY_THRESHOLD_HIGH) return '#22c55e';  // green
  if (score >= QUALITY_THRESHOLD_MID) return '#f59e0b';   // amber
  return '#ef4444';                                        // red
}

export default function VMAFHeatmap({ timeline }) {
  const [tooltip, setTooltip] = useState(null);

  if (!timeline || timeline.length === 0) {
    return (
      <div style={{ color: '#555', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>
        No timeline data yet. Run lab to populate.
      </div>
    );
  }

  const cellWidth = Math.max(4, Math.min(20, Math.floor(560 / timeline.length)));

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
        {timeline.length}s duration — hover for per-second VMAF
      </div>

      {/* Heatmap bar */}
      <div
        style={{
          display: 'flex',
          height: 40,
          borderRadius: 6,
          overflow: 'hidden',
          cursor: 'crosshair',
        }}
        onMouseLeave={() => setTooltip(null)}
      >
        {timeline.map((score, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              background: vmafToColor(score),
              opacity: 0.85,
              transition: 'opacity 0.1s',
            }}
            onMouseEnter={(e) => {
              const rect = e.currentTarget.closest('div').getBoundingClientRect();
              setTooltip({ second: i, score, x: e.clientX - rect.left });
            }}
          />
        ))}
      </div>

      {/* Time labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: '#555' }}>
        <span>0s</span>
        <span>{Math.floor(timeline.length / 2)}s</span>
        <span>{timeline.length}s</span>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 11, color: '#888' }}>
        <span><span style={{ color: '#22c55e' }}>■</span> ≥93.5 (target)</span>
        <span><span style={{ color: '#f59e0b' }}>■</span> 85–93.5</span>
        <span><span style={{ color: '#ef4444' }}>■</span> &lt;85 (below floor)</span>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'absolute',
          top: -36,
          left: Math.min(tooltip.x, 480),
          background: '#1e1e1e',
          border: '1px solid #333',
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 12,
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          {tooltip.second}s — VMAF {tooltip.score}
        </div>
      )}
    </div>
  );
}
