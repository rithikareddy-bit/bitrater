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
  /** GCP transcoding errors — separate per leg so H.264 + thumbnail VTT do not share one banner. */
  const [gcpErr264, setGcpErr264] = useState(null);
  const [gcpErr265, setGcpErr265] = useState(null);
  const [vttErr, setVttErr] = useState(null);
  const [vttInfo, setVttInfo] = useState(null);
  const [combining, setCombining] = useState(false);
  const [combineError, setCombineError] = useState(null);
  const [combinedUrl, setCombinedUrl] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncOk, setSyncOk] = useState(null);
  const [qcResult, setQcResult] = useState(null);
  const [qcRunning, setQcRunning] = useState(false);
  const [qcError, setQcError] = useState(null);
  const qcPollRef = useRef(null);
  const pollingRef = useRef(null);

  const resolutions = goldenRecipes?.resolutions;
  const labCompleteH264 = hasGoldenForCodec(resolutions, 'h264');
  const labCompleteH265 = hasGoldenForCodec(resolutions, 'h265');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/gcp-status/${episodeId}`);
      const data = await res.json();
      setStatus(data);
      if (data.combined_master_m3u8_url) {
        setCombinedUrl(data.combined_master_m3u8_url);
      }

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
    // Restore QC state on mount/refresh
    fetch(`/api/quality-check/${episodeId}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d) return;
        if (d.overall === 'RUNNING') {
          // Lambda still running — re-enable spinner and resume polling
          setQcRunning(true);
          qcPollRef.current = setInterval(async () => {
            try {
              const r = await fetch(`/api/quality-check/${episodeId}`);
              const result = await r.json();
              if (result && result.overall && result.overall !== 'RUNNING') {
                setQcResult(result);
                setQcRunning(false);
                clearInterval(qcPollRef.current);
              }
            } catch { /* ignore */ }
          }, 5000);
        } else {
          setQcResult(d);
        }
      })
      .catch(() => {});
    return () => {
      clearInterval(pollingRef.current);
      clearInterval(qcPollRef.current);
    };
  }, [fetchStatus, episodeId]);

  const handleRunH264 = async () => {
    setPushing('h264');
    setGcpErr264(null);
    setVttErr(null);
    setVttInfo(null);
    try {
      const [gcpSettled, vttSettled] = await Promise.allSettled([
        fetch('/api/gcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeId, codec: 'h264' }),
        }),
        fetch('/api/episode-vtt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeId }),
        }),
      ]);

      if (gcpSettled.status === 'fulfilled') {
        const r = gcpSettled.value;
        let data = {};
        try {
          const t = await r.text();
          if (t) data = JSON.parse(t);
        } catch { /* ignore */ }
        if (!r.ok) {
          setGcpErr264(data.error || `GCP H.264 failed (${r.status})`);
        } else {
          startPolling();
        }
      } else {
        setGcpErr264(gcpSettled.reason?.message || 'GCP H.264 request failed');
      }

      if (vttSettled.status === 'fulfilled') {
        const r = vttSettled.value;
        let data = {};
        try {
          const t = await r.text();
          if (t) data = JSON.parse(t);
        } catch { /* ignore */ }
        if (!r.ok) {
          setVttErr(data.error || `Thumbnail VTT failed (${r.status})`);
        } else if (data.skipped) {
          setVttInfo('VTT file already exists — skipped generation');
        } else {
          setVttInfo(data.message || 'Thumbnail VTT generation complete');
          fetchStatus();
        }
      } else {
        setVttErr(vttSettled.reason?.message || 'Thumbnail VTT request failed');
      }
    } finally {
      setPushing(null);
    }
  };

  const handleRunGCP = async (codec) => {
    if (codec === 'h264') {
      await handleRunH264();
      return;
    }
    setPushing(codec);
    setGcpErr265(null);
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
      setGcpErr265(err.message);
      setPushing(null);
    }
  };

  const handleCheckQuality = async () => {
    setQcRunning(true);
    setQcError(null);
    setQcResult(null);
    try {
      const res = await fetch(`/api/quality-check/${episodeId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start quality check');
      // Poll until result arrives
      qcPollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/quality-check/${episodeId}`);
          const d = await r.json();
          if (d && d.overall && d.overall !== 'RUNNING') {
            setQcResult(d);
            setQcRunning(false);
            clearInterval(qcPollRef.current);
          }
        } catch { /* ignore */ }
      }, 5000);
    } catch (err) {
      setQcError(err.message);
      setQcRunning(false);
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

  const handleSyncShowcache = async () => {
    if (!combinedUrl) return;
    setSyncing(true);
    setSyncError(null);
    setSyncOk(null);
    try {
      const res = await fetch('/api/sync-showcache-episode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId, signedPlaybackUrl: combinedUrl }),
      });
      let data = {};
      try {
        const text = await res.text();
        if (text) data = JSON.parse(text);
      } catch {
        throw new Error(res.ok ? 'Invalid response from server' : `Sync failed (${res.status})`);
      }
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      setSyncOk('Saved signed_playback_url and download_config on show catalog.');
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
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

      {status?.thumb_vtt?.vtt_url && (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, wordBreak: 'break-all' }}>
          <div style={{ fontWeight: 600, color: '#94a3b8', marginBottom: 4 }}>Thumbnail VTT</div>
          <div><strong style={{ color: '#7dd3fc' }}>VTT:</strong> {status.thumb_vtt.vtt_url}</div>
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

      {gcpErr264 && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
          H.264 transcoding: {gcpErr264}
        </div>
      )}
      {gcpErr265 && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
          H.265 transcoding: {gcpErr265}
        </div>
      )}
      {vttErr && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
          Thumbnail VTT: {vttErr}
        </div>
      )}
      {vttInfo && (
        <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 8 }}>
          {vttInfo}
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

      {combinedUrl && (
        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            onClick={handleSyncShowcache}
            disabled={syncing}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: syncing ? '#1e1e1e' : '#1d4ed8',
              color: syncing ? '#555' : '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: syncing ? 'not-allowed' : 'pointer',
              width: '100%',
              justifyContent: 'center',
            }}
          >
            {syncing ? <><Spinner color="#1d4ed8" /> Syncing…</> : '↗ Sync to show catalog'}
          </button>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 10, lineHeight: 1.45 }}>
            <strong style={{ color: '#888' }}>Will sync this URL to signed_playback_url:</strong>
            <div
              style={{
                fontFamily: 'ui-monospace, monospace',
                wordBreak: 'break-all',
                color: '#94a3b8',
                marginTop: 6,
              }}
            >
              {combinedUrl}
            </div>
          </div>
          {syncError && (
            <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{syncError}</div>
          )}
          {syncOk && (
            <div style={{ color: '#22c55e', fontSize: 12, marginTop: 8 }}>{syncOk}</div>
          )}
        </div>
      )}

      {/* Quality Check button — visible only when combined URL exists */}
      {combinedUrl && (
        <div style={{ marginTop: 12 }}>
          <button
            onClick={handleCheckQuality}
            disabled={qcRunning}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: qcRunning ? '#1e1e1e' : '#16803c',
              color: qcRunning ? '#555' : '#fff',
              border: 'none', borderRadius: 8, padding: '10px 20px',
              fontSize: 14, fontWeight: 600,
              cursor: qcRunning ? 'not-allowed' : 'pointer',
              transition: 'background 0.2s', width: '100%', justifyContent: 'center',
            }}
          >
            {qcRunning ? <><Spinner color="#16803c" /> Checking frames…</> : '🔍 Check Video Quality'}
          </button>

          {qcError && (
            <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>
              QC error: {qcError}
            </div>
          )}

          {qcResult && <QualityResult result={qcResult} />}
        </div>
      )}
    </div>
  );
}

