'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import S3NotificationBell from '@/components/S3NotificationBell';

/** Must match `/api/shows` max limit — only the latest N shows (catalog sort: updated/created). */
const LATEST_SHOWS_LIMIT = 100;

const RES_ORDER = ['1080p', '720p', '480p'];

const LAB_COLORS = {
  COMPLETE: '#22c55e',
  RUNNING: '#f59e0b',
  FAILED: '#ef4444',
  'NOT RUN': '#555',
};

const QC_STYLES = {
  pass: { color: '#22c55e', border: '#22c55e', bg: 'rgba(34,197,94,0.08)' },
  issues: { color: '#f87171', border: '#f87171', bg: 'rgba(248,113,113,0.08)' },
  running: { color: '#f59e0b', border: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
  none: { color: '#666', border: '#444', bg: 'transparent' },
};

function LabPill({ status }) {
  const label =
    status === 'COMPLETE'
      ? 'Done'
      : status === 'RUNNING'
        ? 'Run…'
        : status === 'FAILED'
          ? 'Fail'
          : '—';
  const color = LAB_COLORS[status] || LAB_COLORS['NOT RUN'];
  return (
    <span
      style={{
        display: 'inline-block',
        minWidth: 44,
        textAlign: 'center',
        fontSize: 11,
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: '2px 6px',
      }}
    >
      {label}
    </span>
  );
}

function GoldenLadder({ golden, codecLabel }) {
  const parts = RES_ORDER.map((res) => {
    const g = golden?.[res];
    if (!g || g.bitrate_kbps == null) return null;
    const vmafStr = g.vmaf_attained != null ? Number(g.vmaf_attained).toFixed(1) : '—';
    let mark = '·';
    let vmafColor = '#888';
    if (g.pass === true) {
      mark = '✓';
      vmafColor = '#4ade80';
    } else if (g.pass === false) {
      mark = '✗';
      vmafColor = '#f87171';
    }
    return { res, kbps: g.bitrate_kbps, vmafStr, mark, vmafColor };
  }).filter(Boolean);

  if (parts.length === 0) {
    return (
      <span style={{ color: '#555', fontSize: 11 }}>
        {codecLabel} — no recipe
      </span>
    );
  }

  return (
    <div style={{ fontSize: 11, lineHeight: 1.45, color: '#cbd5e1' }}>
      <div style={{ fontFamily: 'ui-monospace, monospace', color: '#94a3b8' }}>
        {parts.map((p) => `${p.res.replace('p', '')}:${p.kbps}`).join(' · ')}
      </div>
      <div style={{ fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>
        VMAF{' '}
        {parts.map((p, i) => (
          <span key={p.res}>
            {i > 0 ? ' · ' : ''}
            <span style={{ color: p.vmafColor }}>
              {p.vmafStr}
              {p.mark}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function QCPill({ qc }) {
  const st = QC_STYLES[qc?.key] || QC_STYLES.none;
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 600,
        color: st.color,
        border: `1px solid ${st.border}`,
        background: st.bg,
        borderRadius: 4,
        padding: '2px 8px',
      }}
    >
      {qc?.label ?? '—'}
    </span>
  );
}

function GcpMini({ h264, h265 }) {
  return (
    <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.4 }}>
      <div>
        <span style={{ color: '#3380FF' }}>Avc</span> {h264}
      </div>
      <div>
        <span style={{ color: '#FF5733' }}>Hevc</span> {h265}
      </div>
    </div>
  );
}

function formatEpDuration(sec) {
  if (sec == null || sec < 1) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  }
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function StatBig({ label, value, sub, color }) {
  return (
    <div
      style={{
        background: '#111',
        border: '1px solid #2a2a2a',
        borderRadius: 8,
        padding: '12px 14px',
        marginBottom: 10,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || '#e2e8f0', marginTop: 4, letterSpacing: '-0.02em' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, lineHeight: 1.4 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function RollChip({ children, color }) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 11,
        padding: '3px 8px',
        borderRadius: 4,
        background: '#111',
        border: `1px solid ${color || '#333'}`,
        color: color || '#94a3b8',
        marginRight: 6,
        marginBottom: 6,
      }}
    >
      {children}
    </span>
  );
}

function ShowStatsPanel({ stats }) {
  if (!stats) return null;
  const c = stats.consumption;
  const r = stats.rollup;
  const n = stats.catalogEpisodes;

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Show stats
      </div>
      <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 14, lineHeight: 1.5 }}>
        <strong style={{ color: '#e2e8f0' }}>{stats.totalDurationLabel}</strong>
        <span style={{ color: '#64748b' }}> total runtime</span>
        <span style={{ color: '#555', marginLeft: 8, fontSize: 12 }}>
          ({stats.episodesWithDuration}/{n} eps with duration data)
        </span>
      </div>

      <StatBig
        label="Est. data — full ladder (H.264)"
        value={c.h264_full_ladder_display}
        sub={`1080+720+480 golden bitrates × duration, ${c.episodesCountedH264} eps · (kbps×s)/8/1024 MB; GB if ≥1024 MB`}
        color="#3380FF"
      />
      <StatBig
        label="Est. data — full ladder (H.265)"
        value={c.h265_full_ladder_display}
        sub={`Same method · ${c.episodesCountedH265} eps`}
        color="#FF5733"
      />

      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 14, lineHeight: 1.45 }}>
        <div>
          <span style={{ color: '#3380FF', fontWeight: 600 }}>1080p only</span> (one rung):{' '}
          {c.h264_1080_only_display}
        </div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: '#FF5733', fontWeight: 600 }}>1080p only</span>: {c.h265_1080_only_display}
        </div>
      </div>

      <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Pipeline</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', marginBottom: 8 }}>
        <RollChip color="#3380aa">
          Lab H.264 ✓ {r.lab_h264_complete}
          {r.lab_h264_failed > 0 ? ` · ✗ ${r.lab_h264_failed}` : ''}
        </RollChip>
        <RollChip color="#aa5533">
          Lab H.265 ✓ {r.lab_h265_complete}
          {r.lab_h265_failed > 0 ? ` · ✗ ${r.lab_h265_failed}` : ''}
        </RollChip>
        <RollChip color="#22c55e">QC pass {r.qc_pass}</RollChip>
        {r.qc_issues > 0 && <RollChip color="#f87171">QC issues {r.qc_issues}</RollChip>}
        <RollChip color="#64748b">GCP H.264 done {r.gcp_h264_done}</RollChip>
        <RollChip color="#64748b">GCP H.265 done {r.gcp_h265_done}</RollChip>
      </div>
      <p style={{ fontSize: 10, color: '#555', margin: 0, lineHeight: 1.45 }}>
        {stats.note}
      </p>
    </div>
  );
}

