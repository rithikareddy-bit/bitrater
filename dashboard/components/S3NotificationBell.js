'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const FIELD_LABELS = {
  s3_url: 'Episode S3 URL',
  trailer_s3_url: 'Trailer S3 URL',
  motion_poster_s3_url: 'Motion Poster S3 URL',
};

function fieldLabel(field) {
  return FIELD_LABELS[field] || field;
}

function truncateUrl(url, maxLen = 60) {
  if (!url) return '(none)';
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 3) + '...';
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function groupByDate(changes) {
  const groups = {};
  for (const c of changes) {
    const key = c.changed_at
      ? new Date(c.changed_at).toISOString().split('T')[0]
      : 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
}

/**
 * S3NotificationBell — bell icon with dropdown showing S3 URL changes.
 *
 * Props:
 *   fetchUrl  — API endpoint to fetch notifications from
 *   label     — optional label next to bell (e.g. "Show" or "Episode")
 *   style     — optional style overrides for the wrapper
 */
export default function S3NotificationBell({ fetchUrl, label, style }) {
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const ref = useRef(null);

  const load = useCallback(async () => {
    if (!fetchUrl) return;
    setLoading(true);
    try {
      const res = await fetch(fetchUrl);
      const data = await res.json();
      setChanges(data.changes || []);
      setTotal(data.total || 0);
    } catch {
      setChanges([]);
    } finally {
      setLoading(false);
    }
  }, [fetchUrl]);

  // Load when opened or when fetchUrl changes
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Also fetch on mount to get the count
  useEffect(() => {
    load();
  }, [load]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const dated = groupByDate(changes);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block', ...style }}>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        title={`S3 URL changes${label ? ` — ${label}` : ''}`}
        style={{
          background: open ? '#1a2a3a' : 'transparent',
          border: '1px solid #333',
          borderRadius: 6,
          padding: '5px 10px',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: total > 0 ? '#f59e0b' : '#666',
          fontSize: 14,
          position: 'relative',
        }}
      >
        {/* Bell SVG */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {total > 0 && (
          <span style={{
            position: 'absolute',
            top: -4,
            right: -4,
            background: '#ef4444',
            color: '#fff',
            fontSize: 9,
            fontWeight: 700,
            borderRadius: '50%',
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {total > 99 ? '99+' : total}
          </span>
        )}
        {label && <span style={{ fontSize: 11, color: '#888' }}>{label}</span>}
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 6,
          width: 480,
          maxHeight: 500,
          overflowY: 'auto',
          background: '#161616',
          border: '1px solid #2a2a2a',
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
          zIndex: 1000,
        }}>
          {/* Header */}
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid #2a2a2a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
              S3 URL Changes
            </span>
            <span style={{ fontSize: 11, color: '#555' }}>
              {total} change{total !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Body */}
          {loading && (
            <div style={{ padding: 20, textAlign: 'center', color: '#888', fontSize: 12 }}>
              Loading...
            </div>
          )}

          {!loading && changes.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: '#555', fontSize: 12 }}>
              No S3 URL changes recorded yet.
            </div>
          )}

          {!loading && dated.map(([dateKey, items]) => (
            <div key={dateKey}>
              {/* Date header */}
              <div style={{
                padding: '8px 16px',
                background: '#111',
                fontSize: 11,
                fontWeight: 600,
                color: '#64748b',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                borderBottom: '1px solid #1e1e1e',
              }}>
                {formatDate(items[0]?.changed_at)}
              </div>

              {items.map((item) => (
                <div
                  key={item._id}
                  style={{
                    padding: '10px 16px',
                    borderBottom: '1px solid #1e1e1e',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {/* Top line: show/episode info + time */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div>
                      <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                        {item.show_title || item.show_id || '—'}
                      </span>
                      {item.episode_id && (
                        <span style={{ color: '#94a3b8', marginLeft: 6 }}>
                          Ep {item.episode_number != null ? `#${item.episode_number}` : ''}{' '}
                          {item.episode_title ? `— ${item.episode_title}` : ''}
                        </span>
                      )}
                    </div>
                    <span style={{ color: '#555', fontSize: 10, whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {formatTime(item.changed_at)}
                    </span>
                  </div>

                  {/* Field label */}
                  <div style={{ marginTop: 4 }}>
                    <span style={{
                      display: 'inline-block',
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: '#1a2a1a',
                      border: '1px solid #2a4a2a',
                      color: '#4ade80',
                    }}>
                      {fieldLabel(item.field)}
                    </span>
                    {item.changed_by && item.changed_by !== 'Unknown' && (
                      <span style={{ color: '#64748b', fontSize: 10, marginLeft: 8 }}>
                        by {item.changed_by}
                      </span>
                    )}
                  </div>

                  {/* Old -> New URLs */}
                  <div style={{ marginTop: 6, fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#94a3b8' }}>
                    <div>
                      <span style={{ color: '#ef4444' }}>-</span>{' '}
                      <span style={{ color: '#666' }}>{truncateUrl(item.old_url)}</span>
                    </div>
                    <div>
                      <span style={{ color: '#22c55e' }}>+</span>{' '}
                      <span style={{ color: '#94a3b8' }}>{truncateUrl(item.new_url)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
