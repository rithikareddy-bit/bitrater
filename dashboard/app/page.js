'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { resolveShowPosterUrl } from '@/lib/posterUrl';
import {
  getCachedShow,
  setCachedShow,
  getCachedEpisodeStatus,
  fetchEpisodeStatus,
} from '@/lib/catalogSessionCache';

const STATUS_COLORS = {
  DONE: '#22c55e',
  PENDING: '#f59e0b',
  FAILED: '#ef4444',
  'NOT RUN': '#555',
};

const PAGE_SIZE = 24;

function formatShowTimestamp(show) {
  const updated = show.updatedAt ?? show.updated_at;
  const created = show.createdAt ?? show.created_at;
  const raw = updated ?? created;
  if (!raw) return null;
  const label = updated ? 'Updated' : 'Added';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return `${label} ${raw}`;
  return `${label} ${d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function mergeListShowWithDetail(full, prev) {
  return {
    ...full,
    episodeCount: full.episodes?.length ?? prev.episodeCount,
    posterUrl: full.posterUrl ?? prev.posterUrl,
    updatedAt: full.updatedAt ?? prev.updatedAt,
    createdAt: full.createdAt ?? prev.createdAt,
  };
}

export default function ShowsPage() {
  const [shows, setShows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/shows?limit=${PAGE_SIZE}&skip=0`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setShows(data.shows || []);
        setHasMore(Boolean(data.hasMore));
        setLoading(false);
      })
      .catch(() => { setError('Failed to load shows'); setLoading(false); });
  }, []);

  function loadMore() {
    setLoadingMore(true);
    fetch(`/api/shows?limit=${PAGE_SIZE}&skip=${shows.length}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        if (data.error) return;
        setShows((prev) => [...prev, ...(data.shows || [])]);
        setHasMore(Boolean(data.hasMore));
      })
      .catch(() => { /* keep existing list on load-more failure */ })
      .finally(() => setLoadingMore(false));
  }

  async function toggleExpand(show) {
    const id = show._id;
    const idStr = String(id);
    const closing = expanded === id;
    setExpanded(closing ? null : id);
    if (closing) return;

    const count =
      show.episodeCount ?? show.episode_count ?? (show.episodes || []).length;
    const hasEpisodesLoaded = Array.isArray(show.episodes) && show.episodes.length > 0;
    if (count === 0 || hasEpisodesLoaded) return;

    const cached = getCachedShow(idStr);
    if (cached) {
      setShows((prev) =>
        prev.map((s) => (String(s._id) === idStr ? mergeListShowWithDetail(cached, s) : s))
      );
      return;
    }

    try {
      const r = await fetch(`/api/shows/${idStr}`);
      if (!r.ok) return;
      const full = await r.json();
      if (full.error) return;
      setCachedShow(idStr, full);
      setShows((prev) =>
        prev.map((s) => (String(s._id) === idStr ? mergeListShowWithDetail(full, s) : s))
      );
    } catch {
      /* keep card without episodes */
    }
  }

  if (loading) return <p style={{ color: '#888' }}>Loading shows...</p>;
  if (error) return <p style={{ color: '#f87171' }}>{error}</p>;
  if (!shows.length) return <p style={{ color: '#888' }}>No shows found in catalog.</p>;

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 20 }}>Show Catalog</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16 }}>
        {shows.map((show) => {
          const cardImage = show.posterUrl || resolveShowPosterUrl(show) || show.thumbnail;
          const dateLine = formatShowTimestamp(show);
          const posterFrame = {
            width: '100%',
            aspectRatio: '9 / 16',
            background: '#1e1e1e',
            overflow: 'hidden',
            position: 'relative',
          };
          return (
          <div key={show._id} style={{
            background: '#161616',
            border: expanded === show._id ? '1px solid #4da6ff' : '1px solid #2a2a2a',
            borderRadius: 10,
            overflow: 'hidden',
            cursor: 'pointer',
            transition: 'border-color 0.2s',
          }}>
            <div style={posterFrame}>
              {cardImage ? (
                <img
                  src={cardImage}
                  alt={show.title}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              ) : (
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#444',
                  fontSize: 13,
                }}>
                  No thumbnail
                </div>
              )}
            </div>
            <div
              style={{ padding: '12px 14px' }}
              onClick={() => toggleExpand(show)}
            >
              <div style={{ fontWeight: 600, fontSize: 15 }}>{show.title || 'Untitled Show'}</div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                {(() => {
                  const n =
                    show.episodeCount ??
                    show.episode_count ??
                    (show.episodes || []).length;
                  return `${n} episode${n !== 1 ? 's' : ''}`;
                })()}
              </div>
              {dateLine && (
                <div style={{ color: '#666', fontSize: 11, marginTop: 6 }}>
                  {dateLine}
                </div>
              )}
            </div>

            {expanded === show._id && (
              <div style={{ borderTop: '1px solid #222', padding: '10px 14px' }}>
                {(show.episodes || []).length === 0 && (show.trailers_playback_urls || []).length === 0 && (
                  <p style={{ color: '#555', fontSize: 13 }}>No episodes or trailers</p>
                )}
                {(show.episodes || []).length > 0 && (
                  <>
                    <SectionLabel>Episodes</SectionLabel>
                    {(show.episodes || []).map((ep) => (
                      <EpisodeRow key={ep._id || ep.id} episode={ep} />
                    ))}
                  </>
                )}
                {(show.trailers_playback_urls || []).length > 0 && (
                  <>
                    <SectionLabel>Trailers</SectionLabel>
                    {(show.trailers_playback_urls || []).map((t, i) => (
                      <TrailerRow
                        key={t._key || i}
                        trailer={t}
                        index={i}
                        showId={String(show._id)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          );
        })}
      </div>
      {hasMore && (
        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: '1px solid #333',
              background: '#1a1a1a',
              color: '#e8e8e8',
              cursor: loadingMore ? 'wait' : 'pointer',
              fontSize: 14,
            }}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, color: '#64748b',
      textTransform: 'uppercase', letterSpacing: '0.06em',
      margin: '8px 0 4px',
    }}>
      {children}
    </div>
  );
}

function TrailerRow({ trailer, index, showId }) {
  const [status, setStatus] = useState(null);
  const trailerId = trailer?._key ? `trailer_${showId}_${trailer._key}` : null;

  useEffect(() => {
    if (!trailerId) return;
    const cached = getCachedEpisodeStatus(trailerId);
    if (cached !== undefined) {
      setStatus(cached);
      return;
    }
    setStatus(null);
    let cancelled = false;
    fetchEpisodeStatus(trailerId).then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [trailerId]);

  const label = status || '...';
  const color = STATUS_COLORS[label] || '#555';
  const title = trailer.title || `Trailer ${index + 1}`;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 0', borderBottom: '1px solid #1e1e1e', fontSize: 13,
    }}>
      {trailerId ? (
        <Link href={`/episode/${encodeURIComponent(trailerId)}`} style={{ color: '#e8e8e8', flex: 1 }}>
          {title}
        </Link>
      ) : (
        <span style={{ color: '#e8e8e8', flex: 1 }}>{title}</span>
      )}
      <span style={{
        fontSize: 11, fontWeight: 600, color,
        border: `1px solid ${color}`, borderRadius: 4,
        padding: '1px 6px', marginLeft: 8, whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
    </div>
  );
}

function EpisodeRow({ episode }) {
  const [status, setStatus] = useState(null);
  const epId = episode._id || episode.id;

  useEffect(() => {
    if (!epId) return;
    const cached = getCachedEpisodeStatus(epId);
    if (cached !== undefined) {
      setStatus(cached);
      return;
    }
    setStatus(null);
    let cancelled = false;
    fetchEpisodeStatus(epId).then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, [epId]);

  const label = status || '...';
  const color = STATUS_COLORS[label] || '#555';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 0', borderBottom: '1px solid #1e1e1e', fontSize: 13,
    }}>
      <Link href={`/episode/${epId}`} style={{ color: '#e8e8e8', flex: 1 }}>
        {episode.title || epId}
      </Link>
      <span style={{
        fontSize: 11, fontWeight: 600, color,
        border: `1px solid ${color}`, borderRadius: 4,
        padding: '1px 6px', marginLeft: 8, whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
    </div>
  );
}