// Parallel Resol — search-unit lab engine.
//
// The serial lab (Chai-Q-Orchestrator-<codec> behind /api/push) keeps ONE Batch
// worker busy and walks the 3 resolutions one at a time (~3 h). This instead
// runs one worker PER (episode, resolution, codec) unit — 6 units per episode
// (3 resolutions x 2 codecs). Each worker runs the FULL binary search for its
// resolution internally (research-worker/worker.py). All units flow through one
// global, work-conserving pool of ~120 slots: one slot == one Batch job == one
// unit; when any unit finishes, the next queued unit fills the slot immediately,
// so all ~120 workers stay busy while work remains. Binary search is KEPT — only
// the 6 resolution/codec units are parallelised.
//
// It writes the SAME outputs the serial lab does — golden_recipes +
// lab_status_<codec>='COMPLETE' on video_episodes — then hands off to the
// existing orchestrate() for GCP -> combine -> QC. Nothing downstream changes.
//
// This path is entirely separate from the serial "Run Pipeline" flow.

import { ObjectId } from 'mongodb';
import { submitJob, describeJobs, terminateJob } from '@/lib/jobs';
import { randomUUID } from 'crypto';
import clientPromise from '@/lib/mongodb';
import {
  VMAF_THRESHOLDS,
  BITRATE_LADDERS,
  RESOLUTION_ORDER,
  CODEC_LIB,
  buildUnitQueue,
  unitsPerCodec,
  unitKey,
  gridKey,
  resolutionEnvValue,
} from '@/lib/gridLadders';
import { DB_LAB } from '@/lib/config';

const JOB_QUEUE = process.env.BATCH_JOB_QUEUE || 'chai-q-queue';
const JOB_DEFINITION = process.env.BATCH_JOB_DEFINITION || 'chai-q-worker';

// Hard ceiling = 512 max_vcpus / 4 vCPU per job = 128. Default target 120,
// overridable per-run via run.encode_workers. Clamp to [1, 128].
const DEFAULT_POOL = 120;
const MAX_POOL = 128;

const POLL_MS = 10_000; // Batch DescribeJobs cadence
const MAX_ENCODE_RETRIES = 2; // requeue a spot-killed / failed encode this many times
const DESCRIBE_CHUNK = 100; // DescribeJobs accepts <=100 job IDs per call

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Submit one (episode, resolution, codec) search unit as a Batch job. NO BITRATE
// is passed — the worker binary-searches the whole ladder for this resolution
// internally. MONGO_URI is baked into the job definition, so we don't pass it.
async function submitUnit(unit, labRunId) {
  const jobName =
    `ParallelResol-${unit.episode_id.slice(0, 20)}-${unit.codec}-` +
    `${unit.resolution_env}-${randomUUID().slice(0, 6)}`;
  return submitJob('lab', {
    jobName: jobName.slice(0, 128),
    jobQueue: JOB_QUEUE,
    jobDefinition: JOB_DEFINITION,
    containerOverrides: {
      environment: [
        { name: 'LAB_MODE', value: 'search' }, // triggers in-container binary search in worker.py
        { name: 'CODEC', value: unit.codec_lib },
        { name: 'RESOLUTION', value: unit.resolution_env },
        { name: 'S3_URL', value: unit.s3_url },
        { name: 'EPISODE_ID', value: unit.episode_id },
        { name: 'LAB_RUN_ID', value: labRunId },
      ],
    },
  });
}

