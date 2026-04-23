import clientPromise from '@/lib/mongodb';
import {
  isCombinedUrl,
  hasS3UrlDrifted,
  readCombinedMasterUrl,
  prepareTrailer,
} from '@/lib/trailerPrep';
import { orchestrate } from '@/lib/pipelineOrchestrator';

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_TTL_MS = 10 * 60 * 1000;   // Must exceed longest realistic scan
const SCANNER_LOCK_ID = 'trailer_scanner';
const SETTINGS_ID = 'trailer_scanner';
const BATCH_MAX = 20;                 // Max trailers collected per batch tick
const BATCH_SHOW_ID = '__batch__';    // Sentinel marking scanner-owned runs
// A RUNNING trailer run with no episode activity for this long is considered
// orphaned (orchestrator crashed, lock expired, etc.) — the scanner will flip
// it to CANCELLED so it stops blocking new batches.
const STALE_RUN_MS = 30 * 60 * 1000;

let localScanRunning = false;
let scannerTimer = null;

function getBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

function instanceId() {
  return `pid${process.pid}-t${Date.now()}-r${Math.random().toString(36).slice(2, 8)}`;
}

function batchMax() {
  const raw = parseInt(process.env.TRAILER_BATCH_MAX || String(BATCH_MAX), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : BATCH_MAX;
}

function probeConcurrency() {
  // Cap parallel ffprobes during batch prep. Cross-region S3 fetches (dashboard
  // in us-east-1, sources in ap-south-2) saturate bandwidth when ~20 probes
  // run at once, triggering the ffprobe timeout and dumping the whole batch.
  const raw = parseInt(process.env.TRAILER_PROBE_CONCURRENCY || '5', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

async function probeBatchWithLimit(candidates, probeErrors) {
  let idx = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= candidates.length) return;
      const c = candidates[i];
      try {
        await prepareTrailer({ episodeId: c.episodeId, s3Url: c.s3Url });
      } catch (err) {
        probeErrors.set(c.episodeId, err?.message || 'probe failed');
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(probeConcurrency(), candidates.length) },
    () => worker(),
  );
  await Promise.all(workers);
}

function trailerSyntheticId(showIdHex, key) {
  return `trailer_${showIdHex}_${key}`;
}

async function acquireDistributedLock(labDb, lockId) {
  const now = new Date();
  const expires = new Date(now.getTime() + LOCK_TTL_MS);
  const owner = instanceId();
  // Compare-and-swap: claim only if no owner OR prior lease expired.
  // MongoDB node driver v6 returns the document directly (not { value }); we
  // accept both shapes to stay forward/backward compatible.
  try {
    const result = await labDb.collection('scanner_locks').findOneAndUpdate(
      {
        _id: lockId,
        $or: [
          { locked_by: null },
          { expires_at: { $lte: now } },
          { expires_at: { $exists: false } },
        ],
      },
      {
        $set: { locked_by: owner, locked_at: now, expires_at: expires },
        $setOnInsert: { _id: lockId },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const doc = result?.value ?? result;
    if (doc?.locked_by === owner) return owner;
  } catch (err) {
    // Duplicate key on upsert race — fall through to re-read.
    if (err?.code !== 11000) console.warn('[trailerScanner] lock acquire error:', err?.message);
  }
  const fresh = await labDb.collection('scanner_locks').findOne({ _id: lockId });
  return fresh?.locked_by === owner ? owner : null;
}

async function releaseDistributedLock(labDb, lockId, owner) {
  try {
    await labDb.collection('scanner_locks').updateOne(
      { _id: lockId, locked_by: owner },
      { $set: { locked_by: null, locked_at: null, expires_at: null } },
    );
  } catch (err) {
    console.warn('[trailerScanner] release lock failed:', err?.message);
  }
}

async function updatePipelineRunsToSynced(labDb, _showId, episodeId) {
  // We don't filter by show_id because batch runs carry show_id='__batch__';
  // keying solely on episode_id covers both per-show and batch runs.
  const now = new Date();
  try {
    await labDb.collection('pipeline_runs').updateMany(
      {
        kind: 'trailer',
        'episodes.episode_id': episodeId,
        'episodes.status': { $in: ['READY_TO_SYNC', 'SYNC_PENDING', 'FAILED'] },
      },
      { $set: { 'episodes.$.status': 'SYNCED', 'episodes.$.synced_at': now } },
    );
  } catch (err) {
    console.warn('[trailerScanner] pipeline_runs SYNCED update failed:', err?.message);
  }
}

async function trySyncOnly({ episodeId, combinedUrl }) {
  try {
    const res = await fetch(`${getBaseUrl()}/api/sync-showcache-trailer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId, signedPlaybackUrl: combinedUrl }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: body?.error };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message };
  }
}

async function countRunningTrailerRuns(labDb) {
  return labDb.collection('pipeline_runs').countDocuments({
    kind: 'trailer',
    status: 'RUNNING',
  });
}

/** Sweep orphaned RUNNING trailer runs. A run is "stale" when neither the
 *  run nor any of its episodes has been touched for STALE_RUN_MS. This flips
 *  them to CANCELLED so the scanner isn't perpetually blocked by ghost runs
 *  left over from crashes or orchestrator lock expiries. Returns the number
 *  cancelled. */
async function cancelStaleTrailerRuns(labDb) {
  const threshold = new Date(Date.now() - STALE_RUN_MS);
  const runs = await labDb.collection('pipeline_runs')
    .find(
      { kind: 'trailer', status: 'RUNNING' },
      {
        projection: {
          _id: 1,
          created_at: 1,
          started_at: 1,
          locked_at: 1,
          'episodes.last_updated_at': 1,
        },
      },
    )
    .toArray();

  let cancelled = 0;
  for (const run of runs) {
    const eps = Array.isArray(run.episodes) ? run.episodes : [];
    let maxActivity = 0;
    for (const ep of eps) {
      const t = ep?.last_updated_at ? new Date(ep.last_updated_at).getTime() : 0;
      if (t > maxActivity) maxActivity = t;
    }
    // Factor in run-level timestamps so a fresh run with no ep activity yet
    // (e.g. just inserted) isn't misdetected as stale.
    const lockT = run.locked_at ? new Date(run.locked_at).getTime() : 0;
    const startT = run.started_at ? new Date(run.started_at).getTime() : 0;
    const createdT = run.created_at ? new Date(run.created_at).getTime() : 0;
    const latest = Math.max(maxActivity, lockT, startT, createdT);
    if (latest === 0 || latest >= threshold.getTime()) continue; // still fresh

    try {
      const res = await labDb.collection('pipeline_runs').updateOne(
        { _id: run._id, status: 'RUNNING' },
        {
          $set: {
            status: 'CANCELLED',
            finished_at: new Date(),
            locked_by: null,
            locked_at: null,
            cancelled_reason: `stale: no activity for >${Math.round(STALE_RUN_MS / 60000)}min`,
          },
        },
      );
      if (res.modifiedCount > 0) {
        cancelled++;
        console.warn(
          `[trailerScanner] cancelled stale trailer run ${run._id} ` +
          `(last activity ${new Date(latest).toISOString()})`,
        );
      }
    } catch (err) {
      console.warn(`[trailerScanner] failed to cancel stale run ${run._id}:`, err?.message);
    }
  }
  return cancelled;
}

/** Collect episode_ids currently being processed by any RUNNING trailer run
 *  (batch or per-show). The scanner uses this to avoid double-enqueueing a
 *  trailer that another pipeline already owns. */
async function activeTrailerEpisodeIds(labDb) {
  const runs = await labDb.collection('pipeline_runs')
    .find({ kind: 'trailer', status: 'RUNNING' }, { projection: { 'episodes.episode_id': 1, 'episodes.status': 1 } })
    .toArray();
  const ids = new Set();
  for (const run of runs) {
    for (const ep of run.episodes || []) {
      // Terminal eps within an unfinished run are settled — don't block new work for them.
      if (ep.status === 'SKIPPED' || ep.status === 'SYNCED' || ep.status === 'FAILED' || ep.status === 'CANCELLED') continue;
      if (ep.episode_id) ids.add(ep.episode_id);
    }
  }
  return ids;
}

/** Build a pipeline_runs.episodes[] entry for a single batched trailer. */
function makeBatchEpisodeDoc({ episodeId, trailerKey, title, s3Url, showIdStr, showTitle, showSlug, nowDate }) {
  return {
    episode_id: episodeId,
    trailer_key: trailerKey,
    title: title || episodeId,
    s3_url: s3Url,
    // Per-episode show info lets the UI show the right show for each trailer
    // even though the run-level show_id is the BATCH_SHOW_ID sentinel.
    show_id: showIdStr,
    show_title: showTitle || null,
    show_slug: showSlug || null,
    status: 'QUEUED',
    lab_h264_status: 'COMPLETE',
    lab_h265_status: 'COMPLETE',
    gcp_h264_status: null,
    gcp_h265_status: null,
    retries: { lab_h264: 0, lab_h265: 0, gcp_h264: 0, gcp_h265: 0, combine: 0, qc: 0, sync: 0 },
    retry_after_lab_h264: null,
    retry_after_lab_h265: null,
    retry_after_h264: null,
    retry_after_h265: null,
    gcp_enqueued_h264: false,
    gcp_enqueued_h265: false,
    combined: false,
    current_step: 'GCP_H264',
    error: null,
    started_at: nowDate,
    finished_at: null,
    duration_ms: null,
    last_updated_at: nowDate,
    synced_at: null,
    transition_log: [],
  };
}

async function isScannerEnabled(labDb) {
  const doc = await labDb.collection('scanner_settings').findOne({ _id: SETTINGS_ID });
  return Boolean(doc?.enabled);
}

export async function scanTrailersOnce({ force = false } = {}) {
  if (localScanRunning) {
    console.log('[trailerScanner] local scan still running — skipping tick');
    return { skipped: 'local-busy' };
  }
  localScanRunning = true;
  const startedAt = Date.now();

  const client = await clientPromise();
  const masterDb = client.db('master');
  const labDb = client.db('chai_q_lab');

  // Operator toggle — must be explicitly enabled via the Trailer Overview UI.
  // `force: true` bypasses this check (used for a manual one-shot scan).
  if (!force) {
    const enabled = await isScannerEnabled(labDb);
    if (!enabled) {
      localScanRunning = false;
      return { skipped: 'disabled' };
    }
  }

  const lockOwner = await acquireDistributedLock(labDb, SCANNER_LOCK_ID);
  if (!lockOwner) {
    localScanRunning = false;
    console.log('[trailerScanner] distributed lock held by another instance — skipping tick');
    return { skipped: 'lock-held' };
  }

  let showsScanned = 0;
  let syncOnlyHits = 0;
  let syncOnlyFailed = 0;
  let fullRunsStarted = 0;
  let fullRunsDeferred = 0;
  let driftDetected = 0;

  try {
    // Sweep stale RUNNING runs first so they don't block new batches or
    // poison the activeIds set with episodes that will never complete.
    const staleCancelled = await cancelStaleTrailerRuns(labDb);
    if (staleCancelled > 0) {
      console.warn(`[trailerScanner] cancelled ${staleCancelled} stale trailer run(s) this tick`);
    }

    const activeIds = await activeTrailerEpisodeIds(labDb);
    const shows = await masterDb.collection('showcache')
      .find(
        { 'trailers_playback_urls.0': { $exists: true } },
        { projection: { _id: 1, title: 1, slug: 1, trailers_playback_urls: 1 } },
      )
      .toArray();

    // Pass 1: classify every trailer across every show.
    // Trailers already owned by a RUNNING pipeline_run are excluded so we
    // don't double-queue work.
    const candidates = {
      syncOnly: [],    // { episodeId, combinedUrl, showIdStr }
      full: [],        // { episodeId, trailerKey, title, s3Url, showIdStr, showTitle, showSlug, reason }
    };
    for (const show of shows) {
      showsScanned++;
      const showIdStr = String(show._id);
      const trailers = Array.isArray(show.trailers_playback_urls) ? show.trailers_playback_urls : [];
      for (const t of trailers) {
        const key = t?._key;
        const s3 = t?.s3Url || t?.s3_url;
        if (!key || !s3 || String(s3).trim() === '') continue;
        const episodeId = trailerSyntheticId(showIdStr, key);
        if (activeIds.has(episodeId)) continue; // already being processed

        const drifted = await hasS3UrlDrifted({ episodeId, s3Url: s3 });
        const combinedGcp = isCombinedUrl(t?.gcpUrl);

        if (combinedGcp && !drifted) continue; // fully done

        if (drifted) {
          driftDetected++;
          candidates.full.push({
            episodeId,
            trailerKey: key,
            title: t?.title || `Trailer ${key}`,
            s3Url: s3,
            showIdStr,
            showTitle: show.title || null,
            showSlug: show.slug || null,
            reason: 's3Url drift',
          });
          continue;
        }

        // Not drifted, gcpUrl not combined. Sync-only if lab has the combined
        // master URL already; otherwise a full re-run.
        const combinedLabUrl = await readCombinedMasterUrl(episodeId);
        if (combinedLabUrl) {
          candidates.syncOnly.push({ episodeId, combinedUrl: combinedLabUrl, showIdStr });
        } else {
          candidates.full.push({
            episodeId,
            trailerKey: key,
            title: t?.title || `Trailer ${key}`,
            s3Url: s3,
            showIdStr,
            showTitle: show.title || null,
            showSlug: show.slug || null,
            reason: 'no combined url yet',
          });
        }
      }
    }

    // Pass 2: execute all sync-only hits in parallel.
    await Promise.all(candidates.syncOnly.map(async (c) => {
      const res = await trySyncOnly({ episodeId: c.episodeId, combinedUrl: c.combinedUrl });
      if (res.ok) {
        syncOnlyHits++;
        await updatePipelineRunsToSynced(labDb, c.showIdStr, c.episodeId);
      } else {
        syncOnlyFailed++;
        console.warn(
          `[trailerScanner] sync-only failed for ${c.episodeId}: ${res.status} ${res.error || ''}`,
        );
      }
    }));

    // Re-check the operator toggle before Pass 3. Sync-only was safe to run
    // (finalises existing work). Pass 3 starts new GCP encoding — honour a
    // mid-scan disable.
    const stillEnabled = await isScannerEnabled(labDb);
    if (!stillEnabled) {
      const ms = Date.now() - startedAt;
      console.log(
        `[trailerScanner] disabled mid-scan — skipping batch creation (sync: ${syncOnlyHits} ok / ${syncOnlyFailed} failed, ${ms}ms)`,
      );
      return {
        showsScanned, syncOnlyHits, syncOnlyFailed,
        fullRunsStarted, fullRunsDeferred, driftDetected,
        disabledMidScan: true, ms,
      };
    }

    // Pass 3: single batch run. If a batch (or any RUNNING trailer run) is
    // already in flight, skip — the existing run will drain its queue and
    // the next tick will pick up what's left. Otherwise create ONE
    // pipeline_run mixing trailers from multiple shows; max_gcp=10 on the
    // run enforces the "5 trailers concurrent" invariant.
    if (candidates.full.length === 0) {
      const ms = Date.now() - startedAt;
      console.log(
        `[trailerScanner] scanned ${showsScanned} shows in ${ms}ms — ` +
        `sync-only: ${syncOnlyHits} ok / ${syncOnlyFailed} failed · ` +
        `no full candidates · drift: ${driftDetected}`,
      );
      return {
        showsScanned, syncOnlyHits, syncOnlyFailed,
        fullRunsStarted, fullRunsDeferred, driftDetected, ms,
      };
    }

    const runningNow = await countRunningTrailerRuns(labDb);
    if (runningNow > 0) {
      fullRunsDeferred = candidates.full.length;
      const ms = Date.now() - startedAt;
      console.log(
        `[trailerScanner] scanned ${showsScanned} shows in ${ms}ms — ` +
        `sync-only: ${syncOnlyHits} ok / ${syncOnlyFailed} failed · ` +
        `${runningNow} trailer run(s) already RUNNING, deferring ${fullRunsDeferred} candidates · ` +
        `drift: ${driftDetected}`,
      );
      return {
        showsScanned, syncOnlyHits, syncOnlyFailed,
        fullRunsStarted, fullRunsDeferred, driftDetected, ms,
      };
    }

    // Cap batch size to avoid unbounded fan-out. Remainder will be picked up
    // on the next tick once this batch finishes.
    const max = batchMax();
    const slice = candidates.full.slice(0, max);
    const deferredCount = Math.max(0, candidates.full.length - slice.length);
    fullRunsDeferred = deferredCount;

    // Probe + write synthetic golden_recipes for each batched trailer. Per-
    // trailer errors become SKIPPED episodes so one bad source doesn't block
    // the batch. Concurrency is capped (see probeConcurrency) because firing
    // all probes at once saturates cross-region S3 bandwidth and causes the
    // ffprobe timeout to fire on most of them.
    const nowDate = new Date();
    const probeErrors = new Map();
    await probeBatchWithLimit(slice, probeErrors);

    const okCandidates = slice.filter(c => !probeErrors.has(c.episodeId));
    if (okCandidates.length === 0) {
      const ms = Date.now() - startedAt;
      console.warn(
        `[trailerScanner] all ${slice.length} candidates failed probe — no batch created (${ms}ms)`,
      );
      return {
        showsScanned, syncOnlyHits, syncOnlyFailed,
        fullRunsStarted: 0, fullRunsDeferred: deferredCount, driftDetected,
        probeFailed: slice.length, ms,
      };
    }

    const episodes = [
      ...okCandidates.map(c => makeBatchEpisodeDoc({
        episodeId: c.episodeId,
        trailerKey: c.trailerKey,
        title: c.title,
        s3Url: c.s3Url,
        showIdStr: c.showIdStr,
        showTitle: c.showTitle,
        showSlug: c.showSlug,
        nowDate,
      })),
      ...slice.filter(c => probeErrors.has(c.episodeId)).map(c => {
        const doc = makeBatchEpisodeDoc({
          episodeId: c.episodeId,
          trailerKey: c.trailerKey,
          title: c.title,
          s3Url: c.s3Url,
          showIdStr: c.showIdStr,
          showTitle: c.showTitle,
          showSlug: c.showSlug,
          nowDate,
        });
        doc.status = 'SKIPPED';
        doc.error = `probe failed: ${probeErrors.get(c.episodeId)}`;
        doc.started_at = null;
        return doc;
      }),
    ];

    const runDoc = {
      show_id: BATCH_SHOW_ID,
      show_slug: null,
      show_title: 'Trailer batch',
      kind: 'trailer',
      status: 'RUNNING',
      lab_workers: 30,
      max_gcp: 10,
      locked_by: null,
      locked_at: null,
      created_at: nowDate,
      started_at: null,
      finished_at: null,
      total_episodes: episodes.length,
      skipped_episodes: probeErrors.size,
      episodes,
      completed_count: 0,
      failed_count: 0,
      running_count: 0,
      skipped_count: probeErrors.size,
      eta_ms: null,
      gcp_queue_h264: [],
      gcp_queue_h265: [],
      gcp_paused_until: null,
      is_batch: true,
    };

    const insertResult = await labDb.collection('pipeline_runs').insertOne(runDoc);
    const runId = String(insertResult.insertedId);
    fullRunsStarted = 1;

    // Spawn the orchestrator in the background. Errors won't bubble to the
    // scanner — they're logged but we don't block on them here.
    setImmediate(() => {
      orchestrate(runId).catch(err => {
        console.error(`[trailerScanner] orchestrator crash for batch ${runId}:`, err);
      });
    });

    const ms = Date.now() - startedAt;
    console.log(
      `[trailerScanner] scanned ${showsScanned} shows in ${ms}ms — ` +
      `sync-only: ${syncOnlyHits} ok / ${syncOnlyFailed} failed · ` +
      `batch started (${okCandidates.length} runnable, ${probeErrors.size} probe-failed, ${deferredCount} deferred) · ` +
      `drift: ${driftDetected} · runId=${runId}`,
    );
    return {
      showsScanned, syncOnlyHits, syncOnlyFailed,
      fullRunsStarted, fullRunsDeferred, driftDetected,
      runId, ms,
    };
  } catch (err) {
    console.error('[trailerScanner] scan failed:', err);
    return { error: err?.message };
  } finally {
    await releaseDistributedLock(labDb, SCANNER_LOCK_ID, lockOwner);
    localScanRunning = false;
  }
}

export function startTrailerScanner() {
  if (process.env.TRAILER_SCANNER_ENABLED === 'false') {
    console.log('[trailerScanner] disabled via TRAILER_SCANNER_ENABLED=false');
    return;
  }
  if (scannerTimer) return;

  setTimeout(() => {
    scanTrailersOnce().catch(err => console.error('[trailerScanner] leading scan error:', err));
  }, 10_000);

  scannerTimer = setInterval(() => {
    scanTrailersOnce().catch(err => console.error('[trailerScanner] tick error:', err));
  }, SCAN_INTERVAL_MS);

  console.log(
    `[trailerScanner] started — interval ${SCAN_INTERVAL_MS / 1000}s, ` +
    `batch max = ${batchMax()} trailers, per-batch max_gcp = 10 (5 trailers concurrent)`,
  );
}
