'use client';

import {
  Chart as ChartJS,
  LineController,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js';
import ConvexHullChart from '../ConvexHullChart';

ChartJS.register(LineController, LinearScale, PointElement, LineElement, Tooltip, Legend);

const thresholdPlugin = {
  id: 'vmafThreshold',
  afterDraw(chart) {
    const threshold = chart.options.plugins?.vmafThreshold?.value;
    if (threshold == null) return;
    const { ctx, chartArea, scales } = chart;
    if (!scales.y) return;
    const y = scales.y.getPixelForValue(threshold);
    if (y < chartArea.top || y > chartArea.bottom) return;

    ctx.save();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();

    ctx.fillStyle = '#facc15';
    ctx.font = '11px sans-serif';
    ctx.fillText(`Target ${threshold}`, chartArea.right - 80, y - 4);
    ctx.restore();
  },
};

ChartJS.register(thresholdPlugin);

export default function RDCurve({ researchData, golden, selectedRes = '1080p', vmafThreshold = 88 }) {
  if (!researchData || researchData.length === 0) {
    return (
      <div style={{ color: '#555', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>
        No R-D data yet. Run lab to populate.
      </div>
    );
  }

  const primary = golden?.golden_recipes?.resolutions?.[selectedRes]?.h265
    || golden?.golden_recipes?.resolutions?.[selectedRes]?.h264;

  const goldenAnnotation = primary
    ? [
        {
          codec: '__golden__',
          bitrate: primary.bitrate_kbps,
          vmaf: primary.vmaf_attained,
        },
      ]
    : [];

  const enriched = [...researchData, ...goldenAnnotation];

  return <ConvexHullChart researchData={enriched} vmafThreshold={vmafThreshold} />;
}
