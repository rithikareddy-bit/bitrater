'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

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

  useEffect(() => {
    if (!selectedId) {
      setLive(null);
      setFetchedAt(null);
      setPollMs(15000);
      return;
    }
    setPollMs(15000);
    loadLive(selectedId, false);
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

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ marginBottom: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
        <Link href="/" style={{ fontSize: 13, color: '#4da6ff' }}>
          ← Catalog
        </Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, flex: '1 1 auto' }}>
          Show overview
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
            }}
          >
            {live.showTitle}
            <span style={{ color: '#555', fontWeight: 400, marginLeft: 8 }}>
              {live.episodeCount} episode{live.episodeCount !== 1 ? 's' : ''}
            </span>
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
                  ].map((h) => (
                    <th
                      key={h}
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
                {live.episodes.map((row, i) => (
                  <tr
                    key={row.episodeId || i}
                    style={{
                      borderBottom: '1px solid #1e1e1e',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <td
                      style={{
                        padding: '10px 12px',
                        textAlign: 'center',
                        color: '#64748b',
                        fontWeight: 600,
                        verticalAlign: 'top',
                      }}
                    >
                      {row.episodeNumber}
                    </td>
                    <td style={{ padding: '10px 12px', verticalAlign: 'top', maxWidth: 200 }}>
                      {row.episodeId ? (
                        <Link
                          href={`/episode/${encodeURIComponent(row.episodeId)}`}
                          style={{ color: '#e2e8f0', fontWeight: 500, lineHeight: 1.35 }}
                        >
                          {row.title || row.episodeId}
                        </Link>
                      ) : (
                        <span style={{ color: '#555' }}>—</span>
                      )}
                      {row.episodeId && (
                        <div
                          style={{
                            fontSize: 10,
                            color: '#555',
                            marginTop: 4,
                            wordBreak: 'break-all',
                          }}
                        >
                          {row.episodeId}
                        </div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: '10px 8px',
                        verticalAlign: 'top',
                        textAlign: 'center',
                        fontSize: 11,
                        color: '#64748b',
                        whiteSpace: 'nowrap',
                      }}
                      title="From research VMAF timeline length"
                    >
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
                  </tr>
                ))}
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
