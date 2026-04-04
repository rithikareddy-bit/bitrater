import { Line } from 'react-chartjs-2';
import { bitrateAxisFromCandidates, mergeBitrateAxisWithData } from './lib/rdChart';

const POINT = {
  pointRadius: 6,
  pointHoverRadius: 9,
  pointBorderWidth: 2,
  pointBorderColor: '#0d0d0d',
};

const GoldenPOINT = {
  pointRadius: 10,
  pointHoverRadius: 12,
  pointBorderWidth: 2,
  pointBorderColor: '#0d0d0d',
};

const ConvexHullChart = ({
  researchData,
  vmafThreshold = 88,
  resolution = '1080p',
}) => {
  const goldenPoints = researchData
    .filter((r) => r.codec === '__golden__')
    .map((r) => ({ x: r.bitrate, y: r.vmaf }));

  const data = {
    datasets: [
      {
        label: 'H.265 (HEVC) Quality Curve',
        data: researchData.filter((r) => r.codec === 'libx265').map((r) => ({ x: r.bitrate, y: r.vmaf })),
        borderColor: '#FF5733',
        backgroundColor: 'rgba(255, 87, 51, 0.25)',
        showLine: true,
        tension: 0.15,
        ...POINT,
      },
      {
        label: 'H.264 (AVC) Quality Curve',
        data: researchData.filter((r) => r.codec === 'libx264').map((r) => ({ x: r.bitrate, y: r.vmaf })),
        borderColor: '#3380FF',
        backgroundColor: 'rgba(51, 128, 255, 0.15)',
        showLine: true,
        tension: 0.15,
        ...POINT,
      },
      ...(goldenPoints.length > 0
        ? [
            {
              label: 'Golden Pick',
              data: goldenPoints,
              borderColor: '#22c55e',
              backgroundColor: '#22c55e',
              ...GoldenPOINT,
              pointStyle: 'circle',
              showLine: false,
            },
          ]
        : []),
    ],
  };

  const yMin = Math.max(0, vmafThreshold - 20);
  const baseAxis = bitrateAxisFromCandidates(resolution);
  const xAxis = mergeBitrateAxisWithData(baseAxis, researchData);

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
    scales: {
      x: {
        type: 'linear',
        min: xAxis.min,
        max: xAxis.max,
        title: { display: true, text: 'Bitrate (kbps)', color: '#888' },
        ticks: { color: '#888', maxTicksLimit: 12 },
        grid: { color: 'rgba(255,255,255,0.06)' },
      },
      y: {
        type: 'linear',
        title: { display: true, text: 'VMAF score', color: '#888' },
        min: yMin,
        max: 100,
        ticks: { color: '#888' },
        grid: { color: 'rgba(255,255,255,0.06)' },
      },
    },
    plugins: {
      vmafThreshold: { value: vmafThreshold },
      legend: {
        labels: { color: '#ccc', boxWidth: 14 },
      },
    },
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: 400, minHeight: 360 }}>
      <Line data={data} options={options} />
    </div>
  );
};

export default ConvexHullChart;
