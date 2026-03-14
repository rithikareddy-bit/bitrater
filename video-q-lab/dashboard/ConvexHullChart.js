import { Line } from 'react-chartjs-2';

const ConvexHullChart = ({ researchData, vmafThreshold = 88 }) => {
  const goldenPoints = researchData
    .filter(r => r.codec === '__golden__')
    .map(r => ({ x: r.bitrate, y: r.vmaf }));

  const data = {
    datasets: [
      {
        label: 'H.265 (HEVC) Quality Curve',
        data: researchData.filter(r => r.codec === 'libx265').map(r => ({ x: r.bitrate, y: r.vmaf })),
        borderColor: '#FF5733',
        backgroundColor: 'rgba(255, 87, 51, 0.2)',
        showLine: true,
      },
      {
        label: 'H.264 (AVC) Quality Curve',
        data: researchData.filter(r => r.codec === 'libx264').map(r => ({ x: r.bitrate, y: r.vmaf })),
        borderColor: '#3380FF',
        showLine: true,
      },
      ...(goldenPoints.length > 0 ? [{
        label: 'Golden Pick',
        data: goldenPoints,
        borderColor: '#22c55e',
        backgroundColor: '#22c55e',
        pointRadius: 8,
        pointHoverRadius: 10,
        pointStyle: 'circle',
        showLine: false,
      }] : []),
    ]
  };

  const yMin = Math.max(0, vmafThreshold - 20);

  const options = {
    scales: {
      x: { type: 'linear', title: { display: true, text: 'Bitrate (Kbps)' } },
      y: { type: 'linear', title: { display: true, text: 'VMAF Score' }, min: yMin, max: 100 }
    },
    plugins: {
      vmafThreshold: { value: vmafThreshold },
    },
  };

  return <Line data={data} options={options} />;
};

export default ConvexHullChart;
