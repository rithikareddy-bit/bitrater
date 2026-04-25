import { ObjectId } from 'mongodb';
import clientPromise from '@/lib/mongodb';

const POLL_MS = 10_000;
const MAX_RETRIES = 2;
// Sync is a cheap HTTP write to showcache — allow more retries than the heavy
// lab/GCP steps so a transient blip doesn't force a full pipeline re-run.
const MAX_SYNC_RETRIES = 5;
// Trailer-specific cap: at most this many distinct trailers can have an
// active GCP codec at once. A new trailer starts only when another trailer
// has finished BOTH codecs (= left the GCP phase). This differs from max_gcp,
// which caps raw job count — trailer-level caps are the operator's contract.
const MAX_ACTIVE_TRAILERS = 5;
const TIMEOUT_LAB_MS = 2 * 60 * 60 * 1000;   // 2 hours
const TIMEOUT_GCP_MS = 1 * 60 * 60 * 1000;    // 1 hour
const TIMEOUT_STARTING_MS = 2 * 60 * 1000;    // 2 min
const RETRY_BACKOFF_BASE_MS = 30_000;          // 30s × retries

function nowDate() { return new Date(); }
function nowMs() { return Date.now(); }

function generateInstanceId() {
  return `pid${process.pid}-t${Date.now()}-r${Math.random().toString(36).slice(2, 8)}`;
}

function getBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

async function internalPost(path, body) {
  return fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function internalGet(path) {
  return fetch(`${getBaseUrl()}${path}`, {
    headers: { 'Cache-Control': 'no-cache' },
  });
}

function fireAndForget(promise) {
  if (promise && typeof promise.catch === 'function') promise.catch(() => {});
}

// Set a nested field on an object using dot-path notation (e.g. 'retries.lab_h264')
function setNestedPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// Find the timestamp of the LAST occurrence of a specific step+status in transition_log
function lastTransitionTime(ep, step, status) {
  const log = ep.transition_log || [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].step === step && String(log[i].status).startsWith(status)) {
      return new Date(log[i].at).getTime();
    }
  }
  return null;
}