// Submit ONE single-bitrate encode. No LAB_MODE → the worker runs run_research()
// (encode this exact BITRATE, write one trial to video_vmaf_research). Used by
// the bitrate-wise episode Resol engine.
async function submitBitrate(item, labRunId) {
  const jobName =
    `BitrateResol-${item.episode_id.slice(0, 16)}-${item.codec}-` +
    `${item.resolution_env}-${item.bitrate}-${randomUUID().slice(0, 6)}`;
  return submitJob('lab', {
    jobName: jobName.slice(0, 128),
    jobQueue: JOB_QUEUE,
    jobDefinition: JOB_DEFINITION,
    containerOverrides: {
      environment: [
        { name: 'CODEC', value: item.codec_lib },
        { name: 'RESOLUTION', value: item.resolution_env },
        { name: 'BITRATE', value: String(item.bitrate) },
        { name: 'S3_URL', value: item.s3_url },
        { name: 'EPISODE_ID', value: item.episode_id },
        { name: 'LAB_RUN_ID', value: labRunId },
      ],
    },
  });
}

const TERMINAL_OK = 'SUCCEEDED';
const TERMINAL_FAIL = 'FAILED';

// Poll the terminal state of the given job IDs. Returns Map<jobId, 'SUCCEEDED'|'FAILED'>
// for those that have finished; running/starting jobs are omitted.
async function describeTerminal(jobIds) {
  const terminal = new Map();
  for (let i = 0; i < jobIds.length; i += DESCRIBE_CHUNK) {
    const chunk = jobIds.slice(i, i + DESCRIBE_CHUNK);
    for (const job of await describeJobs(chunk)) {
      if (job.status === TERMINAL_OK || job.status === TERMINAL_FAIL) {
        terminal.set(job.jobId, job.status);
      }
    }
  }
  return terminal;
}

async function terminateAll(jobIds, reason) {
  await Promise.all(
    jobIds.map((jobId) => terminateJob(jobId, reason).catch(() => {})),
  );
}

// Port of aggregator.py find_winner: lowest bitrate whose VMAF >= threshold,
// else the highest-VMAF candidate below threshold.
function findWinner(docs, threshold) {
  const valid = docs
    .filter((d) => d.vmaf_score != null)
    .sort((a, b) => a.bitrate_kbps - b.bitrate_kbps);
  if (valid.length === 0) return null;
  const above = valid.filter((d) => d.vmaf_score >= threshold);
  const winner = above.length ? above[0] : valid.reduce((m, d) => (d.vmaf_score > m.vmaf_score ? d : m), valid[0]);
  return {
    bitrate_kbps: winner.bitrate_kbps,
    vmaf_attained: winner.vmaf_score,
    params: winner.params,
  };
}

// Aggregate one (episode, codec) grid into golden_recipes and mark the codec's
// lab COMPLETE. Faithful Node port of aggregator.py's per-codec path (which is
// how the serial lab writes results), so orchestrate() sees identical state.
async function aggregateGrid(db, episodeId, codec) {
  const codecLib = CODEC_LIB[codec]; // libx264 / libx265
  const results = await db
    .collection('video_vmaf_research')
    .find({ episode_id: episodeId, codec: codecLib })
    .toArray();
  // Every worker failed before writing a trial (bad source URL, unreadable file).
  // Throw so callers mark the lab FAILED instead of COMPLETE with no winners.
  if (!results.some((r) => r.vmaf_score != null)) {
    throw new Error(`no VMAF results for ${episodeId}/${codec} — all Batch jobs failed; check the chai-q-worker logs in /aws/batch/job`);
  }

  const existing = await db.collection('video_episodes').findOne(
    { episode_id: episodeId },
    { projection: { golden_recipes: 1, efficiency_gain: 1 } },
  );
  const existingResolutions = existing?.golden_recipes?.resolutions || {};
  const efficiencyGain = { ...(existing?.efficiency_gain || {}) };

  const setOp = {};
  for (const res of RESOLUTION_ORDER) {
    const threshold = VMAF_THRESHOLDS[res];
    const resDocs = results.filter((r) => r.resolution === res);
    const codecWinners = { ...(existingResolutions[res] || {}) };

    const winner = findWinner(resDocs, threshold);
    if (winner) {
      codecWinners[codec] = winner;
      setOp[`golden_recipes.resolutions.${res}.${codec}`] = winner;
    }

    // efficiency_gain needs BOTH codecs — recompute when both are present.
    const h265W = codecWinners.h265;
    const h264W = codecWinners.h264;
    if (h265W && h264W && h264W.bitrate_kbps > 0) {
      const gain = Math.round((1 - h265W.bitrate_kbps / h264W.bitrate_kbps) * 100 * 100) / 100;
      efficiencyGain[res] = `${gain}%`;
    } else if (!(res in efficiencyGain)) {
      efficiencyGain[res] = 'N/A';
    }
  }

  setOp.status = 'ANALYSIS_COMPLETE';
  setOp[`lab_status_${codec}`] = 'COMPLETE';
  setOp[`lab_finished_at_${codec}`] = nowIso();
  setOp.efficiency_gain = efficiencyGain;

  await db.collection('video_episodes').updateOne(
    { episode_id: episodeId },
    { $set: setOp },
    { upsert: true },
  );
}

