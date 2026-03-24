'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

function hasGoldenForCodec(resolutions, codec) {
  if (!resolutions) return false;
  for (const r of ['1080p', '720p', '480p']) {
    if (!resolutions[r]?.[codec]) return false;
  }
  return true;
}

export default function GCPStatus({ episodeId, goldenRecipes }) {
  const [status, setStatus] = useState(null);
  const [pushing, setPushing] = useState(null);
  const [pushError, setPushError] = useState(null);
  const [combining, setCombining] = useState(false);
  const [combineError, setCombineError] = useState(null);
  const [combinedUrl, setCombinedUrl] = useState(null);
  const pollingRef = useRef(null);

  const resolutions = goldenRecipes?.resolutions;
  const labCompleteH264 = hasGoldenForCodec(resolutions, 'h264');
  const labCompleteH265 = hasGoldenForCodec(resolutions, 'h265');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/gcp-status/${episodeId}`);
      const data = await res.json();
      setStatus(data);

      const h264Done = !data.h264?.gcp_job_status || !['PENDING', 'RUNNING'].includes(data.h264.gcp_job_status);
      const h265Done = !data.h265?.gcp_job_status || !['PENDING', 'RUNNING'].includes(data.h265.gcp_job_status);
      if (h264Done && h265Done) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    } catch {
      // transient
    }
  }, [episodeId]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(fetchStatus, 10000);
  }, [fetchStatus]);

  useEffect(() => {
    fetchStatus();
    return () => clearInterval(pollingRef.current);
  }, [fetchStatus]);

  const handleRunGCP = async (codec) => {
    setPushing(codec);
    setPushError(null);
    try {
      const res = await fetch('/api/gcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId, codec }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'GCP push failed');
      setPushing(null);
      startPolling();
    } catch (err) {
      setPushError(err.message);
      setPushing(null);
    }
  };

  const handleCreateCombined = async () => {
    setCombining(true);
    setCombineError(null);
    try {
      const res = await fetch('/api/create-combined-master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create combined URL');
      setCombinedUrl(data.combined_master_m3u8_url);
    } catch (err) {
      setCombineError(err.message);
    } finally {
      setCombining(false);
    }
  };

  const h264Status = status?.h264?.gcp_job_status;
  const h265Status = status?.h265?.gcp_job_status;
  const isActiveH264 = h264Status === 'PENDING' || h264Status === 'RUNNING';
  const isActiveH265 = h265Status === 'PENDING' || h265Status === 'RUNNING';
  const canRunH264 = labCompleteH264 && !isActiveH264 && pushing !== 'h264';
  const canRunH265 = labCompleteH265 && !isActiveH265 && pushing !== 'h265';

  useEffect(() => {
    if ((isActiveH264 || isActiveH265) && !pollingRef.current) startPolling();
  }, [h264Status, h265Status, isActiveH264, isActiveH265, startPolling]);

  return (
    <div>
      {/* Per-codec status badges */}
      {isActiveH264 && (
        <div style={{
          background: '#1c1a07', border: '1px solid #f59e0b', borderRadius: 6,
          padding: '8px 12px', fontSize: 13, color: '#f59e0b', marginBottom: 14,
        }}>
          H.264 GCP job {h264Status?.toLowerCase()} — polling every 10s…
        </div>
      )}
      {isActiveH265 && (
        <div style={{
          background: '#1c1a07', border: '1px solid #f59e0b', borderRadius: 6,
          padding: '8px 12px', fontSize: 13, color: '#f59e0b', marginBottom: 14,
        }}>
          H.265 GCP job {h265Status?.toLowerCase()} — polling every 10s…
        </div>
      )}
      {(h264Status === 'SUCCEEDED' || h265Status === 'SUCCEEDED') && (
        <div style={{
          background: '#052e16', border: '1px solid #22c55e', borderRadius: 6,
          padding: '8px 12px', fontSize: 13, color: '#22c55e', marginBottom: 14,
        }}>
          {h264Status === 'SUCCEEDED' && h265Status === 'SUCCEEDED'
            ? 'GCP Transcoding complete'
            : `${h264Status === 'SUCCEEDED' ? 'H.264' : 'H.265'} GCP complete`}
        </div>
      )}
      {(h264Status === 'FAILED' || h264Status === 'SUBTITLE_SYNC_FAILED') && (
        <div style={{
          background: '#1c0707', border: '1px solid #ef4444', borderRadius: 6,
          padding: '8px 12px', fontSize: 13, color: '#ef4444', marginBottom: 14,
        }}>
          H.264 GCP failed{status?.h264?.gcp_error ? `: ${status.h264.gcp_error}` : ''}
        </div>
      )}
      {(h265Status === 'FAILED' || h265Status === 'SUBTITLE_SYNC_FAILED') && (
        <div style={{
          background: '#1c0707', border: '1px solid #ef4444', borderRadius: 6,
          padding: '8px 12px', fontSize: 13, color: '#ef4444', marginBottom: 14,
        }}>
          H.265 GCP failed{status?.h265?.gcp_error ? `: ${status.h265.gcp_error}` : ''}
        </div>
      )}

      {/* HLS URLs */}
      {(status?.h264_master_m3u8_url || status?.h265_master_m3u8_url) && (
        <div style={{ fontSize: 12, color: '#888', marginBottom: 12, wordBreak: 'break-all' }}>
          {status.h264_master_m3u8_url && (
            <div><strong style={{ color: '#aaa' }}>H.264:</strong> {status.h264_master_m3u8_url}</div>
          )}
          {status.h265_master_m3u8_url && (
            <div><strong style={{ color: '#aaa' }}>H.265:</strong> {status.h265_master_m3u8_url}</div>
          )}
        </div>
      )}

      {/* Run GCP buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={() => handleRunGCP('h264')}
          disabled={!canRunH264}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: canRunH264 ? '#9333ea' : '#1e1e1e',
            color: canRunH264 ? '#fff' : '#555',
            border: 'none', borderRadius: 8, padding: '10px 20px',
            fontSize: 14, fontWeight: 600,
            cursor: canRunH264 ? 'pointer' : 'not-allowed',
            transition: 'background 0.2s', width: '100%', justifyContent: 'center',
          }}
        >
          {pushing === 'h264' ? <><Spinner /> Running…</> : '▶ Run GCP H.264'}
        </button>
        <button
          onClick={() => handleRunGCP('h265')}
          disabled={!canRunH265}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: canRunH265 ? '#9333ea' : '#1e1e1e',
            color: canRunH265 ? '#fff' : '#555',
            border: 'none', borderRadius: 8, padding: '10px 20px',
            fontSize: 14, fontWeight: 600,
            cursor: canRunH265 ? 'pointer' : 'not-allowed',
            transition: 'background 0.2s', width: '100%', justifyContent: 'center',
          }}
        >
          {pushing === 'h265' ? <><Spinner /> Running…</> : '▶ Run GCP H.265'}
        </button>

        {/* Combined master URL button — enabled only when both codec URLs are ready */}
        {(() => {
          const canCombine =
            !!status?.h264_master_m3u8_url &&
            !!status?.h265_master_m3u8_url &&
            !combining;
          return (
            <button
              onClick={handleCreateCombined}
              disabled={!canCombine}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: canCombine ? '#0e7490' : '#1e1e1e',
                color: canCombine ? '#fff' : '#555',
                border: 'none', borderRadius: 8, padding: '10px 20px',
                fontSize: 14, fontWeight: 600,
                cursor: canCombine ? 'pointer' : 'not-allowed',
                transition: 'background 0.2s', width: '100%', justifyContent: 'center',
                marginTop: 4,
              }}
            >
              {combining ? <><Spinner /> Creating…</> : '⊕ Create Combined Master URL'}
            </button>
          );
        })()}
      </div>

      {pushError && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
          Error: {pushError}
        </div>
      )}

      {combineError && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
          Combined URL error: {combineError}
        </div>
      )}

      {combinedUrl && (
        <div style={{
          marginTop: 10, padding: '8px 12px',
          background: '#0c2233', border: '1px solid #0e7490',
          borderRadius: 6, fontSize: 12, wordBreak: 'break-all',
        }}>
          <strong style={{ color: '#22d3ee' }}>Combined (H264 + H265):</strong>{' '}
          <span style={{ color: '#e2e8f0' }}>{combinedUrl}</span>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: 14, height: 14,
      border: '2px solid #555', borderTop: '2px solid #9333ea',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
