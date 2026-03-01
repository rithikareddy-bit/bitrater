'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import BIHeader from '@/components/BIHeader';
import RDCurve from '@/components/RDCurve';
import VMAFHeatmap from '@/components/VMAFHeatmap';
import FrameComparison from '@/components/FrameComparison';
import LabStatus from '@/components/LabStatus';

const PANEL_STYLE = {
  background: '#161616',
  border: '1px solid #2a2a2a',
  borderRadius: 10,
  padding: 20,
};

const PANEL_TITLE = {
  fontSize: 13,
  fontWeight: 600,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 14,
};

export default function EpisodePage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = () => {
    fetch(`/api/episode/${id}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => { setError('Failed to load episode data'); setLoading(false); });
  };

  useEffect(() => {
    fetchData();
  }, [id]);

  if (loading) return <p style={{ color: '#888' }}>Loading episode data...</p>;
  if (error) return <p style={{ color: '#f87171' }}>{error}</p>;

  const { research = [], golden, videoUrl } = data || {};

  // Map research data for the R-D curve
  const rdData = research.map((r) => ({
    codec: r.codec,
    bitrate: r.bitrate_kbps,
    vmaf: r.vmaf_score,
  }));

  // Extract vmaf_timeline from the golden-recipe bitrate row
  const goldenRow = golden
    ? research.find(
        (r) => r.codec === golden.codec && r.bitrate_kbps === golden.bitrate_kbps
      )
    : null;
  const vmafTimeline = goldenRow?.vmaf_timeline || [];

  return (
    <div>
      {/* Back link */}
      <a href="/" style={{ fontSize: 13, color: '#4da6ff', display: 'inline-block', marginBottom: 16 }}>
        ← Back to catalog
      </a>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>
        Episode Research — <code style={{ color: '#4da6ff', fontSize: 16 }}>{id}</code>
      </h2>

      {/* BI Header spans full width */}
      <div style={{ marginBottom: 16 }}>
        <BIHeader golden={golden} />
      </div>

      {/* 2×2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* R-D Curve */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>R-D Curve</div>
          <RDCurve researchData={rdData} golden={golden} />
        </div>

        {/* VMAF Timeline Heatmap */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>VMAF Timeline Heatmap</div>
          <VMAFHeatmap timeline={vmafTimeline} />
        </div>

        {/* Frame Comparison */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>Frame Comparison</div>
          <FrameComparison episodeId={id} golden={golden} />
        </div>

        {/* Lab Status */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>Lab Status</div>
          <LabStatus episodeId={id} golden={golden} videoUrl={videoUrl} onRunComplete={fetchData} />
        </div>
      </div>
    </div>
  );
}
