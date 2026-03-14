'use client';

import { Component, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import BIHeader from '@/components/BIHeader';
import RDCurve from '@/components/RDCurve';
import VMAFHeatmap from '@/components/VMAFHeatmap';
import FrameComparison from '@/components/FrameComparison';
import LabStatus from '@/components/LabStatus';
import GCPStatus from '@/components/GCPStatus';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: '#ef4444', fontSize: 12, padding: 12, background: '#1c0707', borderRadius: 6, border: '1px solid #ef4444' }}>
          <strong>{this.props.name} crashed:</strong> {this.state.error.message}
          <pre style={{ fontSize: 10, marginTop: 4, whiteSpace: 'pre-wrap', color: '#888' }}>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

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

const RESOLUTIONS = ['1080p', '720p', '480p'];
const VMAF_THRESHOLDS = { '1080p': 88, '720p': 75, '480p': 48 };

export default function EpisodePage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedRes, setSelectedRes] = useState('1080p');

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

  const allRdData = research.map((r) => ({
    codec: r.codec,
    bitrate: r.bitrate_kbps,
    vmaf: r.vmaf_score,
    resolution: r.resolution,
  }));

  const filteredRdData = allRdData.filter((r) => r.resolution === selectedRes);

  const vmafThreshold = VMAF_THRESHOLDS[selectedRes];
  const resData = golden?.golden_recipes?.resolutions?.[selectedRes];
  const primaryCodec = resData?.h265 ? 'libx265' : (resData?.h264 ? 'libx264' : null);
  const primaryRecipe = resData?.h265 || resData?.h264 || null;

  let goldenRow = primaryRecipe && primaryCodec
    ? research.find(
        (r) => r.bitrate_kbps === primaryRecipe.bitrate_kbps
            && r.resolution === selectedRes
            && r.codec === primaryCodec
      )
    : null;

  /* Fallback: if golden_recipes hasn't arrived yet, pick the H.265 winner from research */
  if (!goldenRow && research.length > 0) {
    const resRows = research.filter((r) => r.resolution === selectedRes && r.codec === 'libx265');
    if (resRows.length > 0) {
      const sorted = [...resRows].sort((a, b) => a.bitrate_kbps - b.bitrate_kbps);
      const above = sorted.filter((r) => r.vmaf_score >= vmafThreshold);
      goldenRow = above.length > 0 ? above[0] : sorted.reduce((a, b) => (a.vmaf_score >= b.vmaf_score ? a : b));
    }
  }

  const vmafTimeline = goldenRow?.vmaf_timeline || [];

  return (
    <div>
      <a href="/" style={{ fontSize: 13, color: '#4da6ff', display: 'inline-block', marginBottom: 16 }}>
        ← Back to catalog
      </a>

      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 20 }}>
        Episode Research — <code style={{ color: '#4da6ff', fontSize: 16 }}>{id}</code>
      </h2>

      {/* Resolution tab selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {RESOLUTIONS.map((res) => (
          <button
            key={res}
            onClick={() => setSelectedRes(res)}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 6,
              border: selectedRes === res ? '1px solid #4da6ff' : '1px solid #333',
              background: selectedRes === res ? '#1a2a3a' : '#161616',
              color: selectedRes === res ? '#4da6ff' : '#888',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {res}
          </button>
        ))}
      </div>

      {/* BI Header spans full width */}
      <div style={{ marginBottom: 16 }}>
        <ErrorBoundary name="BIHeader">
          <BIHeader
            golden={golden}
            selectedRes={selectedRes}
            research={research}
            vmafThreshold={vmafThreshold}
          />
        </ErrorBoundary>
      </div>

      {/* 2×2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* R-D Curve */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>R-D Curve — {selectedRes}</div>
          <ErrorBoundary name="RDCurve">
            <RDCurve researchData={filteredRdData} golden={golden} selectedRes={selectedRes} vmafThreshold={vmafThreshold} />
          </ErrorBoundary>
        </div>

        {/* VMAF Timeline Heatmap */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>VMAF Timeline Heatmap — {selectedRes}</div>
          <ErrorBoundary name="VMAFHeatmap">
            <VMAFHeatmap timeline={vmafTimeline} />
          </ErrorBoundary>
        </div>

        {/* Frame Comparison */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>Frame Comparison</div>
          <ErrorBoundary name="FrameComparison">
            <FrameComparison episodeId={id} golden={golden} videoUrl={videoUrl} />
          </ErrorBoundary>
        </div>

        {/* Lab Status */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>Lab Status</div>
          <ErrorBoundary name="LabStatus">
            <LabStatus episodeId={id} golden={golden} videoUrl={videoUrl} onRunComplete={fetchData} />
          </ErrorBoundary>
        </div>

        {/* GCP Transcoder Status */}
        <div style={PANEL_STYLE}>
          <div style={PANEL_TITLE}>GCP Transcoder</div>
          <ErrorBoundary name="GCPStatus">
            <GCPStatus episodeId={id} goldenRecipes={golden?.golden_recipes} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
