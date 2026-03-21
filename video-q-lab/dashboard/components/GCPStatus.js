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
  const pollingRef = useRef(null);

  const resolutions = goldenRecipes?.resolutions;
  const labCompleteH264 = hasGoldenForCodec(resolutions, 'h264');
  const labCompleteH265 = hasGoldenForCodec(resolutions, 'h265');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/gcp-status/${episodeId}`);
      const data = await res.json();
      setStatus(data);

      if (data.gcp_job_status === 'SUCCEEDED' || data.gcp_job_status === 'FAILED' || data.gcp_job_status === 'SUBTITLE_SYNC_FAILED') {
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

  const gcpStatus = status?.gcp_job_status;
  const isActive = gcpStatus === 'PENDING' || gcpStatus === 'RUNNING';
  const isSucceeded = gcpStatus === 'SUCCEEDED';
  const isFailed = gcpStatus === 'FAILED' || gcpStatus === 'SUBTITLE_SYNC_FAILED';
  const canRunH264 = labCompleteH264 && !isActive && pushing !== 'h264';
  const canRunH265 = labCompleteH265 && !isActive && pushing !== 'h265';

  useEffect(() => {
    if (isActive && !pollingRef.current) startPolling();
  }, [gcpStatus, isActive, startPolling]);

  return (
    <div>
      {/* Status badge */}
      {isSucceeded && (
        <div style={{
          background: '#052e16', border: '1px solid #22c55e', borderRadius: 6,
          padding: '8px 12px', fontSize: 13, color: '#22c55e', marginBottom: 14,
        }}>
          GCP Transcoding complete
        </div>
      )}

      {isActive && (
        <div style={{
          background: '#1c1a07', border: '1px solid #f59e0b', borderRadius: 6,
          padding: '8px 12px', fontSize: 13, color: '#f59e0b', marginBottom: 14,
        }}>
          GCP job {gcpStatus?.toLowerCase()} — polling every 10s…
        </div>
      )}

      {isFailed && (
        <div style={{
          background: '#1c0707', border: '1px solid #ef4444', borderRadius: 6,
          padding: '8px 12px', fontSize: 13, color: '#ef4444', marginBottom: 14,
        }}>
          GCP job failed{status?.gcp_error ? `: ${status.gcp_error}` : ''}
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
      </div>

      {pushError && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
          Error: {pushError}
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