function formatDuration(ms) {
  if (ms == null || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Pipeline controls (Run Pipeline / Sync Show buttons + status badge) ──────

function PipelineControls({
  selectedId, pipelineRun, pipelineLoading, pipelineSyncing,
  pipelineError, onRunPipeline, onSyncShow, onCancel,
}) {
  const status    = pipelineRun?.status;
  const isRunning = status === 'RUNNING';
  const isDone    = status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';

  const total    = pipelineRun?.total_episodes ?? 0;
  const skipped  = pipelineRun?.skipped_count ?? 0;
  const eligible = total - skipped;
  const done     = pipelineRun?.completed_count ?? 0;
  const failed   = pipelineRun?.failed_count ?? 0;
  const ready    = done; // episodes in READY_TO_SYNC or SYNCED
  const etaMs    = pipelineRun?.eta_ms;

  const hasReady = pipelineRun?.episodes?.some(ep =>
    ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED'
  ) ?? false;

  // "Run Pipeline" button label + disabled state
  let runLabel = '▶ Run Pipeline';
  let runDisabled = pipelineLoading;
  let runTitle = '';
  if (pipelineLoading) {
    runLabel = 'Starting…';
    runDisabled = true;
  } else if (isRunning) {
    runLabel = `Pipeline Running… (${done + failed}/${eligible})`;
    runDisabled = true;
    runTitle = 'Pipeline already running';
  } else if (isDone && done === eligible && eligible > 0) {
    runDisabled = false; // allow re-run
  }

  // "Sync Show" button
  const syncDisabled = pipelineSyncing || !hasReady;
  let syncLabel = 'Sync Show';
  if (pipelineSyncing) syncLabel = 'Syncing…';

  // Status badge colours
  const badgeColor =
    isRunning ? '#f59e0b' :
    status === 'COMPLETED' ? '#22c55e' :
    status === 'CANCELLED' ? '#94a3b8' :
    status === 'FAILED' ? '#ef4444' : '#555';

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 14 }}>
        {/* Run Pipeline */}
        <button
          type="button"
          onClick={onRunPipeline}
          disabled={runDisabled}
          title={runTitle}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: `1px solid ${runDisabled ? '#2a3a2a' : '#166534'}`,
            background: runDisabled ? '#0f1f0f' : '#14532d',
            color: runDisabled ? '#4a6a4a' : '#4ade80',
            fontSize: 13,
            fontWeight: 600,
            cursor: runDisabled ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
            animation: isRunning ? 'pulse 2s ease-in-out infinite' : 'none',
          }}
        >
          {runLabel}
        </button>

        {/* Sync Show */}
        <button
          type="button"
          onClick={onSyncShow}
          disabled={syncDisabled}
          title={syncDisabled && !pipelineSyncing ? 'No episodes ready to sync' : ''}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: `1px solid ${syncDisabled ? '#1a2a3a' : '#1e3a5f'}`,
            background: syncDisabled ? '#0f172a' : '#172554',
            color: syncDisabled ? '#3a5a7a' : '#60a5fa',
            fontSize: 13,
            fontWeight: 600,
            cursor: syncDisabled ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {syncLabel}
        </button>

        {/* Cancel button — only when RUNNING */}
        {isRunning && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #4a1a1a',
              background: '#2a0f0f',
              color: '#f87171',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        )}

        {/* Status badge */}
        {pipelineRun && (
          <span style={{
            fontSize: 12,
            color: badgeColor,
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}>
            {isRunning && (
              <span style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: badgeColor,
                boxShadow: `0 0 6px ${badgeColor}`,
                animation: 'pulse 2s ease-in-out infinite',
                display: 'inline-block',
              }} />
            )}
            {status === 'RUNNING' && `Pipeline: ${done + failed}/${eligible} done`}
            {status === 'COMPLETED' && `Pipeline complete — ${done}/${eligible} ready`}
            {status === 'CANCELLED' && 'Pipeline cancelled'}
            {status === 'FAILED' && 'Pipeline failed'}
            {etaMs && isRunning ? ` · ETA ~${formatDuration(etaMs)}` : ''}
          </span>
        )}
      </div>

      {/* Error message */}
      {pipelineError && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#f87171' }}>
          {pipelineError}
        </p>
      )}

      {/* Per-status summary when run is visible */}
      {pipelineRun && (pipelineRun.failed_count > 0 || pipelineRun.skipped_count > 0) && (
        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
          {pipelineRun.failed_count > 0 && `${pipelineRun.failed_count} failed · `}
          {pipelineRun.skipped_count > 0 && `${pipelineRun.skipped_count} skipped (no s3_url)`}
        </p>
      )}
    </div>
  );
}