// ── Main entry ─────────────────────────────────────────────────────────────
export async function runParallelResolLab(runIdStr) {
  const runId = new ObjectId(runIdStr);
  const instanceId = `pr-${randomUUID().slice(0, 8)}`;
  const client = await clientPromise();
  const db = client.db(DB_LAB);
  const col = db.collection('pipeline_runs');

  // Engine lock — SEPARATE from orchestrate()'s locked_by. orchestrate() is the
  // run driver (holds locked_by, runs GCP→combine→QC); this only stops a second
  // engine instance for the same run. Stale after 5 min so a restart resumes.
  const lock = await col.updateOne(
    {
      _id: runId,
      status: 'RUNNING',
      $or: [{ pr_lock: null }, { pr_lock: { $exists: false } }, { pr_lock_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }],
    },
    { $set: { pr_lock: instanceId, pr_lock_at: new Date() } },
  );
  if (lock.matchedCount === 0) {
    console.log(`[parallelResol] engine already running for ${runIdStr}`);
    return;
  }
  const releaseLock = () => col.updateOne({ _id: runId, pr_lock: instanceId }, { $set: { pr_lock: null, pr_lock_at: null } });

  const run = await col.findOne({ _id: runId });
  if (!run || run.status !== 'RUNNING') { await releaseLock(); return; }

  const POOL = Math.min(MAX_POOL, Math.max(1, run.encode_workers || DEFAULT_POOL));
  const labRunId = randomUUID();
  const codecs = Array.isArray(run.codecs) && run.codecs.length ? run.codecs : ['h264', 'h265'];
  const episodes = (run.episodes || []).filter(
    (ep) => ep.status !== 'SKIPPED' && (ep.s3_url || '').trim() !== '',
  );

  // Skip (episode, codec) grids already COMPLETE in video_episodes — resume-safe:
  // a restarted engine re-runs only unfinished grids; orchestrate() drives GCP
  // for the completed ones. (Fresh runs are reset to non-COMPLETE by the start
  // route, so nothing is skipped on a first run.)
  const epIds = episodes.map((ep) => ep.episode_id);
  const existingDocs = await db.collection('video_episodes')
    .find({ episode_id: { $in: epIds } }, { projection: { episode_id: 1, lab_status_h264: 1, lab_status_h265: 1 } })
    .toArray();
  const labStatusByEp = new Map(existingDocs.map((d) => [d.episode_id, d]));
  const gridsToRun = new Set();
  for (const ep of episodes) {
    for (const codec of codecs) {
      if (labStatusByEp.get(ep.episode_id)?.[`lab_status_${codec}`] !== 'COMPLETE') {
        gridsToRun.add(gridKey(ep.episode_id, codec));
      }
    }
  }
  if (gridsToRun.size === 0) { await releaseLock(); return; }

  // Clear stale research docs for the grids we will run, mark those codecs
  // RUNNING (video_episodes only — orchestrate() owns the run doc). Parity with /api/push.
  for (const ep of episodes) {
    const runningCodecs = codecs.filter((c) => gridsToRun.has(gridKey(ep.episode_id, c)));
    if (runningCodecs.length === 0) continue;
    for (const codec of runningCodecs) {
      await db.collection('video_vmaf_research').deleteMany({ episode_id: ep.episode_id, codec: CODEC_LIB[codec] });
    }
    const labFields = { lab_run_id: labRunId };
    for (const codec of runningCodecs) labFields[`lab_status_${codec}`] = 'RUNNING';
    await db.collection('video_episodes').updateOne(
      { episode_id: ep.episode_id },
      { $set: labFields },
      { upsert: true },
    );
  }

  // Work-conserving queue of search units, limited to the grids we will run.
  const queue = buildUnitQueue(episodes, codecs).filter((u) => gridsToRun.has(gridKey(u.episode_id, u.codec)));

  // Per (episode, codec) grid completion tracking (only grids we run).
  const gridTotal = new Map(); // gridKey -> units expected (3 resolutions)
  const gridDone = new Map(); // gridKey -> terminal unit count
  const gridAggregated = new Set();
  for (const key of gridsToRun) {
    gridTotal.set(key, unitsPerCodec());
    gridDone.set(key, 0);
  }

  const active = new Map(); // jobId -> { item, att } (submitted, awaiting terminal state)
  const attempts = new Map(); // unitKey -> attempts so far
  const submitFailed = []; // items whose submitJob() threw — reconciled in the poll loop
  let inFlight = 0; // slots reserved SYNCHRONOUSLY at dispatch — this is what caps the pool

  async function isCancelled() {
    // A transient Mongo blip must NOT kill the loop (that would strand episodes
    // RUNNING forever). Treat a read error as "not cancelled" and retry next tick.
    try {
      const r = await col.findOne({ _id: runId }, { projection: { status: 1 } });
      return !r || r.status !== 'RUNNING';
    } catch (err) {
      console.warn(`[parallelResol] isCancelled check failed (transient), continuing:`, err.message);
      return false;
    }
  }

  // Count one finished unit (synchronous — never throws).
  function markUnitDone(item) {
    const key = gridKey(item.episode_id, item.codec);
    gridDone.set(key, (gridDone.get(key) || 0) + 1);
  }

  // Aggregate any grid whose 3 resolution-units are all terminal → writes
  // golden_recipes + lab_status_<codec>='COMPLETE' to video_episodes.
  // orchestrate()'s pollLabs reads that via /api/status and enqueues GCP for THAT
  // episode (per-episode pipelining). Decoupled from unit-counting and per-grid
  // try/caught so a transient aggregate failure leaves the grid un-aggregated and
  // simply retries next tick — a grid can't get stuck if its last unit's write
  // blips. Never touches the run doc (orchestrate owns it).
  async function aggregateReadyGrids() {
    for (const key of gridsToRun) {
      if (gridAggregated.has(key) || (gridDone.get(key) || 0) < gridTotal.get(key)) continue;
      const sep = key.indexOf('|');
      try {
        await aggregateGrid(db, key.slice(0, sep), key.slice(sep + 1));
        gridAggregated.add(key);
      } catch (err) {
        console.warn(`[parallelResol] aggregate ${key} failed (will retry):`, err.message);
      }
    }
  }

  // Reserve slots SYNCHRONOUSLY via inFlight so the pool never oversubmits.
  // submitUnit() is async: gating on active.size (only mutated inside .then)
  // would let a single fill() drain the entire queue before any callback runs.
  // Submit outcomes are reconciled in the poll loop (active = real jobs,
  // submitFailed = throws).
  function fill() {
    while (inFlight < POOL && queue.length > 0) {
      const item = queue.shift();
      const k = unitKey(item);
      const att = attempts.get(k) || 0;
      inFlight++;
      submitUnit(item, labRunId)
        .then((jobId) => {
          if (jobId) active.set(jobId, { item, att });
          else submitFailed.push({ item, k, att });
        })
        .catch((err) => {
          console.warn(`[parallelResol] submit failed ${k}:`, err.message);
          submitFailed.push({ item, k, att });
        });
    }
  }

  // Prime the pool, then poll → reconcile → backfill until every encode is final.
  // Loop while anything is reserved (inFlight) or still queued.
  fill();

  while (inFlight > 0 || queue.length > 0) {
    if (await isCancelled()) {
      await terminateAll([...active.keys()], 'Parallel Resol run cancelled');
      console.log(`[parallelResol] ${runIdStr} cancelled — terminated ${active.size} jobs`);
      await releaseLock();
      return; // orchestrate() + cancel route handle run status / restore
    }

    await sleep(POLL_MS);

    // A transient Batch/Mongo error in one tick must not kill the loop (that
    // would strand episodes RUNNING). Log and retry next tick.
    try {
      // 1. Reconcile submit failures: free the slot, then requeue (spot/transient)
      //    or finalize the encode (tolerated — aggregator uses whatever landed).
      while (submitFailed.length > 0) {
        const { item, k, att } = submitFailed.shift();
        inFlight--;
        if (att < MAX_ENCODE_RETRIES) {
          attempts.set(k, att + 1);
          queue.push(item);
        } else {
          markUnitDone(item);
        }
      }

      // 2. Reconcile terminal Batch jobs.
      const terminal = await describeTerminal([...active.keys()]);
      for (const [jobId, status] of terminal) {
        const entry = active.get(jobId);
        active.delete(jobId);
        if (!entry) continue;
        inFlight--;
        const { item, att } = entry;
        const k = unitKey(item);
        if (status === TERMINAL_FAIL && att < MAX_ENCODE_RETRIES) {
          // Spot interruption / transient failure → requeue (don't drop the bitrate).
          attempts.set(k, att + 1);
          queue.push(item);
          continue;
        }
        // SUCCEEDED, or FAILED past retry budget (tolerated).
        markUnitDone(item);
      }

      // 3. Aggregate any grid whose units are all terminal (pipelined GCP).
      await aggregateReadyGrids();

      // 4. Backfill freed slots.
      fill();
    } catch (err) {
      console.warn(`[parallelResol] poll iteration error (transient), continuing:`, err.message);
    }
  }

  // Final sweep: aggregate any grid that finished on the very last tick (or whose
  // aggregate write blipped) so no episode is left un-COMPLETE.
  await aggregateReadyGrids();

  // Grids still un-aggregated after the final sweep are real failures (e.g. no
  // trial ever landed) — surface them instead of leaving the lab RUNNING forever.
  for (const key of gridsToRun) {
    if (gridAggregated.has(key)) continue;
    const sep = key.indexOf('|');
    const episodeId = key.slice(0, sep);
    const codec = key.slice(sep + 1);
    await db.collection('video_episodes').updateOne(
      { episode_id: episodeId },
      { $set: { [`lab_status_${codec}`]: 'FAILED', [`lab_error_${codec}`]: 'Aggregation failed: no VMAF results — all Batch jobs failed; check the chai-q-worker logs in /aws/batch/job' } },
    ).catch((err) => console.warn(`[parallelResol] mark FAILED ${key} failed:`, err.message));
  }

  // All grids terminal. Release the engine lock. orchestrate() (running as the
  // driver) has been enqueuing GCP per episode as each grid completed, and keeps
  // driving GCP → combine → QC until every episode is delivered.
  await releaseLock();
}