function Spinner({ color = '#9333ea' }) {
  return (
    <span style={{
      display: 'inline-block', width: 14, height: 14,
      border: '2px solid #555', borderTop: `2px solid ${color}`,
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

const ISSUE_COLORS = {
  blocking:    '#f59e0b',
  blur:        '#818cf8',
  freeze:      '#fb7185',
  black_frame: '#6b7280',
};

const ISSUE_LABELS = {
  blocking:    'Blocking',
  blur:        'Blur',
  freeze:      'Frozen',
  black_frame: 'Black',
};

function QualityResult({ result }) {
  const pass = result.overall === 'PASS';
  const streams = result.streams || {};

  return (
    <div style={{ marginTop: 12 }}>
      {/* Overall badge */}
      <div style={{
        display: 'inline-block', padding: '4px 12px', borderRadius: 20,
        fontSize: 13, fontWeight: 700,
        background: pass ? '#052e16' : '#1c0707',
        color: pass ? '#22c55e' : '#ef4444',
        border: `1px solid ${pass ? '#22c55e' : '#ef4444'}`,
        marginBottom: 10,
      }}>
        {pass ? '✓ PASS — No issues found' : '✗ Issues found'}
      </div>

      {/* Per-codec results */}
      {[['h265_1080p', 'H.265 — 1080p'], ['h264_1080p', 'H.264 — 1080p']].map(([key, label]) => {
        const s = streams[key];
        if (!s) return null;
        const blockMax = Math.max(...(s.block_per_sec || [0]), 0.001);
        const blurMax  = Math.max(...(s.blur_per_sec  || [0]), 0.001);
        const codecPass = s.overall === 'PASS';
        return (
          <div key={key} style={{
            marginBottom: 12, padding: '10px 12px',
            background: '#111', borderRadius: 8,
            border: `1px solid ${codecPass ? '#1a3a1a' : '#3a1a1a'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#ccc' }}>{label}</span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 10,
                background: codecPass ? '#052e16' : '#1c0707',
                color: codecPass ? '#22c55e' : '#ef4444',
              }}>
                {codecPass ? 'PASS' : `${s.issues?.length} issue${s.issues?.length !== 1 ? 's' : ''}`}
              </span>
            </div>

            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: '#555', marginBottom: 3 }}>Blocking</div>
              <QualityBar values={s.block_per_sec} max={blockMax} threshold={0.02} color="#f59e0b" />
            </div>
            <div style={{ marginBottom: s.issues?.length > 0 ? 8 : 0 }}>
              <div style={{ fontSize: 10, color: '#555', marginBottom: 3 }}>Blur</div>
              <QualityBar values={s.blur_per_sec} max={blurMax} threshold={0.8} color="#818cf8" />
            </div>

            {s.issues?.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {s.issues.map((issue, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 8px', borderRadius: 5,
                    background: '#0a0a0a', border: `1px solid ${ISSUE_COLORS[issue.type] || '#333'}`,
                    fontSize: 11,
                  }}>
                    <span style={{
                      width: 56, textAlign: 'center', padding: '1px 4px', borderRadius: 3,
                      background: ISSUE_COLORS[issue.type] || '#333',
                      color: '#000', fontWeight: 700, fontSize: 10,
                    }}>
                      {ISSUE_LABELS[issue.type] || issue.type}
                    </span>
                    <span style={{ color: '#aaa' }}>{formatTime(issue.timestamp)}</span>
                    {issue.score != null && <span style={{ color: '#555' }}>score: {issue.score}</span>}
                    {issue.duration != null && <span style={{ color: '#555' }}>{issue.duration}s</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ fontSize: 10, color: '#444', marginTop: 4 }}>
        Checked at {result.checked_at ? new Date(result.checked_at).toLocaleString() : '—'}
      </div>
    </div>
  );
}

function QualityBar({ values = [], max, threshold, color }) {
  if (!values.length) return null;
  return (
    <div style={{ display: 'flex', gap: 1, height: 20, alignItems: 'flex-end' }}>
      {values.map((v, i) => {
        const h = Math.max(2, Math.round((v / max) * 20));
        const bad = v > threshold;
        return (
          <div
            key={i}
            title={`${i}s: ${v.toFixed(4)}`}
            style={{
              flex: 1, height: h,
              background: bad ? color : '#2a2a2a',
              borderRadius: 1,
              minWidth: 2,
            }}
          />
        );
      })}
    </div>
  );
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
