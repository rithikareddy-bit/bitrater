'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import GCPStatus from '@/components/GCPStatus';
import {
  AV_RESOLUTIONS,
  bitratesFromGoldenRecipes,
  defaultBitrates,
  emptyBitrates,
  formatKbps,
} from '@/lib/avLadder';

/** `/api/shows` MAX_LIMIT is 500 (>> current ~165 shows). */
const ALL_SHOWS_LIMIT = 500;

const PANEL = {
  background: '#161616',
  border: '1px solid #2a2a2a',
  borderRadius: 10,
  padding: 18,
};

const PANEL_TITLE = {
  fontSize: 12,
  fontWeight: 600,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 12,
};

const GCP_COLORS = {
  Done: '#22c55e',
  '…': '#f59e0b',
  Fail: '#ef4444',
  Cancelled: '#94a3b8',
};

function GcpPill({ label }) {
  const color = GCP_COLORS[label] || '#555';
  return (
    <span style={{
      display: 'inline-block', minWidth: 40, textAlign: 'center',
      fontSize: 11, fontWeight: 600, color,
      border: `1px solid ${color}`, borderRadius: 4, padding: '2px 6px',
    }}>
      {label || '—'}
    </span>
  );
}

export default function AudioVideoPage() {
  const [shows, setShows] = useState([]);
  const [showsError, setShowsError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedShowId, setSelectedShowId] = useState('');

  const [live, setLive] = useState(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState(null);

  const [selectedEpisodeId, setSelectedEpisodeId] = useState(null);

  useEffect(() => {
    fetch(`/api/shows?limit=${ALL_SHOWS_LIMIT}&skip=0`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setShows(d.shows || []);
      })
      .catch(() => setShowsError('Failed to load shows'));
  }, []);

  const loadEpisodes = useCallback(async (showId) => {
    if (!showId) { setLive(null); return; }
    setLiveLoading(true);
    setLiveError(null);
    try {
      const r = await fetch(`/api/shows/${showId}/episodes-live`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setLive(d);
    } catch (err) {
      setLiveError(err.message);
      setLive(null);
    } finally {
      setLiveLoading(false);
    }
  }, []);

  useEffect(() => {
    setSelectedEpisodeId(null);
    loadEpisodes(selectedShowId);
  }, [selectedShowId, loadEpisodes]);

  const filteredShows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shows;
    return shows.filter((s) => (s.title || '').toLowerCase().includes(q));
  }, [shows, search]);

  const episodes = live?.episodes || [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Audio-Video</h2>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          4-rung ladder (144p → 1080p) · manual bitrates · no Lab
        </span>
      </div>
      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 18px', lineHeight: 1.5 }}>
        Sources come from <code style={{ color: '#94a3b8' }}>master.showcache.episodes[].s3_url</code>, same as
        the catalog. Enter the bitrates, save the ladder, then run GCP per codec — thumbnail VTT,
        subtitles, combined master and catalog sync are the existing steps, unchanged.
      </p>

      {showsError && (
        <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{showsError}</div>
      )}

      {/* Show picker */}
      <div style={{ ...PANEL, marginBottom: 16 }}>
        <div style={PANEL_TITLE}>Show</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shows…"
            style={{
              flex: '0 0 240px', background: '#0d0d0d', border: '1px solid #333',
              borderRadius: 6, padding: '8px 10px', color: '#e8e8e8', fontSize: 13,
            }}
          />
          <select
            value={selectedShowId}
            onChange={(e) => setSelectedShowId(e.target.value)}
            style={{
              flex: 1, minWidth: 260, background: '#0d0d0d', border: '1px solid #333',
              borderRadius: 6, padding: '8px 10px', color: '#e8e8e8', fontSize: 13,
            }}
          >
            <option value="">— select a show ({filteredShows.length}) —</option>
            {filteredShows.map((s) => (
              <option key={s._id} value={s._id}>
                {s.title} {s.language ? `· ${String(s.language).toUpperCase()}` : ''} · {s.episodeCount} ep
              </option>
            ))}
          </select>
        </div>
      </div>

      {liveLoading && <p style={{ color: '#888', fontSize: 13 }}>Loading episodes…</p>}
      {liveError && <p style={{ color: '#ef4444', fontSize: 13 }}>{liveError}</p>}

      {live && (
        <div style={PANEL}>
          <div style={PANEL_TITLE}>
            {live.showTitle} — {episodes.length} episode{episodes.length === 1 ? '' : 's'}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['#', 'Title', 'Source', 'H.264', 'H.265', 'Combined', ''].map((h) => (
                  <th key={h} style={{
                    textAlign: 'left', color: '#666', fontWeight: 600, fontSize: 11,
                    padding: '6px 10px', borderBottom: '1px solid #2a2a2a',
                    textTransform: 'uppercase', letterSpacing: '0.04em',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {episodes.map((ep) => {
                const open = selectedEpisodeId === ep.episodeId;
                return (
                  <tr key={ep.episodeId || ep.episodeNumber}>
                    <td colSpan={7} style={{ padding: 0 }}>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '48px 1fr 90px 70px 70px 90px 90px',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 10px',
                          borderBottom: '1px solid #1e1e1e',
                          background: open ? '#12181f' : 'transparent',
                        }}
                      >
                        <span style={{ color: '#94a3b8', fontWeight: 600 }}>{ep.episodeNumber}</span>
                        <span style={{ color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ep.title || <span style={{ color: '#555' }}>Untitled</span>}
                        </span>
                        <span style={{ fontSize: 11, color: ep.s3_url ? '#22c55e' : '#ef4444' }}>
                          {ep.s3_url ? 's3_url ✓' : 'no s3_url'}
                        </span>
                        <GcpPill label={ep.gcp_h264} />
                        <GcpPill label={ep.gcp_h265} />
                        <span style={{ fontSize: 11, color: ep.combined_url ? '#22d3ee' : '#555' }}>
                          {ep.combined_url ? 'combined ✓' : '—'}
                        </span>
                        <button
                          type="button"
                          disabled={!ep.s3_url}
                          onClick={() => setSelectedEpisodeId(open ? null : ep.episodeId)}
                          title={ep.s3_url ? '' : 'This episode has no source in showcache'}
                          style={{
                            background: open ? '#1e293b' : '#111',
                            border: `1px solid ${ep.s3_url ? '#334155' : '#262626'}`,
                            color: ep.s3_url ? '#93c5fd' : '#444',
                            borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 600,
                            cursor: ep.s3_url ? 'pointer' : 'not-allowed',
                          }}
                        >
                          {open ? 'Close' : 'Open'}
                        </button>
                      </div>

                      {open && (
                        <EpisodePanel
                          episodeId={ep.episodeId}
                          s3Url={ep.s3_url}
                          onChanged={() => loadEpisodes(selectedShowId)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {episodes.length === 0 && (
            <p style={{ color: '#555', fontSize: 13, marginTop: 10 }}>No episodes in this show.</p>
          )}
        </div>
      )}
    </div>
  );
}

function EpisodePanel({ episodeId, s3Url, onChanged }) {
  const [bitrates, setBitrates] = useState(emptyBitrates);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveOk, setSaveOk] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/audio-video/bitrates?episodeId=${encodeURIComponent(episodeId)}`);
      const d = await r.json();
      if (r.ok) {
        setMeta(d);
        if (d.goldenRecipes?.resolutions) {
          setBitrates(bitratesFromGoldenRecipes(d.goldenRecipes));
        }
      }
    } catch { /* non-fatal — the table just starts empty */ } finally {
      setLoading(false);
    }
  }, [episodeId]);

  useEffect(() => { load(); }, [load]);

  const setCell = (res, codec, value) => {
    // Digits only: the field is whole kbps, and stray characters would fail
    // server-side validation after the round-trip instead of here.
    const clean = value.replace(/[^\d]/g, '');
    setBitrates((prev) => ({ ...prev, [res]: { ...prev[res], [codec]: clean } }));
    setSaveOk(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const r = await fetch('/api/audio-video/bitrates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId, bitrates }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Save failed (${r.status})`);
      setMeta((m) => ({ ...(m || {}), goldenRecipes: d.goldenRecipes, sourceFps: d.sourceFps, isAvLadder: true }));
      setSaveOk(`Ladder saved · ${d.resolutions.join(', ')} · fps ${d.sourceFps}`);
      if (onChanged) onChanged();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const savedRecipes = meta?.goldenRecipes || null;
  const hasSavedLadder = Boolean(savedRecipes?.resolutions && Object.keys(savedRecipes.resolutions).length);

  // The saved ladder is what GCP will encode — the inputs may hold unsaved edits,
  // so gate the run buttons on what is actually in Mongo.
  const dirty = hasSavedLadder && AV_RESOLUTIONS.some((res) => {
    const saved = savedRecipes.resolutions[res];
    for (const codec of ['h264', 'h265']) {
      const input = bitrates[res]?.[codec] ?? '';
      const savedVal = saved?.[codec]?.bitrate_kbps;
      if (String(savedVal ?? '') !== String(input)) return true;
    }
    return false;
  });

  return (
    <div style={{
      padding: '16px 14px 18px',
      background: '#0e1319',
      borderBottom: '1px solid #1e1e1e',
      display: 'grid',
      gridTemplateColumns: 'minmax(320px, 1fr) minmax(300px, 380px)',
      gap: 18,
      alignItems: 'start',
    }}>
      {/* Left: bitrate ladder */}
      <div>
        <div style={{ ...PANEL_TITLE, marginBottom: 8 }}>Bitrate ladder (kbps)</div>

        {s3Url && (
          <div style={{
            fontSize: 11, color: '#64748b', marginBottom: 10,
            wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace',
          }}>
            {s3Url}
          </div>
        )}

        {loading ? (
          <p style={{ color: '#666', fontSize: 12 }}>Loading saved ladder…</p>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', color: '#888', fontSize: 11, padding: '4px 8px' }}>Resolution</th>
                  <th style={{ textAlign: 'center', color: '#3380FF', fontSize: 11, padding: '4px 8px' }}>H.264</th>
                  <th style={{ textAlign: 'center', color: '#FF5733', fontSize: 11, padding: '4px 8px' }}>H.265</th>
                </tr>
              </thead>
              <tbody>
                {AV_RESOLUTIONS.map((res) => (
                  <tr key={res} style={{ borderTop: '1px solid #1a1a1a' }}>
                    <td style={{ padding: '6px 8px', color: '#e2e8f0', fontWeight: 600 }}>{res}</td>
                    {['h264', 'h265'].map((codec) => (
                      <td key={codec} style={{ padding: '6px 8px', textAlign: 'center' }}>
                        <input
                          inputMode="numeric"
                          value={bitrates[res]?.[codec] ?? ''}
                          onChange={(e) => setCell(res, codec, e.target.value)}
                          placeholder="—"
                          style={{
                            width: 92, textAlign: 'right',
                            background: '#0d0d0d', border: '1px solid #333', borderRadius: 5,
                            padding: '5px 8px', color: '#e8e8e8', fontSize: 13,
                            fontFamily: 'ui-monospace, monospace',
                          }}
                        />
                        <span style={{ fontSize: 10, color: '#475569', marginLeft: 6 }}>
                          {formatKbps(bitrates[res]?.[codec])}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => { setBitrates(defaultBitrates()); setSaveOk(null); }}
                style={{
                  background: '#0f766e', color: '#fff', border: 'none', borderRadius: 8,
                  padding: '8px 14px', fontSize: 12, fontWeight: 600,
                }}
              >
                ⚡ Default bitrates
              </button>
              <button
                type="button"
                onClick={() => { setBitrates(emptyBitrates()); setSaveOk(null); }}
                style={{
                  background: '#111', color: '#94a3b8', border: '1px solid #333', borderRadius: 8,
                  padding: '8px 14px', fontSize: 12, fontWeight: 600,
                }}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{
                  background: saving ? '#1e1e1e' : '#1d4ed8',
                  color: saving ? '#555' : '#fff',
                  border: 'none', borderRadius: 8, padding: '8px 14px',
                  fontSize: 12, fontWeight: 600,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                {saving ? 'Saving…' : '💾 Save ladder'}
              </button>
            </div>

            {saveError && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{saveError}</div>}
            {saveOk && <div style={{ color: '#22c55e', fontSize: 12, marginTop: 8 }}>{saveOk}</div>}
            {dirty && !saveError && (
              <div style={{ color: '#f59e0b', fontSize: 12, marginTop: 8 }}>
                Unsaved edits — GCP will encode the saved ladder until you save.
              </div>
            )}
            {!hasSavedLadder && !saveOk && (
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 8 }}>
                No ladder saved yet — the GCP buttons stay disabled until you save one.
              </div>
            )}
            {meta?.sourceFps != null && (
              <div style={{ color: '#475569', fontSize: 11, marginTop: 8 }}>
                Source FPS {meta.sourceFps} — GOP/segment duration is derived from it.
              </div>
            )}
          </>
        )}
      </div>

      {/* Right: the existing pipeline controls, unchanged */}
      <div>
        <div style={{ ...PANEL_TITLE, marginBottom: 8 }}>Pipeline</div>
        <GCPStatus
          episodeId={episodeId}
          goldenRecipes={savedRecipes}
          runLabel="New GCP"
          showPodcastVideo
        />
      </div>
    </div>
  );
}