export default function ShowOverviewPage() {
  const [shows, setShows] = useState([]);
  const [showsLoading, setShowsLoading] = useState(true);
  const [showsError, setShowsError] = useState(null);

  const [selectedId, setSelectedId] = useState('');
  const [live, setLive] = useState(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [pollMs, setPollMs] = useState(15000);
  const [expandedEp, setExpandedEp] = useState(null);

  // ── Pipeline state ──────────────────────────────────────────────────────────
  const [pipelineRunId, setPipelineRunId]   = useState(null);
  const [pipelineRun, setPipelineRun]       = useState(null);   // full run doc
  const [pipelineLoading, setPipelineLoading] = useState(false); // "Run Pipeline" button busy
  const [pipelineSyncing, setPipelineSyncing] = useState(false); // "Sync Show" button busy
  const [pipelineError, setPipelineError]   = useState(null);
  const pipelineTimerRef = useRef(null);

  const timerRef = useRef(null);
  const visibleRef = useRef(true);

  useEffect(() => {
    const onVis = () => {
      visibleRef.current = document.visibilityState === 'visible';
    };
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    setShowsLoading(true);
    fetch(`/api/shows?limit=${LATEST_SHOWS_LIMIT}&skip=0`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (data.error) throw new Error(data.error);
        const list = data.shows || [];
        setShows(list);
        setShowsError(null);
      })
      .catch(() => setShowsError('Failed to load shows'))
      .finally(() => setShowsLoading(false));
  }, []);

  const loadLive = useCallback(async (showId, quiet) => {
    if (!showId) return;
    if (!quiet) setLiveLoading(true);
    setLiveError(null);
    try {
      const r = await fetch(`/api/shows/${showId}/episodes-live`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLive(data);
      setFetchedAt(data.fetchedAt || new Date().toISOString());
      if (data.hints?.suggestPollMs) setPollMs(data.hints.suggestPollMs);
    } catch (e) {
      setLiveError(e.message || 'Failed to load episodes');
      setLive(null);
    } finally {
      if (!quiet) setLiveLoading(false);
    }
  }, []);

  // ── Fetch active pipeline run when show is selected ─────────────────────────
  useEffect(() => {
    if (!selectedId) {
      setLive(null);
      setFetchedAt(null);
      setPollMs(15000);
      setPipelineRunId(null);
      setPipelineRun(null);
      setPipelineError(null);
      return;
    }
    setPollMs(15000);
    loadLive(selectedId, false);

    // Look up any existing pipeline run for this show
    fetch(`/api/auto-pipeline/active/${selectedId}`)
      .then(r => r.json())
      .then(data => {
        if (data?.run) {
          setPipelineRunId(String(data.run._id));
          setPipelineRun(data.run);
        } else {
          setPipelineRunId(null);
          setPipelineRun(null);
        }
      })
      .catch(() => { /* non-fatal */ });
  }, [selectedId, loadLive]);

  useEffect(() => {
    if (!selectedId) return;
    const tick = () => {
      if (!visibleRef.current) return;
      loadLive(selectedId, true);
    };
    timerRef.current = setInterval(tick, pollMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [selectedId, pollMs, loadLive]);

  // ── Poll pipeline status every 10 s while a run is known ─────────────────
  useEffect(() => {
    if (!pipelineRunId) return;
    // Also stop polling if run reached a terminal state
    const isTerminalRun = pipelineRun?.status &&
      ['COMPLETED', 'FAILED', 'CANCELLED'].includes(pipelineRun.status);
    if (isTerminalRun) return;

    const poll = () => {
      fetch(`/api/auto-pipeline/status/${pipelineRunId}`)
        .then(r => r.json())
        .then(data => {
          if (data && !data.error) setPipelineRun(data);
        })
        .catch(() => { /* non-fatal */ });
    };
    pipelineTimerRef.current = setInterval(poll, 10_000);
    return () => clearInterval(pipelineTimerRef.current);
  }, [pipelineRunId, pipelineRun?.status]);

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: '#4da6ff' }}>
          ← Catalog
        </Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          Show overview
          <S3NotificationBell fetchUrl="/api/s3-notifications" />
        </h1>
      </div>

      <div
        style={{
          background: '#161616',
          border: '1px solid #2a2a2a',
          borderRadius: 10,
          padding: '18px 20px',
          marginBottom: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 28,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <label
              htmlFor="show-select"
              style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 8 }}
            >
              Select show
            </label>
            {showsLoading && <p style={{ color: '#888', margin: 0 }}>Loading shows…</p>}
            {showsError && <p style={{ color: '#f87171', margin: 0 }}>{showsError}</p>}
            {!showsLoading && !showsError && (
              <select
                id="show-select"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                style={{
                  width: '100%',
                  maxWidth: 440,
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid #333',
                  background: '#111',
                  color: '#e8e8e8',
                  fontSize: 14,
                }}
              >
                <option value="">— Choose a show —</option>
                {shows.map((s) => (
                  <option key={String(s._id)} value={String(s._id)}>
                    {s.title || 'Untitled'} ({s.episodeCount ?? '?'} ep)
                  </option>
                ))}
              </select>
            )}
            {!showsLoading && !showsError && shows.length > 0 && (
              <p style={{ margin: '10px 0 0', fontSize: 11, color: '#555', maxWidth: 440 }}>
                Latest {LATEST_SHOWS_LIMIT} shows from the catalog, most recently updated first (same order as
                the home page list API).
              </p>
            )}
            {selectedId && (
              <PipelineControls
                selectedId={selectedId}
                pipelineRun={pipelineRun}
                pipelineLoading={pipelineLoading}
                pipelineSyncing={pipelineSyncing}
                pipelineError={pipelineError}
                onRunPipeline={async () => {
                  setPipelineLoading(true);
                  setPipelineError(null);
                  try {
                    const res = await fetch('/api/auto-pipeline/start', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ showId: selectedId }),
                    });
                    const data = await res.json();
                    if (res.status === 409 && data.runId) {
                      // Already running — attach to that run
                      setPipelineRunId(data.runId);
                      const statusRes = await fetch(`/api/auto-pipeline/status/${data.runId}`);
                      if (statusRes.ok) setPipelineRun(await statusRes.json());
                    } else if (!res.ok) {
                      setPipelineError(data.error || `HTTP ${res.status}`);
                    } else {
                      setPipelineRunId(data.runId);
                      // Fetch initial status
                      const statusRes = await fetch(`/api/auto-pipeline/status/${data.runId}`);
                      if (statusRes.ok) setPipelineRun(await statusRes.json());
                    }
                  } catch (err) {
                    setPipelineError(err.message || 'Failed to start pipeline');
                  } finally {
                    setPipelineLoading(false);
                  }
                }}
                onSyncShow={async () => {
                  setPipelineSyncing(true);
                  setPipelineError(null);
                  try {
                    const res = await fetch('/api/auto-pipeline/sync-all', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ showId: selectedId }),
                    });
                    const data = await res.json();
                    if (!res.ok) {
                      setPipelineError(data.error || `Sync failed (HTTP ${res.status})`);
                    } else {
                      // Refresh pipeline run status after sync
                      if (pipelineRunId) {
                        const sr = await fetch(`/api/auto-pipeline/status/${pipelineRunId}`);
                        if (sr.ok) setPipelineRun(await sr.json());
                      }
                      // Refresh episode table
                      loadLive(selectedId, true);
                    }
                  } catch (err) {
                    setPipelineError(err.message || 'Sync failed');
                  } finally {
                    setPipelineSyncing(false);
                  }
                }}
                onCancel={async () => {
                  if (!pipelineRunId) return;
                  try {
                    await fetch('/api/auto-pipeline/cancel', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ runId: pipelineRunId }),
                    });
                    // Refresh status
                    const sr = await fetch(`/api/auto-pipeline/status/${pipelineRunId}`);
                    if (sr.ok) setPipelineRun(await sr.json());
                  } catch { /* non-fatal */ }
                }}
              />
            )}
          </div>

          <div className="show-overview-stats" style={{ flex: '1 1 300px', minWidth: 260 }}>
            {!selectedId && (
              <p style={{ color: '#555', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                Select a show for <strong style={{ color: '#777' }}>runtime rollups</strong>,{' '}
                <strong style={{ color: '#777' }}>estimated storage / data</strong> (golden ladders), and pipeline counts.
              </p>
            )}
            {selectedId && liveLoading && !live && (
              <p style={{ color: '#888', fontSize: 13, margin: 0 }}>Loading show stats…</p>
            )}
            {selectedId && liveError && (
              <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>{liveError}</p>
            )}
            {live?.stats && <ShowStatsPanel stats={live.stats} />}
          </div>
        </div>
      </div>

      {selectedId && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 12,
            marginBottom: 12,
            fontSize: 12,
            color: '#888',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: '#4ade80',
              fontWeight: 600,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#4ade80',
                boxShadow: '0 0 8px rgba(74,222,128,0.6)',
                animation: 'pulse 2s ease-in-out infinite',
              }}
            />
            Live
          </span>
          <span>
            Refresh every {Math.round(pollMs / 1000)}s
            {live?.hints?.anyRunningLab || live?.hints?.anyRunningGcp || live?.hints?.anyRunningQc
              ? ' (faster while jobs run)'
              : ''}
          </span>
          {fetchedAt && (
            <span style={{ color: '#555' }}>
              Last update: {new Date(fetchedAt).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => loadLive(selectedId, false)}
            disabled={liveLoading}
            style={{
              marginLeft: 'auto',
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #333',
              background: '#1a1a1a',
              color: '#e8e8e8',
              fontSize: 12,
            }}
          >
            {liveLoading ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
        .show-overview-stats {
          border-left: 1px solid #2a2a2a;
          padding-left: 28px;
        }
        @media (max-width: 720px) {
          .show-overview-stats {
            border-left: none;
            padding-left: 0;
            border-top: 1px solid #2a2a2a;
            padding-top: 20px;
            margin-top: 4px;
            width: 100%;
          }
        }
      `}</style>

      {selectedId && liveLoading && !live && (
        <p style={{ color: '#888' }}>Loading episodes…</p>
      )}

      {live && (
        <div
          style={{
            background: '#161616',
            border: '1px solid #2a2a2a',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '14px 18px',
              borderBottom: '1px solid #2a2a2a',
              fontSize: 13,
              fontWeight: 600,
              color: '#888',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {live.showTitle}
            <span style={{ color: '#555', fontWeight: 400, marginLeft: 8 }}>
              {live.episodeCount} episode{live.episodeCount !== 1 ? 's' : ''}
            </span>
            <S3NotificationBell
              fetchUrl={`/api/s3-notifications/${selectedId}`}
              label="Show"
              style={{ marginLeft: 'auto', textTransform: 'none' }}
            />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                minWidth: 1020,
                borderCollapse: 'collapse',
                fontSize: 12,
              }}
            >
              <thead>
                <tr style={{ background: '#111' }}>
                  {[
                    '#',
                    'Episode',
                    'Dur.',
                    'Lab H.264',
                    'Lab H.265',
                    'Golden H.264',
                    'Golden H.265',
                    'QC',
                    'GCP',
                    '',
                  ].map((h) => (
                    <th
                      key={h || 'actions'}
                      style={{
                        textAlign: h === '#' || h === 'Dur.' ? 'center' : 'left',
                        padding: '10px 12px',
                        borderBottom: '1px solid #2a2a2a',
                        color: '#888',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        position: 'sticky',
                        top: 0,
                        background: '#111',
                        zIndex: 1,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {live.episodes.map((row, i) => {
                  const isExpanded = expandedEp === row.episodeId;
                  return (
                  <EpisodeTableRow
                    key={row.episodeId || i}
                    row={row}
                    index={i}
                    isExpanded={isExpanded}
                    onToggle={() => setExpandedEp(isExpanded ? null : row.episodeId)}
                    onActionDone={() => loadLive(selectedId, true)}
                    colCount={10}
                  />
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '12px 18px', fontSize: 11, color: '#555', lineHeight: 1.5 }}>
            VMAF ✓ / ✗ uses thresholds 1080p≥88, 720p≥75, 480p≥48 on golden recipe scores. QC is the
            combined-manifest visual check (PASS / Issues). GCP shows Transcoder job status.
          </div>
        </div>
      )}

      {selectedId && !liveLoading && live && live.episodes.length === 0 && (
        <p style={{ color: '#888' }}>This show has no episodes in catalog data.</p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Episode table row with expandable actions panel                         */
/* ────────────────────────────────────────────────────────────────────────── */

function EpisodeTableRow({ row, index, isExpanded, onToggle, onActionDone, colCount }) {
  return (
    <>
      <tr
        style={{
          borderBottom: isExpanded ? 'none' : '1px solid #1e1e1e',
          background: isExpanded
            ? 'rgba(77,166,255,0.04)'
            : index % 2 === 0
              ? 'transparent'
              : 'rgba(255,255,255,0.02)',
          cursor: 'pointer',
        }}
        onClick={onToggle}
      >
        <td style={{ padding: '10px 12px', textAlign: 'center', color: '#64748b', fontWeight: 600, verticalAlign: 'top' }}>
          {row.episodeNumber}
        </td>
        <td style={{ padding: '10px 12px', verticalAlign: 'top', maxWidth: 200 }}>
          {row.episodeId ? (
            <Link
              href={`/episode/${encodeURIComponent(row.episodeId)}`}
              style={{ color: '#e2e8f0', fontWeight: 500, lineHeight: 1.35 }}
              onClick={(e) => e.stopPropagation()}
            >
              {row.title || row.episodeId}
            </Link>
          ) : (
            <span style={{ color: '#555' }}>—</span>
          )}
          {row.episodeId && (
            <div style={{ fontSize: 10, color: '#555', marginTop: 4, wordBreak: 'break-all' }}>
              {row.episodeId}
            </div>
          )}
        </td>
        <td style={{ padding: '10px 8px', verticalAlign: 'top', textAlign: 'center', fontSize: 11, color: '#64748b', whiteSpace: 'nowrap' }}>
          {formatEpDuration(row.durationSeconds)}
        </td>
        <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>
          <LabPill status={row.lab_h264} />
        </td>
        <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>
          <LabPill status={row.lab_h265} />
        </td>
        <td style={{ padding: '10px 12px', verticalAlign: 'top', minWidth: 160 }}>
          <GoldenLadder golden={row.golden_h264} codecLabel="H.264" />
        </td>
        <td style={{ padding: '10px 12px', verticalAlign: 'top', minWidth: 160 }}>
          <GoldenLadder golden={row.golden_h265} codecLabel="H.265" />
        </td>
        <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>
          <QCPill qc={row.qc} />
        </td>
        <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>
          <GcpMini h264={row.gcp_h264} h265={row.gcp_h265} />
        </td>
        <td style={{ padding: '10px 12px', verticalAlign: 'top', textAlign: 'center' }}>
          <span style={{
            display: 'inline-block',
            fontSize: 11,
            fontWeight: 600,
            color: isExpanded ? '#4da6ff' : '#555',
            transition: 'transform 0.2s',
            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}>
            ▼
          </span>
        </td>
      </tr>
      {isExpanded && (
        <tr style={{ background: 'rgba(77,166,255,0.04)', borderBottom: '1px solid #2a2a2a' }}>
          <td colSpan={colCount} style={{ padding: 0 }}>
            <EpisodeActions row={row} onActionDone={onActionDone} />
          </td>
        </tr>
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Inline action buttons for a single episode                              */
/* ────────────────────────────────────────────────────────────────────────── */

const ACTION_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  borderRadius: 6,
  padding: '7px 14px',
  fontSize: 12,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
  transition: 'opacity 0.15s',
  whiteSpace: 'nowrap',
};

function ActionBtn({ label, color, disabled, loading, onClick }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled || loading}
      style={{
        ...ACTION_BTN,
        background: disabled || loading ? '#1e1e1e' : color,
        color: disabled || loading ? '#555' : '#fff',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {loading && <MiniSpinner />}
      {label}
    </button>
  );
}

function MiniSpinner() {
  return (
    <span style={{
      display: 'inline-block', width: 12, height: 12,
      border: '2px solid #555', borderTop: '2px solid #4da6ff',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

function EpisodeActions({ row, onActionDone }) {
  const [busy, setBusy] = useState({});
  const [msgs, setMsgs] = useState({});
  // Track the combined URL locally so Sync works immediately after Create Combined
  const [localCombinedUrl, setLocalCombinedUrl] = useState(row.combined_url || null);

  // Update local URL when the poll brings in a fresh value
  useEffect(() => {
    if (row.combined_url) setLocalCombinedUrl(row.combined_url);
  }, [row.combined_url]);

  const setActionBusy = (key, val) => setBusy((p) => ({ ...p, [key]: val }));
  const setMsg = (key, type, text) => setMsgs((p) => ({ ...p, [key]: { type, text } }));
  const clearMsg = (key) => setMsgs((p) => { const n = { ...p }; delete n[key]; return n; });

  const apiCall = async (key, url, opts) => {
    setActionBusy(key, true);
    clearMsg(key);
    try {
      const res = await fetch(url, opts);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setMsg(key, 'ok', data.message || 'Done');
      if (onActionDone) onActionDone();
      return data;
    } catch (err) {
      setMsg(key, 'err', err.message);
      return null;
    } finally {
      setActionBusy(key, false);
    }
  };

  const epId = row.episodeId;
  const hasH264Golden = row.golden_h264 && Object.values(row.golden_h264).some((v) => v?.bitrate_kbps);
  const hasH265Golden = row.golden_h265 && Object.values(row.golden_h265).some((v) => v?.bitrate_kbps);
  const hasCombined = Boolean(localCombinedUrl);
  const labH264Running = row.lab_h264 === 'RUNNING';
  const labH265Running = row.lab_h265 === 'RUNNING';
  const gcpH264Active = row.gcp_h264 === '…';
  const gcpH265Active = row.gcp_h265 === '…';

  const handleRunLabH264 = () => apiCall('lab264', '/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeId: epId, s3Url: row.s3_url, codec: 'h264' }),
  });

  const handleRunLabH265 = () => apiCall('lab265', '/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeId: epId, s3Url: row.s3_url, codec: 'h265' }),
  });

  const handleProbe = () => apiCall('probe', '/api/probe-source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeId: epId }),
  });

  // GCP H.264 also triggers VTT generation (same as episode page GCPStatus.handleRunH264)
  const handleGcpH264 = async () => {
    setActionBusy('gcp264', true);
    clearMsg('gcp264');
    clearMsg('vtt');
    try {
      const [gcpSettled, vttSettled] = await Promise.allSettled([
        fetch('/api/gcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeId: epId, codec: 'h264' }),
        }),
        fetch('/api/episode-vtt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeId: epId }),
        }),
      ]);

      if (gcpSettled.status === 'fulfilled') {
        const r = gcpSettled.value;
        let data = {};
        try { const t = await r.text(); if (t) data = JSON.parse(t); } catch { /* ignore */ }
        if (!r.ok) {
          setMsg('gcp264', 'err', data.error || `GCP H.264 failed (${r.status})`);
        } else {
          setMsg('gcp264', 'ok', 'GCP H.264 started');
        }
      } else {
        setMsg('gcp264', 'err', gcpSettled.reason?.message || 'GCP H.264 request failed');
      }

      if (vttSettled.status === 'fulfilled') {
        const r = vttSettled.value;
        let data = {};
        try { const t = await r.text(); if (t) data = JSON.parse(t); } catch { /* ignore */ }
        if (!r.ok) {
          setMsg('vtt', 'err', data.error || `VTT failed (${r.status})`);
        } else if (data.skipped) {
          setMsg('vtt', 'ok', 'VTT already exists');
        } else {
          setMsg('vtt', 'ok', data.message || 'VTT generated');
        }
      } else {
        setMsg('vtt', 'err', vttSettled.reason?.message || 'VTT request failed');
      }

      if (onActionDone) onActionDone();
    } finally {
      setActionBusy('gcp264', false);
    }
  };

  const handleGcpH265 = () => apiCall('gcp265', '/api/gcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeId: epId, codec: 'h265' }),
  });

  const handleCombine = async () => {
    const data = await apiCall('combine', '/api/create-combined-master', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId: epId }),
    });
    // Capture the URL so Sync can use it immediately without waiting for poll
    if (data?.combined_master_m3u8_url) {
      setLocalCombinedUrl(data.combined_master_m3u8_url);
    }
  };

  const handleSync = () => {
    if (!localCombinedUrl) {
      setMsg('sync', 'err', 'No combined URL — run Create Combined URL first');
      return;
    }
    return apiCall('sync', '/api/sync-showcache-episode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId: epId, signedPlaybackUrl: localCombinedUrl }),
    });
  };

  const handleQC = async () => {
    const data = await apiCall('qc', `/api/quality-check/${epId}`, {
      method: 'POST',
    });
    // POST returns { status: 'RUNNING' } — override the generic "Done" message
    if (data) setMsg('qc', 'ok', 'QC started — watch status in table');
  };

  return (
    <div
      style={{
        padding: '14px 18px',
        borderTop: '1px solid #1a2a3a',
        background: 'rgba(77,166,255,0.02)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Actions — {row.title || epId}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <ActionBtn
          label={labH264Running ? 'Lab H.264 Running…' : '▶ Run Lab H.264'}
          color="#4da6ff"
          disabled={!row.s3_url || labH264Running}
          loading={busy.lab264}
          onClick={handleRunLabH264}
        />
        <ActionBtn
          label={labH265Running ? 'Lab H.265 Running…' : '▶ Run Lab H.265'}
          color="#4da6ff"
          disabled={!row.s3_url || labH265Running}
          loading={busy.lab265}
          onClick={handleRunLabH265}
        />
        <ActionBtn
          label="Calculate FPS & Res"
          color="#0f766e"
          loading={busy.probe}
          onClick={handleProbe}
        />
        <ActionBtn
          label={gcpH264Active ? 'GCP H.264 Running…' : '▶ Run GCP H.264'}
          color="#9333ea"
          disabled={!hasH264Golden || gcpH264Active}
          loading={busy.gcp264}
          onClick={handleGcpH264}
        />
        <ActionBtn
          label={gcpH265Active ? 'GCP H.265 Running…' : '▶ Run GCP H.265'}
          color="#9333ea"
          disabled={!hasH265Golden || gcpH265Active}
          loading={busy.gcp265}
          onClick={handleGcpH265}
        />
        <ActionBtn
          label="Create Combined URL"
          color="#0e7490"
          disabled={!row.has_h264_url || !row.has_h265_url}
          loading={busy.combine}
          onClick={handleCombine}
        />
        <ActionBtn
          label="Sync"
          color="#1d4ed8"
          disabled={!hasCombined}
          loading={busy.sync}
          onClick={handleSync}
        />
        <ActionBtn
          label="Check Quality"
          color="#16803c"
          disabled={!hasCombined}
          loading={busy.qc}
          onClick={handleQC}
        />
      </div>

      {/* Feedback messages */}
      {Object.entries(msgs).length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {Object.entries(msgs).map(([key, { type, text }]) => (
            <span
              key={key}
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 4,
                background: type === 'ok' ? '#052e16' : '#1c0707',
                border: `1px solid ${type === 'ok' ? '#22c55e' : '#ef4444'}`,
                color: type === 'ok' ? '#22c55e' : '#ef4444',
              }}
            >
              {key}: {text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