export async function orchestrate(runIdStr) {
  const runId = new ObjectId(runIdStr);
  const instanceId = generateInstanceId();

  const client = await clientPromise();
  const db = client.db('chai_q_lab');
  const col = db.collection('pipeline_runs');

  // ── ACQUIRE LOCK ─────────────────────────────────────────────────────────────
  const lockResult = await col.updateOne(
    {
      _id: runId,
      $or: [
        { locked_by: null },
        { locked_at: { $lt: new Date(nowMs() - 5 * 60 * 1000) } },
      ],
    },
    { $set: { locked_by: instanceId, locked_at: nowDate() } },
  );

  if (lockResult.matchedCount === 0) {
    console.log(`[orchestrate] Could not acquire lock for ${runIdStr} — another instance running`);
    return;
  }

  let run = await col.findOne({ _id: runId });
  if (!run) {
    console.error(`[orchestrate] Run ${runIdStr} not found after acquiring lock`);
    return;
  }

  // ── FRESH START vs RESUME ─────────────────────────────────────────────────────
  const isFreshStart = run.started_at == null;
  if (isFreshStart) {
    await col.updateOne({ _id: runId }, { $set: { started_at: nowDate() } });
  }
  const isResuming = !isFreshStart;

  const MAX_LAB = run.lab_workers || 30;
  const MAX_GCP = run.max_gcp || 20;
  // Trailer runs skip the VTT/thumbnail sidecar step (no subtitles/thumbnails for trailers).
  const withVttDefault = run.kind !== 'trailer';

  // Build mutable episodes array + lookup map
  const episodes = run.episodes || [];
  const episodesMap = new Map(episodes.map(ep => [ep.episode_id, ep]));

  let h264Queue = [];
  let h265Queue = [];
  const h264Active = new Set(); // Set<episodeId>
  const h265Active = new Set();
  let gcpQueueH264 = run.gcp_queue_h264 ? [...run.gcp_queue_h264] : [];
  let gcpQueueH265 = run.gcp_queue_h265 ? [...run.gcp_queue_h265] : [];
  let gcpActiveCount = 0;

  // ── HELPER: persist GCP queues to DB ─────────────────────────────────────────
  async function persistQueues() {
    await col.updateOne(
      { _id: runId },
      { $set: { gcp_queue_h264: gcpQueueH264, gcp_queue_h265: gcpQueueH265 } },
    );
  }

  // ── HELPER: update episode in DB + in-memory ──────────────────────────────────
  async function updateEp(episodeId, fields, logEntry) {
    const ep = episodesMap.get(episodeId);
    if (ep) {
      for (const [k, v] of Object.entries(fields)) {
        setNestedPath(ep, k, v);
      }
    }
    const setFields = {};
    for (const [k, v] of Object.entries(fields)) {
      setFields[`episodes.$.${k}`] = v;
    }
    const update = { $set: setFields };
    if (logEntry) {
      update.$push = { 'episodes.$.transition_log': logEntry };
    }
    await col.updateOne({ _id: runId, 'episodes.episode_id': episodeId }, update);
  }

  // ── HELPER: is episode in terminal state ──────────────────────────────────────
  function isTerminal(ep) {
    return ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED' ||
           ep.status === 'SKIPPED' || ep.status === 'FAILED' || ep.status === 'CANCELLED';
  }

  // ── HELPER: start lab for one episode ────────────────────────────────────────
  async function startLabH264(ep) {
    if (!ep.s3_url || ep.s3_url.trim() === '') {
      console.warn(`[orchestrate] startLabH264 called with no s3_url for ${ep.episode_id} — skipping`);
      return;
    }
    const newStatus = (ep.status === 'QUEUED' || ep.status === 'SKIPPED') ? 'LAB_RUNNING' : ep.status;
    const fields = {
      lab_h264_status: 'STARTING',
      current_step: 'LAB_H264',
      status: newStatus,
      last_updated_at: nowDate(),
    };
    if (ep.started_at == null) fields.started_at = nowDate();
    await updateEp(ep.episode_id, fields, { step: 'LAB_H264', status: 'STARTING', at: nowDate() });
    h264Active.add(ep.episode_id);
    try {
      await internalPost('/api/push', { episodeId: ep.episode_id, s3Url: ep.s3_url, codec: 'h264' });
    } catch (err) {
      console.warn(`[orchestrate] /api/push h264 threw for ${ep.episode_id}:`, err.message);
    }
  }

  async function startLabH265(ep) {
    if (!ep.s3_url || ep.s3_url.trim() === '') {
      console.warn(`[orchestrate] startLabH265 called with no s3_url for ${ep.episode_id} — skipping`);
      return;
    }
    const newStatus = (ep.status === 'QUEUED' || ep.status === 'SKIPPED') ? 'LAB_RUNNING' : ep.status;
    const fields = {
      lab_h265_status: 'STARTING',
      current_step: 'LAB_H265',
      status: newStatus,
      last_updated_at: nowDate(),
    };
    if (ep.started_at == null) fields.started_at = nowDate();
    await updateEp(ep.episode_id, fields, { step: 'LAB_H265', status: 'STARTING', at: nowDate() });
    h265Active.add(ep.episode_id);
    try {
      await internalPost('/api/push', { episodeId: ep.episode_id, s3Url: ep.s3_url, codec: 'h265' });
    } catch (err) {
      console.warn(`[orchestrate] /api/push h265 threw for ${ep.episode_id}:`, err.message);
    }
  }

  // ── HELPER: fill available lab slots ─────────────────────────────────────────
  // Flat pool of MAX_LAB concurrent jobs across all episodes. H.264 has strict
  // priority: H.265 dispatches only once h264Queue is fully drained.
  async function fillLabSlots() {
    let seen264 = 0;
    while (h264Active.size + h265Active.size < MAX_LAB
           && h264Queue.length > 0 && seen264 < h264Queue.length) {
      const ep = h264Queue.shift();
      if (ep.retry_after_lab_h264 && nowMs() < new Date(ep.retry_after_lab_h264).getTime()) {
        h264Queue.push(ep);
        seen264++;
        continue;
      }
      await startLabH264(ep);
    }

    if (h264Queue.length > 0) return;

    let seen265 = 0;
    while (h264Active.size + h265Active.size < MAX_LAB
           && h265Queue.length > 0 && seen265 < h265Queue.length) {
      const ep = h265Queue.shift();
      if (ep.retry_after_lab_h265 && nowMs() < new Date(ep.retry_after_lab_h265).getTime()) {
        h265Queue.push(ep);
        seen265++;
        continue;
      }
      await startLabH265(ep);
    }
  }

  // ── FRESH START: check for early-exit if nothing to do ───────────────────────
  if (isFreshStart) {
    const eligible = episodes.filter(ep => ep.s3_url && ep.s3_url.trim() !== '' && ep.status === 'QUEUED');
    if (eligible.length === 0) {
      await col.updateOne(
        { _id: runId, locked_by: instanceId },
        { $set: { status: 'COMPLETED', finished_at: nowDate(), locked_by: null, locked_at: null } },
      );
      return;
    }

    // Enqueue GCP immediately for episodes whose lab is already done (pre-populated by start route)
    for (const ep of eligible) {
      if (ep.lab_h264_status === 'COMPLETE' && !ep.gcp_enqueued_h264) {
        gcpQueueH264.push({ episodeId: ep.episode_id, codec: 'h264', withVtt: withVttDefault });
        await updateEp(ep.episode_id, { gcp_enqueued_h264: true }, null);
      }
      if (ep.lab_h265_status === 'COMPLETE' && !ep.gcp_enqueued_h265) {
        gcpQueueH265.push({ episodeId: ep.episode_id, codec: 'h265' });
        await updateEp(ep.episode_id, { gcp_enqueued_h265: true }, null);
      }
    }
    await persistQueues();

    // Only run lab for episodes that still need it
    h264Queue = eligible.filter(ep => ep.lab_h264_status !== 'COMPLETE');
    h265Queue = eligible.filter(ep => ep.lab_h265_status !== 'COMPLETE');
    await fillLabSlots();
  }

  // ── RESUME LOGIC ─────────────────────────────────────────────────────────────
  if (isResuming) {
    for (const ep of episodes) {
      // Rebuild active sets
      if (ep.lab_h264_status === 'STARTING' || ep.lab_h264_status === 'RUNNING') h264Active.add(ep.episode_id);
      if (ep.lab_h265_status === 'STARTING' || ep.lab_h265_status === 'RUNNING') h265Active.add(ep.episode_id);
      if (ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING') gcpActiveCount++;
      if (ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING') gcpActiveCount++;

      // Skip terminal episodes on resume — SKIPPED trailers have lab_status
      // 'COMPLETE' stamped by makeBatchEpisodeDoc but no video_episodes row,
      // so re-enqueueing them would spin /api/gcp in a 400 retry loop.
      if (isTerminal(ep)) continue;

      // Re-enqueue GCP H.264 if lab complete but not in queue
      const inQ264 = gcpQueueH264.some(j => j.episodeId === ep.episode_id);
      if (ep.lab_h264_status === 'COMPLETE' &&
          (ep.gcp_h264_status == null || ep.gcp_h264_status === 'QUEUED') && !inQ264) {
        gcpQueueH264.push({ episodeId: ep.episode_id, codec: 'h264', withVtt: withVttDefault, retry_after: ep.retry_after_h264 || null });
        if (!ep.gcp_enqueued_h264) {
          await updateEp(ep.episode_id, { gcp_enqueued_h264: true }, null);
        }
      }

      // Re-enqueue GCP H.265 if lab complete but not in queue
      const inQ265 = gcpQueueH265.some(j => j.episodeId === ep.episode_id);
      if (ep.lab_h265_status === 'COMPLETE' &&
          (ep.gcp_h265_status == null || ep.gcp_h265_status === 'QUEUED') && !inQ265) {
        gcpQueueH265.push({ episodeId: ep.episode_id, codec: 'h265', retry_after: ep.retry_after_h265 || null });
        if (!ep.gcp_enqueued_h265) {
          await updateEp(ep.episode_id, { gcp_enqueued_h265: true }, null);
        }
      }

      // Handle mid-tick crash: GCP FAILED with retries left → reset to QUEUED
      if (ep.gcp_h264_status === 'FAILED' && (ep.retries?.gcp_h264 ?? 0) < MAX_RETRIES) {
        ep.gcp_h264_status = 'QUEUED';
        await col.updateOne({ _id: runId, 'episodes.episode_id': ep.episode_id },
          { $set: { 'episodes.$.gcp_h264_status': 'QUEUED' } });
        if (!gcpQueueH264.some(j => j.episodeId === ep.episode_id)) {
          gcpQueueH264.push({ episodeId: ep.episode_id, codec: 'h264', withVtt: withVttDefault, retry_after: ep.retry_after_h264 || null });
        }
      }
      if (ep.gcp_h265_status === 'FAILED' && (ep.retries?.gcp_h265 ?? 0) < MAX_RETRIES) {
        ep.gcp_h265_status = 'QUEUED';
        await col.updateOne({ _id: runId, 'episodes.episode_id': ep.episode_id },
          { $set: { 'episodes.$.gcp_h265_status': 'QUEUED' } });
        if (!gcpQueueH265.some(j => j.episodeId === ep.episode_id)) {
          gcpQueueH265.push({ episodeId: ep.episode_id, codec: 'h265', retry_after: ep.retry_after_h265 || null });
        }
      }

      // Rebuild lab queues — episodes waiting to run or interrupted mid-retry.
      // Guard: skip SKIPPED episodes (no s3_url) and terminal episodes.
      if (ep.status !== 'SKIPPED' && !isTerminal(ep) &&
          (ep.lab_h264_status === 'QUEUED' || ep.lab_h264_status === 'FAILED') &&
          (ep.retries?.lab_h264 ?? 0) < MAX_RETRIES && !h264Active.has(ep.episode_id)) {
        if (ep.lab_h264_status === 'FAILED') {
          ep.lab_h264_status = 'QUEUED';
          await col.updateOne({ _id: runId, 'episodes.episode_id': ep.episode_id },
            { $set: { 'episodes.$.lab_h264_status': 'QUEUED' } });
        }
        h264Queue.push(ep);
      }
      if (ep.status !== 'SKIPPED' && !isTerminal(ep) &&
          (ep.lab_h265_status === 'QUEUED' || ep.lab_h265_status === 'FAILED') &&
          (ep.retries?.lab_h265 ?? 0) < MAX_RETRIES && !h265Active.has(ep.episode_id)) {
        if (ep.lab_h265_status === 'FAILED') {
          ep.lab_h265_status = 'QUEUED';
          await col.updateOne({ _id: runId, 'episodes.episode_id': ep.episode_id },
            { $set: { 'episodes.$.lab_h265_status': 'QUEUED' } });
        }
        h265Queue.push(ep);
      }
    }

    await persistQueues();
  }

  // ── UNIFIED POLL LOOP ─────────────────────────────────────────────────────────
  while (episodes.some(ep => !isTerminal(ep))) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));

    // Renew lock — exit if cancelled or lock stolen
    const renewed = await col.updateOne(
      { _id: runId, locked_by: instanceId, status: { $ne: 'CANCELLED' } },
      { $set: { locked_at: nowDate() } },
    );
    if (renewed.matchedCount === 0) {
      console.log(`[orchestrate] Exiting — lock lost or run ${runIdStr} cancelled`);
      return;
    }

    // ── STEP 1: pollLabs ───────────────────────────────────────────────────────

    for (const episodeId of [...h264Active]) {
      const ep = episodesMap.get(episodeId);
      if (!ep) { h264Active.delete(episodeId); continue; }
      // If this episode was already terminated (e.g. by Step 7 last tick), stop tracking it
      if (isTerminal(ep)) { h264Active.delete(episodeId); continue; }

      // STARTING timeout — retry instead of immediate FAILED_FINAL
      if (ep.lab_h264_status === 'STARTING' &&
          nowMs() - new Date(ep.last_updated_at).getTime() > TIMEOUT_STARTING_MS) {
        h264Active.delete(episodeId);
        const retries = ep.retries?.lab_h264 ?? 0;
        if (retries < MAX_RETRIES) {
          const nr = retries + 1;
          const retryAfter = new Date(nowMs() + RETRY_BACKOFF_BASE_MS * nr);
          ep.retries = { ...(ep.retries || {}), lab_h264: nr };
          await updateEp(episodeId, {
            lab_h264_status: 'QUEUED',
            'retries.lab_h264': nr,
            retry_after_lab_h264: retryAfter,
            last_updated_at: nowDate(),
          }, { step: 'LAB_H264', status: 'RETRY (STARTING timeout)', at: nowDate() });
          h264Queue.push(ep);
        } else {
          await updateEp(episodeId,
            { lab_h264_status: 'FAILED_FINAL', error: 'Lab H.264 never confirmed RUNNING', last_updated_at: nowDate() },
            { step: 'LAB_H264', status: 'FAILED_FINAL (STARTING timeout)', at: nowDate() });
        }
        continue;
      }

      // General lab timeout
      const startT264 = lastTransitionTime(ep, 'LAB_H264', 'STARTING');
      if (startT264 && nowMs() - startT264 > TIMEOUT_LAB_MS) {
        await updateEp(episodeId,
          { lab_h264_status: 'FAILED_FINAL', error: 'Lab H.264 timed out', last_updated_at: nowDate() },
          { step: 'LAB_H264', status: 'FAILED_FINAL (lab timeout)', at: nowDate() });
        h264Active.delete(episodeId);
        continue;
      }

      let labStatus264 = null;
      try {
        const res = await internalGet(`/api/status/${episodeId}?codec=h264`);
        if (res.ok) { const d = await res.json(); labStatus264 = d.labStatus; }
      } catch { /* network error — skip */ }

      if (ep.lab_h264_status === 'STARTING' && (labStatus264 === 'RUNNING' || labStatus264 === 'PENDING')) {
        await updateEp(episodeId, { lab_h264_status: 'RUNNING', last_updated_at: nowDate() },
          { step: 'LAB_H264', status: 'RUNNING', at: nowDate() });
      }

      if (labStatus264 === 'COMPLETE') {
        await updateEp(episodeId, { lab_h264_status: 'COMPLETE', last_updated_at: nowDate() },
          { step: 'LAB_H264', status: 'COMPLETE', at: nowDate() });
        h264Active.delete(episodeId);
        if (!ep.gcp_enqueued_h264) {
          gcpQueueH264.push({ episodeId, codec: 'h264', withVtt: withVttDefault });
          await persistQueues();
          await updateEp(episodeId, { gcp_enqueued_h264: true }, null);
        }
      } else if (labStatus264 === 'FAILED') {
        h264Active.delete(episodeId);
        const retries = ep.retries?.lab_h264 ?? 0;
        if (retries < MAX_RETRIES) {
          const nr = retries + 1;
          const retryAfter = new Date(nowMs() + RETRY_BACKOFF_BASE_MS * nr);
          ep.retries = { ...(ep.retries || {}), lab_h264: nr };
          await updateEp(episodeId, {
            lab_h264_status: 'QUEUED',
            'retries.lab_h264': nr,
            retry_after_lab_h264: retryAfter,
            last_updated_at: nowDate(),
          }, { step: 'LAB_H264', status: 'RETRY', at: nowDate() });
          h264Queue.push(ep);
        } else {
          await updateEp(episodeId, { lab_h264_status: 'FAILED_FINAL', last_updated_at: nowDate() },
            { step: 'LAB_H264', status: 'FAILED_FINAL', at: nowDate() });
        }
      }
    }

    for (const episodeId of [...h265Active]) {
      const ep = episodesMap.get(episodeId);
      if (!ep) { h265Active.delete(episodeId); continue; }
      if (isTerminal(ep)) { h265Active.delete(episodeId); continue; }

      // STARTING timeout — retry instead of immediate FAILED_FINAL
      if (ep.lab_h265_status === 'STARTING' &&
          nowMs() - new Date(ep.last_updated_at).getTime() > TIMEOUT_STARTING_MS) {
        h265Active.delete(episodeId);
        const retries = ep.retries?.lab_h265 ?? 0;
        if (retries < MAX_RETRIES) {
          const nr = retries + 1;
          const retryAfter = new Date(nowMs() + RETRY_BACKOFF_BASE_MS * nr);
          ep.retries = { ...(ep.retries || {}), lab_h265: nr };
          await updateEp(episodeId, {
            lab_h265_status: 'QUEUED',
            'retries.lab_h265': nr,
            retry_after_lab_h265: retryAfter,
            last_updated_at: nowDate(),
          }, { step: 'LAB_H265', status: 'RETRY (STARTING timeout)', at: nowDate() });
          h265Queue.push(ep);
        } else {
          await updateEp(episodeId,
            { lab_h265_status: 'FAILED_FINAL', error: 'Lab H.265 never confirmed RUNNING', last_updated_at: nowDate() },
            { step: 'LAB_H265', status: 'FAILED_FINAL (STARTING timeout)', at: nowDate() });
        }
        continue;
      }

      const startT265 = lastTransitionTime(ep, 'LAB_H265', 'STARTING');
      if (startT265 && nowMs() - startT265 > TIMEOUT_LAB_MS) {
        await updateEp(episodeId,
          { lab_h265_status: 'FAILED_FINAL', error: 'Lab H.265 timed out', last_updated_at: nowDate() },
          { step: 'LAB_H265', status: 'FAILED_FINAL (lab timeout)', at: nowDate() });
        h265Active.delete(episodeId);
        continue;
      }

      let labStatus265 = null;
      try {
        const res = await internalGet(`/api/status/${episodeId}?codec=h265`);
        if (res.ok) { const d = await res.json(); labStatus265 = d.labStatus; }
      } catch { /* skip */ }

      if (ep.lab_h265_status === 'STARTING' && (labStatus265 === 'RUNNING' || labStatus265 === 'PENDING')) {
        await updateEp(episodeId, { lab_h265_status: 'RUNNING', last_updated_at: nowDate() },
          { step: 'LAB_H265', status: 'RUNNING', at: nowDate() });
      }

      if (labStatus265 === 'COMPLETE') {
        await updateEp(episodeId, { lab_h265_status: 'COMPLETE', last_updated_at: nowDate() },
          { step: 'LAB_H265', status: 'COMPLETE', at: nowDate() });
        h265Active.delete(episodeId);
        if (!ep.gcp_enqueued_h265) {
          gcpQueueH265.push({ episodeId, codec: 'h265' });
          await persistQueues();
          await updateEp(episodeId, { gcp_enqueued_h265: true }, null);
        }
      } else if (labStatus265 === 'FAILED') {
        h265Active.delete(episodeId);
        const retries = ep.retries?.lab_h265 ?? 0;
        if (retries < MAX_RETRIES) {
          const nr = retries + 1;
          const retryAfter = new Date(nowMs() + RETRY_BACKOFF_BASE_MS * nr);
          ep.retries = { ...(ep.retries || {}), lab_h265: nr };
          await updateEp(episodeId, {
            lab_h265_status: 'QUEUED',
            'retries.lab_h265': nr,
            retry_after_lab_h265: retryAfter,
            last_updated_at: nowDate(),
          }, { step: 'LAB_H265', status: 'RETRY', at: nowDate() });
          h265Queue.push(ep);
        } else {
          await updateEp(episodeId, { lab_h265_status: 'FAILED_FINAL', last_updated_at: nowDate() },
            { step: 'LAB_H265', status: 'FAILED_FINAL', at: nowDate() });
        }
      }
    }

    // ── STEP 2: refillLabSlots ─────────────────────────────────────────────────
    await fillLabSlots();

    // ── STEP 3: pollGCP ───────────────────────────────────────────────────────
    // Poll each episode that has at least one GCP job active
    const gcpPolled = new Set();
    for (const ep of episodes) {
      const h264Active_ = ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING';
      const h265Active_ = ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING';
      if (!h264Active_ && !h265Active_) continue;
      if (gcpPolled.has(ep.episode_id)) continue;
      gcpPolled.add(ep.episode_id);

      // Per-codec timeouts — retry STARTING, mark FAILED_FINAL for general timeout
      for (const codec of ['h264', 'h265']) {
        const sk = `gcp_${codec}_status`;
        if (ep[sk] !== 'STARTING' && ep[sk] !== 'RUNNING') continue;
        if (ep[sk] === 'STARTING' &&
            nowMs() - new Date(ep.last_updated_at).getTime() > TIMEOUT_STARTING_MS) {
          const rk = `gcp_${codec}`;
          const retries = ep.retries?.[rk] ?? 0;
          if (retries < MAX_RETRIES) {
            const nr = retries + 1;
            const retryAfter = new Date(nowMs() + RETRY_BACKOFF_BASE_MS * nr);
            ep.retries = { ...(ep.retries || {}), [rk]: nr };
            await updateEp(ep.episode_id, {
              [sk]: 'QUEUED',
              [`retries.${rk}`]: nr,
              [`retry_after_${codec}`]: retryAfter,
              last_updated_at: nowDate(),
            }, { step: `GCP_${codec.toUpperCase()}`, status: 'RETRY (STARTING timeout)', at: nowDate() });
            const entry = { episodeId: ep.episode_id, codec, retry_after: retryAfter };
            if (codec === 'h264') { entry.withVtt = withVttDefault; gcpQueueH264.push(entry); }
            else gcpQueueH265.push(entry);
            await persistQueues();
          } else {
            await updateEp(ep.episode_id, { [sk]: 'FAILED_FINAL', last_updated_at: nowDate() },
              { step: `GCP_${codec.toUpperCase()}`, status: 'FAILED_FINAL (STARTING timeout)', at: nowDate() });
          }
          continue;
        }
        const gcpStartT = lastTransitionTime(ep, `GCP_${codec.toUpperCase()}`, 'STARTING');
        if (gcpStartT && nowMs() - gcpStartT > TIMEOUT_GCP_MS) {
          await updateEp(ep.episode_id, { [sk]: 'FAILED_FINAL', last_updated_at: nowDate() },
            { step: `GCP_${codec.toUpperCase()}`, status: 'FAILED_FINAL (GCP timeout)', at: nowDate() });
        }
      }

      // Skip GCP-status fetch if both codecs just timed out (nothing left to poll)
      const stillActive264 = ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING';
      const stillActive265 = ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING';
      if (!stillActive264 && !stillActive265) continue;

      // Fetch GCP status once per episode
      let gcpData = null;
      try {
        const res = await internalGet(`/api/gcp-status/${ep.episode_id}`);
        if (res.ok) gcpData = await res.json();
      } catch { /* skip */ }
      if (!gcpData) continue;

      // Cache URLs on in-memory episode for combine step
      if (gcpData.h264_master_m3u8_url) ep.h264_master_m3u8_url = gcpData.h264_master_m3u8_url;
      if (gcpData.h265_master_m3u8_url) ep.h265_master_m3u8_url = gcpData.h265_master_m3u8_url;

      for (const codec of ['h264', 'h265']) {
        const sk = `gcp_${codec}_status`;
        if (ep[sk] !== 'STARTING' && ep[sk] !== 'RUNNING') continue;

        const codecData = gcpData[codec];
        const gcpJobStatus = codecData?.gcp_job_status;

        if (ep[sk] === 'STARTING' && (gcpJobStatus === 'RUNNING' || gcpJobStatus === 'PENDING')) {
          await updateEp(ep.episode_id, { [sk]: 'RUNNING', last_updated_at: nowDate() },
            { step: `GCP_${codec.toUpperCase()}`, status: 'RUNNING', at: nowDate() });
        }

        if (gcpJobStatus === 'SUCCEEDED') {
          await updateEp(ep.episode_id, { [sk]: 'SUCCEEDED', last_updated_at: nowDate() },
            { step: `GCP_${codec.toUpperCase()}`, status: 'SUCCEEDED', at: nowDate() });
        } else if (gcpJobStatus === 'FAILED') {
          const rk = `gcp_${codec}`;
          const retries = ep.retries?.[rk] ?? 0;
          if (retries < MAX_RETRIES) {
            const nr = retries + 1;
            const retryAfter = new Date(nowMs() + RETRY_BACKOFF_BASE_MS * nr);
            ep.retries = { ...(ep.retries || {}), [rk]: nr };
            await updateEp(ep.episode_id, {
              [sk]: 'QUEUED',
              [`retries.${rk}`]: nr,
              [`retry_after_${codec}`]: retryAfter,
              last_updated_at: nowDate(),
            }, { step: `GCP_${codec.toUpperCase()}`, status: 'RETRY', at: nowDate() });
            const entry = { episodeId: ep.episode_id, codec, retry_after: retryAfter };
            if (codec === 'h264') { entry.withVtt = withVttDefault; gcpQueueH264.push(entry); }
            else gcpQueueH265.push(entry);
            await persistQueues();
          } else {
            await updateEp(ep.episode_id, { [sk]: 'FAILED_FINAL', last_updated_at: nowDate() },
              { step: `GCP_${codec.toUpperCase()}`, status: 'FAILED_FINAL', at: nowDate() });
          }
        }
      }
    }

    // ── STEP 4: startGCP ──────────────────────────────────────────────────────
    // Recalibrate from in-memory state (which was just updated in Step 3)
    gcpActiveCount = episodes.reduce((sum, ep) => {
      let c = 0;
      if (ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING') c++;
      if (ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING') c++;
      return sum + c;
    }, 0);

    // Check circuit breaker
    const runSnap = await col.findOne({ _id: runId }, { projection: { gcp_paused_until: 1 } });
    const gcpPausedUntil = runSnap?.gcp_paused_until;

    // Trailer kind only: respect the operator toggle. When disabled, skip all
    // new GCP dispatches this tick — running jobs continue to completion,
    // QUEUED eps stay QUEUED and auto-resume when the toggle flips back on.
    let trailerDispatchAllowed = true;
    if (run.kind === 'trailer') {
      const settings = await db.collection('scanner_settings').findOne({ _id: 'trailer_scanner' });
      trailerDispatchAllowed = Boolean(settings?.enabled);
      if (!trailerDispatchAllowed) {
        console.log(`[orchestrate] ${runIdStr}: scanner disabled — skipping GCP dispatches (${gcpActiveCount} still running)`);
      }
    }

    if (trailerDispatchAllowed &&
        (!gcpPausedUntil || nowMs() >= new Date(gcpPausedUntil).getTime())) {
      let seenH264 = 0;
      let seenH265 = 0;

      // For trailer runs, enforce the "5 trailers in flight at a time" rule.
      //
      // Definitions:
      //   "active"      = at least one codec is STARTING or RUNNING right now
      //                   (consumes a GCP encoding slot).
      //   "progressing" = either active OR has a SUCCEEDED codec still waiting
      //                   for its sibling. A progressing trailer MUST be
      //                   allowed to dispatch its remaining codec — blocking
      //                   it leaves the trailer stuck forever.
      //
      // The trailer cap only defers STARTING a NEW trailer when 5 others are
      // already active. A QUEUED status (from a failed dispatch attempt)
      // without any SUCCEEDED codec is treated as "new" — it must respect
      // the cap on retry.
      const codecDone = (s) => s === 'STARTING' || s === 'RUNNING' || s === 'SUCCEEDED';
      const countActiveTrailers = () => {
        let n = 0;
        for (const ep of episodes) {
          if (ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING' ||
              ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING') {
            n++;
          }
        }
        return n;
      };
      const trailerCap = run.kind === 'trailer' ? MAX_ACTIVE_TRAILERS : Infinity;
      const isTrailerProgressing = (ep) => {
        if (!ep) return false;
        return codecDone(ep.gcp_h264_status) || codecDone(ep.gcp_h265_status);
      };

      while (gcpActiveCount < MAX_GCP &&
             (gcpQueueH264.length > seenH264 || gcpQueueH265.length > seenH265)) {

        // H.264 slot
        if (gcpQueueH264.length > seenH264 && gcpActiveCount < MAX_GCP) {
          const job = gcpQueueH264.shift();
          if (job.retry_after && nowMs() < new Date(job.retry_after).getTime()) {
            gcpQueueH264.push(job);
            await persistQueues();
            seenH264++;
          } else {
            const ep = episodesMap.get(job.episodeId);
            if (!ep || ep.gcp_h264_status === 'STARTING' || ep.gcp_h264_status === 'RUNNING' || ep.gcp_h264_status === 'SUCCEEDED') {
              // Discard — already handled
            } else if (!isTrailerProgressing(ep) && countActiveTrailers() >= trailerCap) {
              // Starting a NEW trailer would breach the 5-trailer cap.
              // "Progressing" trailers (active codec OR one codec already
              // SUCCEEDED) always bypass — blocking them would strand a
              // half-done trailer.
              gcpQueueH264.push(job);
              await persistQueues();
              seenH264++;
            } else {
              await persistQueues(); // persist queue shift BEFORE marking STARTING
              await updateEp(job.episodeId, { gcp_h264_status: 'STARTING', last_updated_at: nowDate() }, null);
              let gcpRes;
              try {
                gcpRes = await internalPost('/api/gcp', { episodeId: job.episodeId, codec: 'h264' });
              } catch (err) {
                console.warn(`[orchestrate] /api/gcp h264 threw for ${job.episodeId}:`, err?.message);
                gcpRes = { status: 500 };
              }
              if (gcpRes.status === 409) {
                await updateEp(job.episodeId, { gcp_h264_status: 'RUNNING', status: 'GCP_RUNNING', current_step: 'GCP_H264', last_updated_at: nowDate() },
                  { step: 'GCP_H264', status: 'RUNNING (via 409)', at: nowDate() });
                gcpActiveCount++;
              } else if (gcpRes.status >= 400) {
                await updateEp(job.episodeId, { gcp_h264_status: 'QUEUED', last_updated_at: nowDate() }, null);
                gcpQueueH264.push(job);
                await persistQueues();
                seenH264++;
                console.warn(`[orchestrate] POST /api/gcp (h264) failed (${gcpRes.status}) for ${job.episodeId}`);
              } else {
                if (job.withVtt) {
                  fireAndForget(internalPost('/api/episode-vtt', { episodeId: job.episodeId }));
                }
                await updateEp(job.episodeId, {
                  gcp_h264_status: 'STARTING',
                  current_step: 'GCP_H264',
                  status: 'GCP_RUNNING',
                  last_updated_at: nowDate(),
                }, { step: 'GCP_H264', status: 'STARTING', at: nowDate() });
                gcpActiveCount++;
              }
            }
          }
        }

        // H.265 slot
        if (gcpQueueH265.length > seenH265 && gcpActiveCount < MAX_GCP) {
          const job = gcpQueueH265.shift();
          if (job.retry_after && nowMs() < new Date(job.retry_after).getTime()) {
            gcpQueueH265.push(job);
            await persistQueues();
            seenH265++;
          } else {
            const ep = episodesMap.get(job.episodeId);
            if (!ep || ep.gcp_h265_status === 'STARTING' || ep.gcp_h265_status === 'RUNNING' || ep.gcp_h265_status === 'SUCCEEDED') {
              // Discard
            } else if (!isTrailerProgressing(ep) && countActiveTrailers() >= trailerCap) {
              // Starting a NEW trailer would breach the 5-trailer cap.
              // "Progressing" trailers (active codec OR one codec already
              // SUCCEEDED) always bypass — blocking them would strand a
              // half-done trailer.
              gcpQueueH265.push(job);
              await persistQueues();
              seenH265++;
            } else {
              await persistQueues();
              await updateEp(job.episodeId, { gcp_h265_status: 'STARTING', last_updated_at: nowDate() }, null);
              let gcpRes;
              try {
                gcpRes = await internalPost('/api/gcp', { episodeId: job.episodeId, codec: 'h265' });
              } catch (err) {
                console.warn(`[orchestrate] /api/gcp h265 threw for ${job.episodeId}:`, err?.message);
                gcpRes = { status: 500 };
              }
              if (gcpRes.status === 409) {
                await updateEp(job.episodeId, { gcp_h265_status: 'RUNNING', status: 'GCP_RUNNING', current_step: 'GCP_H265', last_updated_at: nowDate() },
                  { step: 'GCP_H265', status: 'RUNNING (via 409)', at: nowDate() });
                gcpActiveCount++;
              } else if (gcpRes.status >= 400) {
                await updateEp(job.episodeId, { gcp_h265_status: 'QUEUED', last_updated_at: nowDate() }, null);
                gcpQueueH265.push(job);
                await persistQueues();
                seenH265++;
                console.warn(`[orchestrate] POST /api/gcp (h265) failed (${gcpRes.status}) for ${job.episodeId}`);
              } else {
                await updateEp(job.episodeId, {
                  gcp_h265_status: 'STARTING',
                  current_step: 'GCP_H265',
                  status: 'GCP_RUNNING',
                  last_updated_at: nowDate(),
                }, { step: 'GCP_H265', status: 'STARTING', at: nowDate() });
                gcpActiveCount++;
              }
            }
          }
        }
      }
    }

    // ── STEP 5: runCombine ────────────────────────────────────────────────────
    for (const ep of episodes) {
      if (ep.combined || isTerminal(ep)) continue;

      const h264Done = ep.gcp_h264_status === 'SUCCEEDED' || ep.gcp_h264_status === 'FAILED_FINAL';
      const h265Done = ep.gcp_h265_status === 'SUCCEEDED' || ep.gcp_h265_status === 'FAILED_FINAL';
      if (!h264Done || !h265Done) continue;

      if (ep.gcp_h264_status === 'FAILED_FINAL' || ep.gcp_h265_status === 'FAILED_FINAL') {
        const failedCodec = ep.gcp_h264_status === 'FAILED_FINAL' ? 'H.264' : 'H.265';
        const finAt = nowDate();
        await updateEp(ep.episode_id, {
          status: 'FAILED',
          error: `${failedCodec} GCP failed`,
          finished_at: finAt,
          duration_ms: ep.started_at ? finAt.getTime() - new Date(ep.started_at).getTime() : null,
          last_updated_at: finAt,
        }, null);
        continue;
      }

      // Both SUCCEEDED — ensure URLs are available
      let h264Url = ep.h264_master_m3u8_url;
      let h265Url = ep.h265_master_m3u8_url;
      if (!h264Url || !h265Url) {
        try {
          const res = await internalGet(`/api/gcp-status/${ep.episode_id}`);
          if (res.ok) {
            const d = await res.json();
            h264Url = d.h264_master_m3u8_url || h264Url;
            h265Url = d.h265_master_m3u8_url || h265Url;
            if (h264Url) ep.h264_master_m3u8_url = h264Url;
            if (h265Url) ep.h265_master_m3u8_url = h265Url;
          }
        } catch { /* skip */ }
      }
      if (!h264Url || !h265Url) continue; // wait for eventual consistency

      const combineRes = await internalPost('/api/create-combined-master', { episodeId: ep.episode_id });
      if (combineRes.status !== 200) {
        const cr = (ep.retries?.combine ?? 0) + 1;
        ep.retries = { ...(ep.retries || {}), combine: cr };
        if (cr > MAX_RETRIES) {
          const finAt = nowDate();
          await updateEp(ep.episode_id, {
            status: 'FAILED',
            error: 'create-combined-master failed after max retries',
            finished_at: finAt,
            duration_ms: ep.started_at ? finAt.getTime() - new Date(ep.started_at).getTime() : null,
            last_updated_at: finAt,
          }, null);
        } else {
          await updateEp(ep.episode_id, { 'retries.combine': cr }, null);
          console.warn(`[orchestrate] create-combined-master failed for ${ep.episode_id} (attempt ${cr})`);
        }
        continue;
      }

      // Atomic: combined=true + status=COMBINING in one write
      const combineAt = nowDate();
      await updateEp(ep.episode_id, {
        combined: true,
        status: 'COMBINING',
        current_step: 'QC',
        last_updated_at: combineAt,
      }, { step: 'COMBINE', status: 'DONE', at: combineAt });

      const qcRes = await internalPost(`/api/quality-check/${ep.episode_id}`, {});
      if (qcRes.status !== 200) {
        const qr = ep.retries?.qc ?? 0;
        if (qr < MAX_RETRIES) {
          ep.retries = { ...(ep.retries || {}), qc: qr + 1 };
          await updateEp(ep.episode_id, { 'retries.qc': ep.retries.qc },
            { step: 'QC', status: 'POST_FAILED (retry)', at: nowDate() });
        } else {
          const finAt = nowDate();
          const nextStatus = run.kind === 'trailer' ? 'SYNC_PENDING' : 'READY_TO_SYNC';
          await updateEp(ep.episode_id, {
            status: nextStatus,
            current_step: nextStatus === 'SYNC_PENDING' ? 'SYNC' : 'DONE',
            finished_at: finAt,
            duration_ms: ep.started_at ? finAt.getTime() - new Date(ep.started_at).getTime() : null,
            last_updated_at: finAt,
          }, { step: 'QC', status: 'SKIPPED (POST failed, max retries)', at: finAt });
        }
      }
    }

    // ── STEP 6: pollQC ────────────────────────────────────────────────────────
    for (const ep of episodes) {
      if (ep.status !== 'COMBINING') continue;

      let qcResult = null;
      try {
        const res = await internalGet(`/api/quality-check/${ep.episode_id}`);
        if (res.ok) qcResult = await res.json();
      } catch { /* skip */ }

      const overall = qcResult?.overall ?? null;

      // Crash recovery: re-trigger if combined=true but no QC result yet
      if (overall === null && ep.combined === true) {
        const qcRes = await internalPost(`/api/quality-check/${ep.episode_id}`, {});
        if (qcRes.status !== 200) {
          const qr = ep.retries?.qc ?? 0;
          if (qr < MAX_RETRIES) {
            ep.retries = { ...(ep.retries || {}), qc: qr + 1 };
            await updateEp(ep.episode_id, { 'retries.qc': ep.retries.qc },
              { step: 'QC', status: 'POST_FAILED (retry)', at: nowDate() });
          } else {
            const finAt = nowDate();
            await updateEp(ep.episode_id, {
              status: 'READY_TO_SYNC',
              current_step: 'DONE',
              finished_at: finAt,
              duration_ms: ep.started_at ? finAt.getTime() - new Date(ep.started_at).getTime() : null,
              last_updated_at: finAt,
            }, { step: 'QC', status: 'SKIPPED (POST failed, max retries)', at: finAt });
          }
        }
        continue;
      }

      if (overall === 'PASS' || overall === 'ISSUES_FOUND') {
        const finAt = nowDate();
        // Trailer runs wait in the non-terminal SYNC_PENDING state until Step 6.5
        // completes the auto-sync. Episode runs keep the historical READY_TO_SYNC
        // terminal state so the manual Sync Show button remains authoritative.
        const nextStatus = run.kind === 'trailer' ? 'SYNC_PENDING' : 'READY_TO_SYNC';
        await updateEp(ep.episode_id, {
          status: nextStatus,
          current_step: nextStatus === 'SYNC_PENDING' ? 'SYNC' : 'DONE',
          finished_at: finAt,
          duration_ms: ep.started_at ? finAt.getTime() - new Date(ep.started_at).getTime() : null,
          last_updated_at: finAt,
        }, { step: 'QC', status: overall, at: finAt });
      } else if (overall === 'FAILED') {
        const qr = ep.retries?.qc ?? 0;
        if (qr < MAX_RETRIES) {
          ep.retries = { ...(ep.retries || {}), qc: qr + 1 };
          await updateEp(ep.episode_id, { 'retries.qc': ep.retries.qc },
            { step: 'QC', status: 'RETRY', at: nowDate() });
          try {
            await internalPost(`/api/quality-check/${ep.episode_id}`, {});
          } catch { /* retry POST fire-and-forget */ }
        } else {
          const finAt = nowDate();
          const nextStatus = run.kind === 'trailer' ? 'SYNC_PENDING' : 'READY_TO_SYNC';
          await updateEp(ep.episode_id, {
            status: nextStatus,
            current_step: nextStatus === 'SYNC_PENDING' ? 'SYNC' : 'DONE',
            finished_at: finAt,
            duration_ms: ep.started_at ? finAt.getTime() - new Date(ep.started_at).getTime() : null,
            last_updated_at: finAt,
          }, null);
        }
      } else if (overall !== null && overall !== 'RUNNING') {
        console.warn(`[orchestrate] Unexpected QC status '${overall}' for ${ep.episode_id}`);
      }
    }

    // ── STEP 6.5: auto-sync trailers ──────────────────────────────────────────
    // Trailer runs park in SYNC_PENDING until this step writes gcpUrl back to
    // showcache. On success → SYNCED (terminal). On failure → increment
    // retries.sync and stay in SYNC_PENDING (non-terminal) so the next tick
    // retries. When retries exhaust we fall back to READY_TO_SYNC (terminal)
    // as a safety net the manual Sync Show button can still resolve.
    if (run.kind === 'trailer') {
      for (const ep of episodes) {
        if (ep.status !== 'SYNC_PENDING') continue;
        const sr = ep.retries?.sync ?? 0;

        let combinedUrl = ep.combined_master_m3u8_url || null;
        if (!combinedUrl) {
          try {
            const veDoc = await db.collection('video_episodes').findOne(
              { episode_id: ep.episode_id },
              { projection: { combined_master_m3u8_url: 1 } },
            );
            combinedUrl = veDoc?.combined_master_m3u8_url || null;
            if (combinedUrl) ep.combined_master_m3u8_url = combinedUrl;
          } catch { /* retry next tick */ }
        }
        if (!combinedUrl) continue; // next tick

        let syncRes;
        try {
          syncRes = await internalPost('/api/sync-showcache-trailer', {
            episodeId: ep.episode_id,
          });
        } catch (err) {
          syncRes = { status: 500, _err: err?.message };
        }

        if (syncRes.status === 200) {
          const syncedAt = nowDate();
          await updateEp(ep.episode_id, {
            status: 'SYNCED',
            current_step: 'DONE',
            synced_at: syncedAt,
            last_updated_at: syncedAt,
          }, { step: 'SYNC', status: 'DONE', at: syncedAt });
        } else if (sr < MAX_SYNC_RETRIES) {
          ep.retries = { ...(ep.retries || {}), sync: sr + 1 };
          await updateEp(ep.episode_id, { 'retries.sync': ep.retries.sync },
            { step: 'SYNC', status: `RETRY (${syncRes.status}) ${sr + 1}/${MAX_SYNC_RETRIES}`, at: nowDate() });
        } else {
          await updateEp(ep.episode_id, {
            status: 'READY_TO_SYNC',
            current_step: 'DONE',
            last_updated_at: nowDate(),
          }, { step: 'SYNC', status: `FAILED_FINAL (${syncRes.status})`, at: nowDate() });
        }
      }
    }

    // ── STEP 7: checkEpisodeFailures ──────────────────────────────────────────
    for (const ep of episodes) {
      if (ep.status !== 'LAB_RUNNING' && ep.status !== 'GCP_RUNNING') continue;
      const finAt = nowDate();
      const durMs = ep.started_at ? finAt.getTime() - new Date(ep.started_at).getTime() : null;

      if (ep.lab_h264_status === 'FAILED_FINAL' || ep.lab_h265_status === 'FAILED_FINAL') {
        const failedCodec = ep.lab_h264_status === 'FAILED_FINAL' ? 'H.264' : 'H.265';
        await updateEp(ep.episode_id, {
          status: 'FAILED',
          error: ep.error || `${failedCodec} lab failed`,
          finished_at: finAt,
          duration_ms: durMs,
          last_updated_at: finAt,
        }, null);
      } else if (ep.gcp_h264_status === 'FAILED_FINAL' || ep.gcp_h265_status === 'FAILED_FINAL') {
        const failedCodec = ep.gcp_h264_status === 'FAILED_FINAL' ? 'H.264' : 'H.265';
        await updateEp(ep.episode_id, {
          status: 'FAILED',
          error: `${failedCodec} GCP failed`,
          finished_at: finAt,
          duration_ms: durMs,
          last_updated_at: finAt,
        }, null);
      }
    }

    // ── STEP 8: updateProgressCounters ────────────────────────────────────────
    const completedCount = episodes.filter(ep => ep.status === 'READY_TO_SYNC' || ep.status === 'SYNCED').length;
    const failedCount   = episodes.filter(ep => ep.status === 'FAILED').length;
    const runningCount  = episodes.filter(ep => ep.status === 'LAB_RUNNING' || ep.status === 'GCP_RUNNING' || ep.status === 'COMBINING' || ep.status === 'SYNC_PENDING').length;
    const skippedCount  = episodes.filter(ep => ep.status === 'SKIPPED').length;

    // Circuit breaker: >50% GCP failures in last 10 min → pause 5 min
    const tenMinAgo = nowMs() - 10 * 60 * 1000;
    const recentGcp = [];
    for (const ep of episodes) {
      for (const codec of ['h264', 'h265']) {
        const sk = `gcp_${codec}_status`;
        if (ep[sk] === 'SUCCEEDED' || ep[sk] === 'FAILED_FINAL' || ep[sk] === 'FAILED') {
          const finT =
            lastTransitionTime(ep, `GCP_${codec.toUpperCase()}`, 'SUCCEEDED') ||
            lastTransitionTime(ep, `GCP_${codec.toUpperCase()}`, 'FAILED_FINAL') ||
            lastTransitionTime(ep, `GCP_${codec.toUpperCase()}`, 'FAILED');
          if (finT && finT > tenMinAgo) recentGcp.push(ep[sk]);
        }
      }
    }
    let breakerUpdate = {};
    if (recentGcp.length >= 5) {
      const failRate = recentGcp.filter(s => s === 'FAILED' || s === 'FAILED_FINAL').length / recentGcp.length;
      if (failRate > 0.5) {
        const pauseUntil = new Date(nowMs() + 5 * 60 * 1000);
        breakerUpdate = { gcp_paused_until: pauseUntil };
        console.warn(`[orchestrate] Circuit breaker triggered — pausing GCP starts until ${pauseUntil.toISOString()}`);
      }
    }

    // Stuck detection (log only)
    for (const ep of episodes) {
      if (!isTerminal(ep) && ep.last_updated_at &&
          nowMs() - new Date(ep.last_updated_at).getTime() > 10 * 60 * 1000) {
        console.warn(`[orchestrate] Episode ${ep.episode_id} stuck at ${ep.current_step} for 10+ min`);
      }
    }

    // ETA
    const finEps = episodes.filter(ep => ep.finished_at && ep.duration_ms);
    let etaMs = null;
    if (finEps.length > 0 && runningCount > 0) {
      const avg = finEps.reduce((s, ep) => s + ep.duration_ms, 0) / finEps.length;
      etaMs = Math.round(avg * runningCount);
    }

    await col.updateOne({ _id: runId }, {
      $set: {
        completed_count: completedCount,
        failed_count: failedCount,
        running_count: runningCount,
        skipped_count: skippedCount,
        eta_ms: etaMs,
        ...breakerUpdate,
      },
    });
  }

  // ── DONE ──────────────────────────────────────────────────────────────────────
  await col.updateOne(
    { _id: runId, locked_by: instanceId },
    { $set: { status: 'COMPLETED', finished_at: nowDate(), locked_by: null, locked_at: null } },
  );
  console.log(`[orchestrate] Pipeline ${runIdStr} completed`);
}
