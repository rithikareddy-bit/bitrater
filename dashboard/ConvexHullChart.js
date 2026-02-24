import { Line } from 'react-chartjs-2';

const ConvexHullChart = ({ researchData }) => {
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
      }
    ]
  };

  const options = {
    scales: {
      x: { title: { display: true, text: 'Bitrate (Kbps)' } },
      y: { title: { display: true, text: 'VMAF Score' }, min: 80, max: 100 }
    }
  };

  return <Line data={data} options={options} />;
};