'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const STATUS_COLORS = {
  DONE: '#22c55e',
  PENDING: '#f59e0b',
  FAILED: '#ef4444',
  'NOT RUN': '#555',
};

export default function ShowsPage() {
  const [shows, setShows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/shows')
      .then((r) => r.json())
      .then((data) => { setShows(data); setLoading(false); })
      .catch(() => { setError('Failed to load shows'); setLoading(false); });
  }, []);

  if (loading) return <p style={{ color: '#888' }}>Loading shows...</p>;
  if (error) return <p style={{ color: '#f87171' }}>{error}</p>;
  if (!shows.length) return <p style={{ color: '#888' }}>No shows found in catalog.</p>;

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 20 }}>Show Catalog</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
        {shows.map((show) => (
          <div key={show._id} style={{
            background: '#161616',
            border: expanded === show._id ? '1px solid #4da6ff' : '1px solid #2a2a2a',
            borderRadius: 10,
            overflow: 'hidden',
            cursor: 'pointer',
            transition: 'border-color 0.2s',
          }}>
            {show.thumbnail && (
              <img
                src={show.thumbnail}
                alt={show.title}
                style={{ width: '100%', height: 130, objectFit: 'cover', display: 'block' }}
              />
            )}
            {!show.thumbnail && (
              <div style={{
                width: '100%', height: 130,
                background: '#1e1e1e',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: '#444', fontSize: 13,
              }}>
                No thumbnail
              </div>
            )}
            <div
              style={{ padding: '12px 14px' }}
              onClick={() => setExpanded(expanded === show._id ? null : show._id)}
            >
              <div style={{ fontWeight: 600, fontSize: 15 }}>{show.title || 'Untitled Show'}</div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                {(show.episodes || []).length} episode{(show.episodes || []).length !== 1 ? 's' : ''}
              </div>
            </div>

            {expanded === show._id && (
              <div style={{ borderTop: '1px solid #222', padding: '10px 14px' }}>
                {(show.episodes || []).length === 0 && (
                  <p style={{ color: '#555', fontSize: 13 }}>No episodes</p>
                )}
                {(show.episodes || []).map((ep) => (
                  <EpisodeRow key={ep._id || ep.id} episode={ep} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EpisodeRow({ episode }) {
  const [status, setStatus] = useState(null);
  const epId = episode._id || episode.id;

  useEffect(() => {
    if (!epId) return;
    fetch(`/api/status/${epId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.labStatus === 'FAILED') setStatus('FAILED');
        else if (d.succeeded >= d.total) setStatus('DONE');
        else if (d.failed > 0 && d.succeeded + d.failed >= d.total) setStatus('FAILED');
        else if (d.succeeded > 0 || d.running > 0 || d.labStatus === 'RUNNING') setStatus('PENDING');
        else setStatus('NOT RUN');
      })
      .catch(() => setStatus('NOT RUN'));
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
