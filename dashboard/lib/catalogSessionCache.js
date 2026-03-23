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

function deriveStatusFromPayload(d) {
  if (d.labStatus === 'FAILED') return 'FAILED';
  if (d.succeeded >= d.total) return 'DONE';
  if (d.failed > 0 && d.succeeded + d.failed >= d.total) return 'FAILED';
  if (d.succeeded > 0 || d.running > 0 || d.labStatus === 'RUNNING') return 'PENDING';
  return 'NOT RUN';
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