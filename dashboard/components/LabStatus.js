'use client';

import { useEffect, useRef, useState } from 'react';
import { TOTAL_JOBS } from '@/lib/constants';

export default function LabStatus({ episodeId, golden, videoUrl, onRunComplete }) {
  const [status, setStatus] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState(null);
  const [executionArn, setExecutionArn] = useState(null);
  const pollingRef = useRef(null);
  const goldenPollRef = useRef(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/status/${episodeId}`);
      const data = await res.json();
      setStatus(data);

      if (data.succeeded + data.failed >= TOTAL_JOBS || data.labStatus === 'FAILED') {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        if (onRunComplete) onRunComplete();
        startGoldenPoll();
      }
    } catch {
      // transient
    }
  };

  /** Poll episode data every 5s until lab_status flips to COMPLETE or FAILED */
  const startGoldenPoll = () => {
    if (goldenPollRef.current) return;
    goldenPollRef.current = setInterval(() => {
      if (onRunComplete) onRunComplete();
    }, 5000);
  };

  const stopGoldenPoll = () => {
    clearInterval(goldenPollRef.current);
    goldenPollRef.current = null;
  };

  useEffect(() => {
    const labStatus = golden?.lab_status;
    if (labStatus === 'COMPLETE' || labStatus === 'FAILED') {
      stopGoldenPoll();
    }
  }, [golden?.lab_status]);

  useEffect(() => {
    fetchStatus();
    return () => {
      clearInterval(pollingRef.current);
      clearInterval(goldenPollRef.current);
    };
  }, [episodeId]);

  const startPolling = () => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(fetchStatus, 5000);
  };

  const handlePush = async () => {
    setPushing(true);
    setPushError(null);
    try {
      if (!videoUrl) {
        throw new Error('No s3_url found for this episode — check showcache data.');
      }
      const res = await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId, s3Url: videoUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Push failed');
      setExecutionArn(data.executionArn);
      setPushing(false);
      startPolling();
    } catch (err) {
      setPushError(err.message);
      setPushing(false);
    }
  };

  const handleRerun = () => {
    if (!window.confirm('This will delete all existing research data and re-run the full lab. Continue?')) return;
    handlePush();
  };

  const succeeded = status?.succeeded ?? 0;
  const failed = status?.failed ?? 0;
  const running = status?.running ?? 0;
  const total = TOTAL_JOBS;
  const pct = Math.round((succeeded / total) * 100);
  const isDone = succeeded + failed >= total && total > 0;
  const batchAllSucceeded = isDone && failed === 0 && succeeded >= total;
  const isRunning = !isDone && (running > 0 || (succeeded > 0 && succeeded + failed < total));
  const serverRunning = status?.labStatus === 'RUNNING';
  const serverComplete = golden?.lab_status === 'COMPLETE';
  const serverFailed = status?.labStatus === 'FAILED' || golden?.lab_status === 'FAILED';
  const hasGolden = !!golden?.golden_recipes?.resolutions;
  const showLabSpinner = pushing || (!isDone && (running > 0 || serverRunning));
  const isPartialFailure =
    (isDone && failed > 0 && !hasGolden) || (serverFailed && !hasGolden);
  const labComplete = isDone && !isPartialFailure && (hasGolden || serverComplete);

  useEffect(() => {
    if (serverRunning && !pollingRef.current) startPolling();
  }, [status?.labStatus, serverRunning]);

  // --- Duration ---
  const labDuration = (() => {
    const start = golden?.lab_run_started_at;
    const end = golden?.lab_finished_at;
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms <= 0 || isNaN(ms)) return null;
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const avgSec = Math.round(totalSec / total);
    return { text: `${m}m ${s}s`, avgText: `~${avgSec}s avg per encode` };
  })();

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

      {/* Status badges */}
      {isPartialFailure && (
        <div style={{
          background: '#1c0707',
          border: '1px solid #ef4444',
          borderRadius: 6,
          padding: '8px 12px',
          fontSize: 13,
          color: '#ef4444',
          marginBottom: 14,
        }}>
          Lab failed — {failed > 0 ? `${failed}/${total} Batch jobs failed. ` : ''}
          Aggregation did not complete. Re-run to retry.
          {golden?.lab_error && (
            <pre style={{ fontSize: 10, marginTop: 8, whiteSpace: 'pre-wrap', color: '#888' }}>
              {String(golden.lab_error).slice(0, 500)}
            </pre>
          )}
        </div>
      )}

      {labComplete && (
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
          {labDuration && (
            <span style={{ color: '#6ee7b7', marginLeft: 8 }}>
              ({labDuration.text}, {labDuration.avgText})
            </span>
          )}
        </div>
      )}

      {(isRunning || (!isDone && serverRunning)) && (
        <div style={{
          background: '#1c1a07',
          border: '1px solid #f59e0b',
          borderRadius: 6,
          padding: '8px 12px',
          fontSize: 13,
          color: '#f59e0b',
          marginBottom: 14,
        }}>
          Lab running — {succeeded + failed}/{total} completed ({running} active)
        </div>
      )}

      {batchAllSucceeded && !hasGolden && !serverFailed && !serverComplete && (
        <div style={{
          background: '#1a1a0c',
          border: '1px solid #ca8a04',
          borderRadius: 6,
          padding: '8px 12px',
          fontSize: 13,
          color: '#eab308',
          marginBottom: 14,
        }}>
          All encodes finished — waiting for aggregator to compute golden recipes…
        </div>
      )}

      {executionArn && (
        <div style={{ fontSize: 11, color: '#555', wordBreak: 'break-all', marginBottom: 12 }}>
          ARN: {executionArn}
        </div>
      )}

      {/* Primary action button */}
      {labComplete ? (
        <button
          onClick={handleRerun}
          disabled={pushing}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: pushing ? '#1e1e1e' : '#334155',
            color: pushing ? '#555' : '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: 8,
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 600,
            cursor: pushing ? 'not-allowed' : 'pointer',
            transition: 'background 0.2s',
            width: '100%',
            justifyContent: 'center',
          }}
        >
          ↻ Rerun Lab
        </button>
      ) : (
        <button
          onClick={handlePush}
          disabled={pushing || (!isDone && serverRunning) || (batchAllSucceeded && !hasGolden && !serverFailed)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: (pushing || (!isDone && serverRunning) || (batchAllSucceeded && !hasGolden && !serverFailed)) ? '#1e1e1e' : '#4da6ff',
            color: (pushing || (!isDone && serverRunning) || (batchAllSucceeded && !hasGolden && !serverFailed)) ? '#555' : '#000',
            border: 'none',
            borderRadius: 8,
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 600,
            cursor: (pushing || (!isDone && serverRunning) || (batchAllSucceeded && !hasGolden && !serverFailed)) ? 'not-allowed' : 'pointer',
            transition: 'background 0.2s',
            width: '100%',
            justifyContent: 'center',
          }}
        >
          {pushing ? (
            <><Spinner /> Starting…</>
          ) : showLabSpinner ? (
            <><Spinner /> Lab Running…</>
          ) : batchAllSucceeded && !hasGolden ? (
            <><Spinner /> Finalizing…</>
          ) : (
            '▶ Run Lab'
          )}
        </button>
      )}

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
