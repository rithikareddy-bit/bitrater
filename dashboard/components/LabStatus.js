'use client';

import { useEffect, useRef, useState } from 'react';
import { LEGACY_TOTAL_JOBS_H264, LEGACY_TOTAL_JOBS_H265 } from '@/lib/constants';

const CODEC_CONFIG = {
  h264: { total: LEGACY_TOTAL_JOBS_H264, label: 'H.264' },
  h265: { total: LEGACY_TOTAL_JOBS_H265, label: 'H.265' },
};

function hasGoldenForCodec(golden, codec) {
  const res = golden?.golden_recipes?.resolutions;
  if (!res) return false;
  const resolutions = ['1080p', '720p', '480p'];
  return resolutions.every((r) => res[r]?.[codec]);
}

export default function LabStatus({ episodeId, golden, videoUrl, onRunComplete }) {
  const [status, setStatus] = useState(null);
  const [pushing, setPushing] = useState(null);
  const [stopping, setStopping] = useState(null);
  const [pushError, setPushError] = useState(null);
  const [executionArns, setExecutionArns] = useState({});
  const pollingRef = useRef(null);
  const goldenPollRef = useRef(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/status/${episodeId}`);
      const data = await res.json();
      setStatus(data);

      const h264 = data.h264 ?? data;
      const h265 = data.h265 ?? data;
      const neitherRunning = h264?.labStatus !== 'RUNNING' && h265?.labStatus !== 'RUNNING';
      if (neitherRunning) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
        if (onRunComplete) onRunComplete();
        startGoldenPoll();
      }
    } catch {
      // transient
    }
  };

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
    const h264Complete = golden?.lab_status_h264 === 'COMPLETE' || golden?.lab_status_h264 === 'FAILED';
    const h265Complete = golden?.lab_status_h265 === 'COMPLETE' || golden?.lab_status_h265 === 'FAILED';
    if (h264Complete && h265Complete) {
      stopGoldenPoll();
    }
  }, [golden?.lab_status_h264, golden?.lab_status_h265]);

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

  const handlePush = async (codec) => {
    setPushing(codec);
    setPushError(null);
    try {
      if (!videoUrl) {
        throw new Error('No s3_url found for this episode — check showcache data.');
      }
      const res = await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId, s3Url: videoUrl, codec }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Push failed');
      setExecutionArns((prev) => ({ ...prev, [codec]: data.executionArn }));
      setPushing(null);
      startPolling();
    } catch (err) {
      setPushError(err.message);
      setPushing(null);
    }
  };

  const handleRerun = (codec) => {
    if (!window.confirm(`This will delete all H.${codec === 'h264' ? '264' : '265'} research data and re-run. Continue?`)) return;
    handlePush(codec);
  };

  const handleStop = async (codec) => {
    if (!window.confirm(`Stop the running H.${codec === 'h264' ? '264' : '265'} lab?`)) return;
    setStopping(codec);
    try {
      const res = await fetch('/api/stop-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId, codec }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Stop failed');
      clearInterval(pollingRef.current);
      pollingRef.current = null;
      if (onRunComplete) onRunComplete();
      fetchStatus();
    } catch (err) {
      setPushError(err.message);
    } finally {
      setStopping(null);
    }
  };

  return (
    <div>
      {(['h264', 'h265']).map((codec) => {
        const cfg = CODEC_CONFIG[codec];
        const s = status?.[codec] ?? status ?? {};
        const total = s.total ?? cfg.total;
        const succeeded = s.succeeded ?? 0;
        const failed = s.failed ?? 0;
        const running = s.running ?? 0;
        const pct = total > 0 ? Math.round((succeeded / total) * 100) : 0;
        const isDone = succeeded + failed >= total && total > 0;
        const batchAllSucceeded = isDone && failed === 0 && succeeded >= total;
        const serverRunning = s.labStatus === 'RUNNING';
        const resolutionPhases = s.resolutionPhases || null;
        const labStatusKey = `lab_status_${codec}`;
        const labErrorKey = `lab_error_${codec}`;
        const labFinishedKey = `lab_finished_at_${codec}`;
        const labStartedKey = `lab_run_started_at_${codec}`;
        const serverComplete = golden?.[labStatusKey] === 'COMPLETE';
        const serverFailed = s.labStatus === 'FAILED' || golden?.[labStatusKey] === 'FAILED';
        const hasGolden = hasGoldenForCodec(golden, codec);
        const showLabSpinner = pushing === codec || (!isDone && (running > 0 || serverRunning));
        const isPartialFailure = (isDone && failed > 0 && !hasGolden) || (serverFailed && !hasGolden);
        const labComplete = isDone && !isPartialFailure && (hasGolden || serverComplete);
        const otherRunning = (codec === 'h264' ? status?.h265?.labStatus : status?.h264?.labStatus) === 'RUNNING';

        const labDuration = (() => {
          const start = golden?.[labStartedKey];
          const end = golden?.[labFinishedKey];
          if (!start || !end) return null;
          const ms = new Date(end).getTime() - new Date(start).getTime();
          if (ms <= 0 || isNaN(ms)) return null;
          const totalSec = Math.round(ms / 1000);
          const m = Math.floor(totalSec / 60);
          const s_ = totalSec % 60;
          const avgSec = Math.round(totalSec / total);
          return { text: `${m}m ${s_}s`, avgText: `~${avgSec}s avg per encode` };
        })();

        return (
          <LabSection
            key={codec}
            codec={codec}
            label={cfg.label}
            total={total}
            succeeded={succeeded}
            failed={failed}
            running={running}
            pct={pct}
            isPartialFailure={isPartialFailure}
            labComplete={labComplete}
            batchAllSucceeded={batchAllSucceeded}
            labDuration={labDuration}
            showLabSpinner={showLabSpinner}
            isRunning={!isDone && (running > 0 || serverRunning)}
            serverRunning={serverRunning}
            serverComplete={serverComplete}
            hasGolden={hasGolden}
            serverFailed={serverFailed}
            labError={golden?.[labErrorKey]}
            resolutionPhases={resolutionPhases}
            executionArn={executionArns[codec]}
            pushing={pushing === codec}
            stopping={stopping === codec}
            disabledByOther={otherRunning}
            onPush={() => handlePush(codec)}
            onRerun={() => handleRerun(codec)}
            onStop={() => handleStop(codec)}
          />
        );
      })}

      {pushError && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>
          Error: {pushError}
        </div>
      )}
    </div>
  );
}

function LabSection({
  codec,
  label,
  total,
  succeeded,
  failed,
  running,
  pct,
  isPartialFailure,
  labComplete,
  batchAllSucceeded,
  labDuration,
  showLabSpinner,
  isRunning,
  serverRunning,
  serverComplete,
  hasGolden,
  serverFailed,
  labError,
  resolutionPhases,
  executionArn,
  pushing,
  stopping,
  disabledByOther,
  onPush,
  onRerun,
  onStop,
}) {
  const isDone = succeeded + failed >= total && total > 0;

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
        {label} ({total} jobs)
      </div>

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
          {label} lab failed — {failed > 0 ? `${failed}/${total} jobs failed. ` : ''}
          Aggregation did not complete. Re-run to retry.
          {labError && (
            <pre style={{ fontSize: 10, marginTop: 8, whiteSpace: 'pre-wrap', color: '#888' }}>
              {String(labError).slice(0, 500)}
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
          {label} lab complete — {succeeded}/{total} encodes succeeded
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
          {label} lab running — {succeeded + failed}/{total} completed ({running} active)
        </div>
      )}

      {resolutionPhases && (
        <div style={{ marginBottom: 14, display: 'grid', gap: 6 }}>
          {['1080p', '720p', '480p'].map((res) => {
            const info = resolutionPhases?.[res];
            if (!info) return null;
            return (
              <div
                key={res}
                style={{
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  padding: '6px 10px',
                  fontSize: 12,
                  color: '#94a3b8',
                  background: '#111827',
                }}
              >
                <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{res}</span>
                {' · '}
                <span>{info.phase}</span>
                {' · '}
                <span>{info.message || `${info.tested} tested, ${info.pending} pending`}</span>
              </div>
            );
          })}
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
          All {label} encodes finished — waiting for aggregator…
        </div>
      )}

      {executionArn && (
        <div style={{ fontSize: 11, color: '#555', wordBreak: 'break-all', marginBottom: 12 }}>
          ARN: {executionArn}
        </div>
      )}

      {labComplete ? (
        <button
          onClick={onRerun}
          disabled={pushing || disabledByOther}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: (pushing || disabledByOther) ? '#1e1e1e' : '#334155',
            color: (pushing || disabledByOther) ? '#555' : '#e2e8f0',
            border: '1px solid #475569',
            borderRadius: 8,
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 600,
            cursor: (pushing || disabledByOther) ? 'not-allowed' : 'pointer',
            transition: 'background 0.2s',
            width: '100%',
            justifyContent: 'center',
          }}
        >
          ↻ Rerun {label} Lab
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onPush}
            disabled={pushing || (!isDone && serverRunning) || (batchAllSucceeded && !hasGolden && !serverFailed) || disabledByOther}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: (pushing || (!isDone && serverRunning) || (batchAllSucceeded && !hasGolden && !serverFailed) || disabledByOther) ? '#1e1e1e' : '#4da6ff',
              color: (pushing || (!isDone && serverRunning) || (batchAllSucceeded && !hasGolden && !serverFailed) || disabledByOther) ? '#555' : '#000',
              border: 'none',
              borderRadius: 8,
              padding: '10px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: (pushing || (!isDone && serverRunning) || (batchAllSucceeded && !hasGolden && !serverFailed) || disabledByOther) ? 'not-allowed' : 'pointer',
              transition: 'background 0.2s',
              flex: 1,
              justifyContent: 'center',
            }}
          >
            {pushing ? (
              <><Spinner /> Starting…</>
            ) : showLabSpinner ? (
              <><Spinner /> {label} Lab Running…</>
            ) : batchAllSucceeded && !hasGolden && !serverFailed ? (
              <><Spinner /> Finalizing…</>
            ) : (
              `▶ Run lab ${label}`
            )}
          </button>
          {(isRunning || (!isDone && serverRunning)) && (
            <button
              onClick={onStop}
              disabled={stopping}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: stopping ? '#1e1e1e' : '#7f1d1d',
                color: stopping ? '#555' : '#fca5a5',
                border: '1px solid #991b1b',
                borderRadius: 8,
                padding: '10px 16px',
                fontSize: 14,
                fontWeight: 600,
                cursor: stopping ? 'not-allowed' : 'pointer',
                transition: 'background 0.2s',
                whiteSpace: 'nowrap',
              }}
            >
              {stopping ? 'Stopping…' : '■ Stop'}
            </button>
          )}
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
