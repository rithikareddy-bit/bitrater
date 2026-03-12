'use client';

import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js';
import ConvexHullChart from '../ConvexHullChart';

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Legend);

// Annotation plugin: draws a horizontal dashed line at VMAF 93.5
const goldenThresholdPlugin = {
  id: 'goldenThreshold',
  afterDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!scales.y) return;
    const y = scales.y.getPixelForValue(93.5);
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
    ctx.fillText('Target 93.5', chartArea.right - 72, y - 4);
    ctx.restore();
  },
};

ChartJS.register(goldenThresholdPlugin);

export default function RDCurve({ researchData, golden }) {
  if (!researchData || researchData.length === 0) {
    return (
      <div style={{ color: '#555', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>
        No R-D data yet. Run lab to populate.
      </div>
    );
  }

  const primary = golden?.golden_recipes?.resolutions?.['1080p']?.h265
    || golden?.golden_recipes?.resolutions?.['1080p']?.h264;

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

  return <ConvexHullChart researchData={enriched} />;
}