// ── Single episode + codec (episode-page "Run lab · Resol") ──────────────────
// Fans ONE episode-codec's 3 resolutions into 3 workers (each an in-container
// binary search), then aggregates the winner into golden_recipes. LAB-ONLY —
// no pipeline_run, no orchestrate(), no GCP — matching the episode page's serial
// Run-lab button, which is also lab-only. Reuses submitUnit/describeTerminal/
// aggregateGrid so behaviour matches the show-level path.
export async function runEpisodeGrid(episodeId, s3Url, codec) {
  const client = await clientPromise();
  const db = client.db(DB_LAB);
  const veCol = db.collection('video_episodes');
  const codecLib = CODEC_LIB[codec];
  const labRunId = randomUUID();
  const units = buildUnitQueue([{ id: episodeId, s3_url: s3Url }], [codec]); // 3 resolution units
  const totalUnits = units.length;

  // Reset this codec's lab state (parity with /api/push): clear prior trials +
  // golden recipes, mark RUNNING so the episode-page poller reflects progress.
  await db.collection('video_vmaf_research').deleteMany({ episode_id: episodeId, codec: codecLib });
  const unsetGolden = { efficiency_gain: '' };
  for (const res of RESOLUTION_ORDER) unsetGolden[`golden_recipes.resolutions.${res}.${codec}`] = '';
  await veCol.updateOne(
    { episode_id: episodeId },
    {
      $set: { [`lab_status_${codec}`]: 'RUNNING', [`lab_run_started_at_${codec}`]: nowIso(), lab_run_id: labRunId },
      $unset: unsetGolden,
    },
    { upsert: true },
  );

  const active = new Map(); // jobId -> { unit, att }
  const attempts = new Map();
  const queue = [...units];
  let done = 0; // units reached a terminal state (success or final-fail)

  async function submitPending() {
    const pending = queue.splice(0);
    for (const unit of pending) {
      const k = unitKey(unit);
      const att = attempts.get(k) || 0;
      try {
        const jobId = await submitUnit(unit, labRunId);
        if (jobId) active.set(jobId, { unit, att });
        else queue.push(unit);
      } catch (err) {
        console.warn(`[parallelResol/episode] submit failed ${k}:`, err.message);
        if (att < MAX_ENCODE_RETRIES) { attempts.set(k, att + 1); queue.push(unit); }
        else done++; // give up on this resolution; aggregator uses whatever landed
      }
    }
  }

  await submitPending();

  const MAX_POLLS = 400; // ~4000s backstop (> the 3000s per-job timeout)
  let polls = 0;
  while (done < totalUnits && polls < MAX_POLLS) {
    polls++;
    await sleep(POLL_MS);
    // Bail if the lab was stopped (stop-lab sets FAILED), cancelled, or taken
    // over by a serial re-run — the run status left RUNNING only while we own it.
    try {
      const doc = await veCol.findOne({ episode_id: episodeId }, { projection: { [`lab_status_${codec}`]: 1 } });
      const st = doc?.[`lab_status_${codec}`];
      if (st === 'CANCELLED' || st === 'FAILED') return;
    } catch { /* transient — keep going */ }

    let terminal;
    try { terminal = await describeTerminal([...active.keys()]); }
    catch (err) { console.warn(`[parallelResol/episode] describe (transient):`, err.message); continue; }

    for (const [jobId, status] of terminal) {
      const entry = active.get(jobId);
      active.delete(jobId);
      if (!entry) continue;
      const { unit, att } = entry;
      const k = unitKey(unit);
      if (status === TERMINAL_FAIL && att < MAX_ENCODE_RETRIES) {
        attempts.set(k, att + 1); queue.push(unit); continue; // spot/transient → retry
      }
      done++;
    }
    if (queue.length) await submitPending();
  }

  // If we exited on the poll cap with jobs still in flight, terminate them so
  // they don't keep burning spot after we've stopped waiting.
  if (active.size > 0) {
    await terminateAll([...active.keys()], 'episode Resol lab backstop timeout');
  }

  // Aggregate → golden_recipes + lab_status_<codec>='COMPLETE'.
  try {
    await aggregateGrid(db, episodeId, codec);
    await veCol.updateOne({ episode_id: episodeId }, { $set: { [`lab_finished_at_${codec}`]: nowIso() } });
  } catch (err) {
    console.error(`[parallelResol/episode] aggregate failed ${episodeId}/${codec}:`, err.message);
    await veCol.updateOne(
      { episode_id: episodeId },
      { $set: { [`lab_status_${codec}`]: 'FAILED', [`lab_error_${codec}`]: `Aggregation failed: ${err.message}` } },
    );
  }
}

