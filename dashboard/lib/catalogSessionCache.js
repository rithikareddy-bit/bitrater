/**
 * In-memory only — cleared on full page reload (no sessionStorage).
 * Caches expanded show payloads and /api/status results for the catalog page.
 */

const showById = new Map();
const statusByEpId = new Map();
const statusInflight = new Map();

export function getCachedShow(id) {
  if (id == null) return null;
  return showById.get(String(id)) ?? null;
}

export function setCachedShow(id, show) {
  if (id == null || !show || show.error) return;
  showById.set(String(id), { ...show });
}

export function getCachedEpisodeStatus(epId) {
  if (epId == null) return undefined;
  const key = String(epId);
  if (!statusByEpId.has(key)) return undefined;
  return statusByEpId.get(key);
}

function deriveCodecStatus(c) {
  if (!c) return 'NOT RUN';
  if (c.labStatus === 'FAILED') return 'FAILED';
  if (c.total > 0 && c.succeeded >= c.total) return 'DONE';
  if (c.failed > 0 && c.succeeded + c.failed >= c.total) return 'FAILED';
  if (c.succeeded > 0 || c.running > 0 || c.labStatus === 'RUNNING') return 'PENDING';
  return 'NOT RUN';
}

function deriveStatusFromPayload(d) {
  if (!d || typeof d !== 'object') return 'NOT RUN';
  // /api/status/[id] (no ?codec=) returns { h264, h265 }.
  if (d.h264 || d.h265) {
    const statuses = [d.h264, d.h265].filter(Boolean).map(deriveCodecStatus);
    if (statuses.includes('FAILED')) return 'FAILED';
    if (statuses.length > 0 && statuses.every((s) => s === 'DONE')) return 'DONE';
    if (statuses.includes('PENDING') || statuses.includes('DONE')) return 'PENDING';
    return 'NOT RUN';
  }
  // Legacy flat shape (single-codec response).
  return deriveCodecStatus(d);
}

export function fetchEpisodeStatus(epId) {
  if (epId == null) return Promise.resolve('NOT RUN');
  const key = String(epId);
  if (statusByEpId.has(key)) return Promise.resolve(statusByEpId.get(key));

  const existing = statusInflight.get(key);
  if (existing) return existing;

  const p = fetch(`/api/status/${encodeURIComponent(key)}`)
    .then((r) => r.json())
    .then((d) => {
      const s = deriveStatusFromPayload(d);
      statusByEpId.set(key, s);
      return s;
    })
    .catch(() => {
      statusByEpId.set(key, 'NOT RUN');
      return 'NOT RUN';
    })
    .finally(() => {
      statusInflight.delete(key);
    });

  statusInflight.set(key, p);
  return p;
}