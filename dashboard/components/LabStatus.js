'use client';

import { useEffect, useRef, useState } from 'react';

const TOTAL_JOBS = 7; // H.265×4 + H.264×3

export default function LabStatus({ episodeId, golden, onRunComplete }) {
  const [status, setStatus] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState(null);
  const [executionArn, setExecutionArn] = useState(null);
  const pollingRef = useRef(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/status/${episodeId}`);
      const data = await res.json();
      setStatus(data);

      // Stop polling once all jobs complete
      if (data.succeeded + data.failed >= TOTAL_JOBS) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        if (onRunComplete) onRunComplete();
      }
    } catch {
      // Ignore transient errors
    }
  };

  useEffect(() => {
    fetchStatus();
    return () => clearInterval(pollingRef.current);
  }, [episodeId]);

  const startPolling = () => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(fetchStatus, 5000);
  };

  const handlePush = async () => {
    setPushing(true);
    setPushError(null);
    try {
      if (!golden?.s3_url) {
        throw new Error('No s3_url found for this episode — check showcache data.');
      }
      const res = await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId, s3Url: golden.s3_url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Push failed');
      setExecutionArn(data.executionArn);
      startPolling();
    } catch (err) {
      setPushError(err.message);
      setPushing(false);
    }
  };

  const succeeded = status?.succeeded ?? 0;
  const failed = status?.failed ?? 0;
  const running = status?.running ?? 0;
  const total = TOTAL_JOBS;
  const pct = Math.round((succeeded / total) * 100);
  const isDone = succeeded + failed >= total && total > 0;
  const isRunning = running > 0 || (succeeded > 0 && !isDone);

  return (
    <div>
      {/* Progress bar */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888', marginBottom: 6 }}>
          <span>{succeeded}/{total} jobs succeeded</span>
          {failed > 0 && <span style={{ color: '#ef4444' }}>{failed} failed</span>}
          {running > 0 && <span style={{ color: '#f59e0b' }}>{running} running</span>}
        </div>
        <div style={{
          height: 10,
          background: '#1e1e1e',
          borderRadius: 999,
          overflow: 'hidden',
          border: '1px solid #2a2a2a',
        }}>
          <div style={{
            height: '100%',
            width: `${pct}%`,
            background: failed > 0 ? '#ef4444' : '#22c55e',
            borderRadius: 999,
            transition: 'width 0.5s ease',
          }} />
        </div>
      </div>

      {/* Status badge */}
      {isDone && (
        <div style={{
          background: '#052e16',
          border: '1px solid #22c55e',
          borderRadius: 6,
          padding: '8px 12px',
          fontSize: 13,
          color: '#22c55e',
          marginBottom: 14,
        }}>
          Lab run complete — {succeeded}/{total} encodes succeeded
        </div>
      )}

      {isRunning && !isDone && (
        <div style={{
          background: '#1c1a07',
          border: '1px solid #f59e0b',
          borderRadius: 6,
          padding: '8px 12px',
          fontSize: 13,
          color: '#f59e0b',
          marginBottom: 14,
        }}>
          Lab running — polling every 5s…
        </div>
      )}

      {executionArn && (
        <div style={{ fontSize: 11, color: '#555', wordBreak: 'break-all', marginBottom: 12 }}>
          ARN: {executionArn}
        </div>
      )}

      {/* Push button */}
      <button
        onClick={handlePush}
        disabled={pushing || isDone}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: pushing || isDone ? '#1e1e1e' : '#4da6ff',
          color: pushing || isDone ? '#555' : '#000',
          border: 'none',
          borderRadius: 8,
          padding: '10px 20px',
          fontSize: 14,
          fontWeight: 600,
          cursor: pushing || isDone ? 'not-allowed' : 'pointer',
          transition: 'background 0.2s',
          width: '100%',
          justifyContent: 'center',
        }}
      >
        {pushing ? (
          <>
            <Spinner /> Starting…
          </>
        ) : isDone ? (
          'Lab Complete'
        ) : (
          '▶ Run Lab'
        )}
      </button>

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
      display: 'inline-block',
      width: 14,
      height: 14,
      border: '2px solid #555',
      borderTop: '2px solid #4da6ff',
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}