// ── Single episode + codec, BITRATE-WISE (episode-page "Bitrate Resol") ───────
// Instead of a binary search per resolution, this launches ONE worker per
// candidate bitrate (all resolutions at once), then EARLY-CANCELS: as soon as a
// LOWER bitrate passes its VMAF threshold, every still-running HIGHER-bitrate
// worker for that resolution is terminated. Bitrates at or below a passing one
// always run to completion, so aggregateGrid()'s "lowest bitrate >= threshold"
// winner is exact. LAB-ONLY (no GCP), matching runEpisodeGrid.
export async function runEpisodeBitrateResol(episodeId, s3Url, codec) {
  const client = await clientPromise();
  const db = client.db(DB_LAB);
  const veCol = db.collection('video_episodes');
  const codecLib = CODEC_LIB[codec];
  const labRunId = randomUUID();

  // Reset this codec's lab state (parity with runEpisodeGrid / /api/push).
  await db.collection('video_vmaf_research').deleteMany({ episode_id: episodeId, codec: codecLib });
  const unsetGolden = { efficiency_gain: '' };
  for (const res of RESOLUTION_ORDER) unsetGolden[`golden_recipes.resolutions.${res}.${codec}`] = '';
  await veCol.updateOne(
    { episode_id: episodeId },
    {
      $set: { [`lab_status_${codec}`]: 'RUNNING', [`lab_run_started_at_${codec}`]: nowIso(), lab_run_id: labRunId },
      $unset: unsetGolden,
    },
    { upsert: true },
  );

  // One work item per (resolution, candidate bitrate).
  const makeItem = (res, bitrate) => ({
    episode_id: episodeId,
    s3_url: s3Url,
    codec,
    codec_lib: codecLib,
    resolution: res,
    resolution_env: resolutionEnvValue(res),
    bitrate,
  });
  const initial = [];
  for (const res of RESOLUTION_ORDER) {
    for (const bitrate of BITRATE_LADDERS[codec]?.[res] || []) initial.push(makeItem(res, bitrate));
  }
  if (initial.length === 0) {
    await veCol.updateOne({ episode_id: episodeId },
      { $set: { [`lab_status_${codec}`]: 'FAILED', [`lab_error_${codec}`]: 'No bitrate ladder for codec' } });
    return;
  }

  const active = new Map();     // jobId -> { res, bitrate, att, item }
  const attempts = new Map();   // `${res}|${bitrate}` -> attempts
  const cancelled = new Set();  // jobIds we terminated on purpose (don't retry)
  const bkey = (res, bitrate) => `${res}|${bitrate}`;

  async function submitItem(item) {
    const k = bkey(item.resolution, item.bitrate);
    const att = attempts.get(k) || 0;
    try {
      const jobId = await submitBitrate(item, labRunId);
      if (jobId) active.set(jobId, { res: item.resolution, bitrate: item.bitrate, att, item });
      else if (att < MAX_ENCODE_RETRIES) { attempts.set(k, att + 1); await submitItem(item); }
    } catch (err) {
      console.warn(`[bitrateResol] submit failed ${k}:`, err.message);
      if (att < MAX_ENCODE_RETRIES) { attempts.set(k, att + 1); await submitItem(item); }
    }
  }

  // Launch everything up front (episode-scoped: <=47 jobs, within the pool).
  for (const item of initial) await submitItem(item);

  // Wall-clock safety net. The chai-q-worker job def has NO per-attempt timeout,
  // so THIS is the only thing that kills a hung job — but it also kills healthy
  // ones still encoding. A bitrate fan-out is up to ~25 parallel single-bitrate
  // encodes (long source → slow HEVC → VMAF), plus spot queue time, so give it a
  // generous 3h ceiling. Too small (the old ~66min) killed the slower, higher-
  // bitrate encodes before they finished, leaving only the lowest bitrates and a
  // below-threshold winner.
  const MAX_POLLS = 1080; // ~10800s (3h) at POLL_MS=10s
  let polls = 0;
  while (active.size > 0 && polls < MAX_POLLS) {
    polls++;
    await sleep(POLL_MS);

    // Bail if the lab was stopped / cancelled / taken over by a re-run.
    try {
      const doc = await veCol.findOne({ episode_id: episodeId }, { projection: { [`lab_status_${codec}`]: 1 } });
      const st = doc?.[`lab_status_${codec}`];
      if (st === 'CANCELLED' || st === 'FAILED') {
        await terminateAll([...active.keys()], 'Bitrate Resol stopped');
        return;
      }
    } catch { /* transient — keep going */ }

    try {
      // 1. Reconcile terminal Batch jobs; retry spot-killed encodes (no trial written).
      const terminal = await describeTerminal([...active.keys()]);
      for (const [jobId, status] of terminal) {
        const entry = active.get(jobId);
        active.delete(jobId);
        if (!entry || cancelled.has(jobId)) continue;
        if (status === TERMINAL_FAIL && entry.att < MAX_ENCODE_RETRIES) {
          attempts.set(bkey(entry.res, entry.bitrate), entry.att + 1);
          await submitItem(entry.item);
        }
        // SUCCEEDED → trial written; FAILED past budget → tolerated (aggregator uses what landed).
      }

      // 2. Early-cancel: per resolution, kill active jobs above the lowest passing bitrate.
      const trials = await db.collection('video_vmaf_research')
        .find({ episode_id: episodeId, codec: codecLib, lab_run_id: labRunId },
          { projection: { resolution: 1, bitrate_kbps: 1, vmaf_score: 1 } })
        .toArray();
      for (const res of RESOLUTION_ORDER) {
        const threshold = VMAF_THRESHOLDS[res];
        const passed = trials
          .filter((t) => t.resolution === res && t.vmaf_score != null && t.vmaf_score >= threshold)
          .map((t) => t.bitrate_kbps);
        if (passed.length === 0) continue;
        const lowestPass = Math.min(...passed);
        const toKill = [];
        for (const [jobId, entry] of active) {
          if (entry.res === res && entry.bitrate > lowestPass) toKill.push(jobId);
        }
        for (const jobId of toKill) { cancelled.add(jobId); active.delete(jobId); }
        if (toKill.length) {
          await terminateAll(toKill, `Bitrate Resol: ${res} passes at <=${lowestPass}k`);
        }
      }
    } catch (err) {
      console.warn(`[bitrateResol] poll error (transient), continuing:`, err.message);
    }
  }

  // Backstop: kill stragglers if we hit the poll cap.
  if (active.size > 0) await terminateAll([...active.keys()], 'Bitrate Resol backstop timeout');

  // Aggregate → golden_recipes + lab_status_<codec>='COMPLETE'. findWinner picks
  // the lowest bitrate >= threshold from the landed trials (the exact winner).
  try {
    await aggregateGrid(db, episodeId, codec);
    await veCol.updateOne({ episode_id: episodeId }, { $set: { [`lab_finished_at_${codec}`]: nowIso() } });
  } catch (err) {
    console.error(`[bitrateResol] aggregate failed ${episodeId}/${codec}:`, err.message);
    await veCol.updateOne(
      { episode_id: episodeId },
      { $set: { [`lab_status_${codec}`]: 'FAILED', [`lab_error_${codec}`]: `Aggregation failed: ${err.message}` } },
    );
  }
}
