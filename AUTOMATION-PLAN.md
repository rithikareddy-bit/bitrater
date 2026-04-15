# Bitrater Automation Plan — Auto-Pipeline

## Goal

Add two show-level buttons to the existing **Show Overview** page (`/show`):

1. **"Run Pipeline"** — runs the full pipeline (Labs → GCP → Combined URL → QC) for every eligible episode in the selected show. One click, hands-off until done.
2. **"Sync Show"** — syncs all READY_TO_SYNC episodes to showcache in one click.

No separate page. No auto-detection of new shows. The user selects a show from the existing dropdown, clicks "Run Pipeline", monitors progress in the existing episode table, and clicks "Sync Show" when ready.

**Which episodes run?**
- Only episodes that have a non-empty `s3_url` → pipeline runs for those
- Episodes without `s3_url` → marked as SKIPPED ("No s3_url")
- Even if just 1 out of 30 episodes has `s3_url`, pipeline starts for that 1

---

## Verified Pipeline Flow (per episode)

Traced through every API route and backend worker. This is the exact order:

| Step | What Happens | API / System | Precondition | What Gets Written to MongoDB |
|------|-------------|--------------|--------------|------------------------------|
| **1. Run Lab H.264** | Starts AWS Step Function → search_orchestrator → AWS Batch jobs → research worker → aggregator | `POST /api/push` (codec=h264) | `s3_url` exists | `lab_status_h264: "RUNNING"` in `chai_q_lab.video_episodes`. Worker saves `source_fps` (float, 4dp). On completion: `lab_status_h264: "COMPLETE"`, `golden_recipes.resolutions.{res}.h264` |
| **2. Run Lab H.265** | Same pipeline, different codec | `POST /api/push` (codec=h265) | `s3_url` exists | `lab_status_h265: "RUNNING"` → `"COMPLETE"`, `golden_recipes.resolutions.{res}.h265` |
| **3. Wait for labs** | Poll `GET /api/status/{id}` | — | — | — |
| **4. Run GCP H.264** | GCP Transcoder via Step Function | `POST /api/gcp` (codec=h264) | Lab H.264 COMPLETE (`golden_recipes` H.264 + `source_fps`) — does NOT wait for H.265 lab | `gcp_job_status_h264`, `h264_master_m3u8_url` when done |
| **5. Run GCP H.265** | GCP Transcoder via Step Function | `POST /api/gcp` (codec=h265) | Lab H.265 COMPLETE (`golden_recipes` H.265 + `source_fps`) — does NOT wait for H.264 lab | `gcp_job_status_h265`, `h265_master_m3u8_url` when done |
| **6. Generate VTT** | WebP thumbnail sprites + VTT | `POST /api/episode-vtt` | `s3_url` exists | Writes to `master.episode_vtt` collection |
| **7. Wait for GCP** | Poll `GET /api/gcp-status/{id}` | — | — | — |
| **8. Create Combined URL** | Lambda merges H.264 + H.265 master playlists | `POST /api/create-combined-master` | Both `h264_master_m3u8_url` + `h265_master_m3u8_url` ready | `combined_master_m3u8_url` |
| **9. Quality Check** | Lambda checks combined manifest | `POST /api/quality-check/{id}` | `combined_master_m3u8_url` exists | `quality_check.overall: "RUNNING"` → `"PASS"` / `"ISSUES_FOUND"` |
| **10. SYNC (manual)** | Write playback URL + download_config to showcache | `POST /api/sync-showcache-episode` | Combined URL exists | `episodes.$.signed_playback_url`, `episodes.$.download_config` in `master.showcache` |

### Note: FPS Handling

FPS is handled automatically — no upfront check needed:
- **`research-worker/worker.py`** detects FPS via ffprobe during the lab run and writes `source_fps` (float) to `video_episodes`.
- **`/api/gcp`** reads `source_fps` from the lab results — any valid FPS is accepted.
- **GCP Transcoder** uses time-based `gop_duration = Duration(seconds=2)`, so fractional FPS (29.97, 23.976, etc.) works cleanly.

---

## Parallel Worker Configuration

Concurrency limits (configurable):
- **Lab H.264:** 18 parallel episodes
- **Lab H.265:** 12 parallel episodes
- **GCP Transcoder:** 20 max concurrent jobs (both codecs combined — GCP quota: 20/project/region)

These are the defaults. Can be lowered (e.g., set GCP to 2 if quota is tight) but never exceeded.

### How it works:

```
For a show with, say, 50 episodes (all with s3_url):

Step 1+2 (Lab):
  - Launch H.264 lab for up to 18 episodes simultaneously
  - Launch H.265 lab for up to 12 episodes simultaneously
  - H.264 and H.265 run INDEPENDENTLY — an episode's H.264 and H.265 labs run concurrently
  - As one episode's lab finishes, start next episode's lab (sliding window)
  - SLOT BORROWING: when H.264 queue drains and has idle slots, H.265 can use them
    Example: H.264 has only 8 running (10 idle slots) → H.265 expands from 12 to up to 22
    This avoids wasting time while H.264 winds down

Step 4+5 (GCP) — LINKED per codec, capped at MAX_GCP:
  - GCP H.264 starts as soon as Lab H.264 finishes (does NOT wait for H.265 lab)
  - GCP H.265 starts as soon as Lab H.265 finishes (does NOT wait for H.264 lab)
  - Each codec flows independently: Lab → GCP
  - BUT: total active GCP jobs (H.264 + H.265 combined) capped at MAX_GCP (default: 20)
  - If MAX_GCP=20 and 18 GCP jobs running, only 2 more can start — rest queue
  - If MAX_GCP=2, only 2 GCP jobs run at a time regardless of how many labs finish

Step 6 (VTT):
  - Triggered alongside GCP H.264 (when Lab H.264 finishes)

Step 8 (Combined URL):
  - Per episode, once BOTH codecs reach terminal state (SUCCEEDED or FAILED)
  - Both SUCCEEDED → multi-codec combined manifest
  - Either FAILED → episode FAILED (combined URL requires both codecs)
  - Both FAILED → episode FAILED

Step 9 (Quality Check):
  - Per episode, once combined URL exists

Step 10 (Sync):
  - Manual — user clicks button
```

---

## Architecture

Two buttons added to the existing Show Overview page (`/show`), above the episode table:

```
┌──────────────────────────────────────────────────────────────┐
│  /show  (existing page)                                      │
│                                                              │
│  Select Show: [dropdown — existing]                          │
│                                                              │
│  [▶ Run Pipeline]  [Sync Show]     Pipeline: RUNNING (12/30)│
│                                                              │
│  (existing episode table with live status updates)           │
│  Per-episode progress visible in existing columns            │
│  Per-episode + overall time tracking                         │
└──────────────┬───────────────────────────────────────────────┘
               │ "Run Pipeline" calls
┌──────────────▼───────────────────────────────────────────────┐
│  POST /api/auto-pipeline/start                               │
│  Input: { showId }                                           │
│  - Fetches all episodes from showcache                       │
│  - Creates pipeline_run doc (status: RUNNING)                │
│  - Spawns background orchestrator                            │
│  - Returns { runId }                                         │
└──────────────┬───────────────────────────────────────────────┘
               │ spawns
┌──────────────▼───────────────────────────────────────────────┐
│  Pipeline Orchestrator (background, server-side)             │
│                                                              │
│  DURABILITY: the orchestrator is a background poll loop      │
│  running in the App Runner process. It is NOT guaranteed     │
│  to survive restarts (deploys, crashes, scaling events).     │
│                                                              │
│  Restart recovery mechanism:                                 │
│  - On app startup, scan for pipeline_runs with               │
│    status = "RUNNING"                                        │
│  - For each: attempt to acquire run-level lock               │
│  - If acquired: rebuild in-memory state from DB and resume   │
│  - If lock held by another instance: skip (already running)  │
│  - Stale locks (locked_at > 5 min ago) are stolen            │
│                                                              │
│  This means: after a restart, orphaned pipelines resume      │
│  within seconds of the new instance starting. All state is   │
│  in MongoDB — no in-memory-only data is required to resume.  │
│                                                              │
│  FUTURE UPGRADE: for guaranteed delivery, move orchestrator  │
│  to SQS + worker or a Step Function Map state. Current       │
│  design is sufficient for v1 with single App Runner task.    │
│                                                              │
│  Phase 1: LAB (H.264: 18 concurrent, H.265: 12 concurrent)  │
│    - Two pools with SLOT BORROWING                           │
│    - When H.264 queue drains → H.265 borrows idle slots     │
│    - Poll /api/status/{id} every 30s for completion          │
│                                                              │
│  Phase 2: GCP + VTT (LINKED per codec, max 20 concurrent)    │
│    - Lab H.264 done → GCP H.264 + VTT (if slots available)  │
│    - Lab H.265 done → GCP H.265 (if slots available)        │
│    - MAX_GCP caps total active jobs (H.264+H.265 combined)  │
│    - Poll /api/gcp-status/{id} every 30s                     │
│                                                              │
│  Phase 3: COMBINE + QC (per episode, after BOTH GCPs done)   │
│    - Create combined URL                                     │
│    - Run quality check                                       │
│    - Mark READY_TO_SYNC                                      │
│    - Record finished_at + duration_ms                        │
└──────────────────────────────────────────────────────────────┘

"Sync Show" calls:
┌──────────────────────────────────────────────────────────────┐
│  POST /api/auto-pipeline/sync-all                            │
│  Input: { showId }                                           │
│  GAP 6 FIX: do NOT query pipeline_run docs — multiple runs   │
│  may exist for the same show (re-runs are allowed).          │
│  Instead, resolve episodes directly from showcache:          │
│  1. Find show in master.showcache by showId (_id)            │
│  2. Collect all episode IDs from show.episodes[].id          │
│  3. For each ID: read combined_master_m3u8_url from          │
│     chai_q_lab.video_episodes                                │
│  4. Sync those that have a combined URL                      │
│  - Calls POST /api/sync-showcache-episode for each with:      │
│    { episodeId, signedPlaybackUrl: combined_master_m3u8_url }│
│  - Returns { synced: [episodeIds], failed: [episodeIds] }    │
│  (Also updates pipeline_run episode status → SYNCED if a     │
│   matching RUNNING/COMPLETED run exists for this show)       │
└──────────────────────────────────────────────────────────────┘
```

---

## Data Model

### New Collection: `chai_q_lab.pipeline_runs`

```js
{
  _id: ObjectId,
  show_id: String,               // showcache _id
  show_title: String,
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED",
  h264_workers: 18,              // max concurrent H.264 lab jobs
  h265_workers: 12,              // max concurrent H.265 lab jobs
  max_gcp: 20,                   // max concurrent GCP Transcoder jobs (both codecs combined — GCP quota limit)
  locked_by: String | null,       // orchestrator instance ID — ensures single-writer in multi-instance
  locked_at: ISODate | null,      // when lock was acquired — stale lock detection (>5 min = steal)
  created_at: ISODate,
  started_at: ISODate | null,
  finished_at: ISODate | null,
  total_episodes: Number,
  skipped_episodes: Number,      // no s3_url
  episodes: [
    {
      episode_id: String,
      title: String,
      s3_url: String,
      status: "QUEUED" | "SKIPPED" |
              "LAB_RUNNING" |            // at least one lab in progress
              "GCP_RUNNING" |            // labs done, at least one GCP in progress
              "COMBINING" |              // GCPs done, combine + QC in progress
              "READY_TO_SYNC" | "SYNCED" | "FAILED",
      lab_h264_status: "QUEUED" | "STARTING" | "RUNNING" | "COMPLETE" | "FAILED" | "FAILED_FINAL",
      lab_h265_status: "QUEUED" | "STARTING" | "RUNNING" | "COMPLETE" | "FAILED" | "FAILED_FINAL",
      gcp_h264_status: "QUEUED" | "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "FAILED_FINAL" | null,
      gcp_h265_status: "QUEUED" | "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "FAILED_FINAL" | null,
      // STARTING = API called, not yet confirmed via poll
      // RUNNING  = confirmed active via poll response
      current_step: "LAB_H264" | "LAB_H265" | "GCP_H264" | "GCP_H265" | "COMBINE" | "QC" | "DONE",
      retries: { lab_h264: 0, lab_h265: 0, gcp_h264: 0, gcp_h265: 0, combine: 0, qc: 0 },  // retry counts per step
      retry_after_lab_h264: ISODate | null,  // earliest time fillLabSlots() will retry this episode's H.264 lab
      retry_after_lab_h265: ISODate | null,  // earliest time fillLabSlots() will retry this episode's H.265 lab
      retry_after_h264: ISODate | null,      // earliest time startGCP() will retry this episode's H.264 GCP (set on job in gcpQueueH264)
      retry_after_h265: ISODate | null,      // earliest time startGCP() will retry this episode's H.265 GCP (set on job in gcpQueueH265)
      gcp_enqueued_h264: Boolean,   // true once added to persistent GCP queue (prevents re-enqueue)
      gcp_enqueued_h265: Boolean,   // true once added to persistent GCP queue (prevents re-enqueue)
      combined: Boolean,            // true once combine step executed (idempotency — prevents re-combine on crash)
      error: String | null,
      started_at: ISODate | null,
      finished_at: ISODate | null,
      duration_ms: Number | null,
      last_updated_at: ISODate,     // updated on every state transition — detects stuck/dead states
      synced_at: ISODate | null,
      transition_log: [             // ordered log of state transitions for debugging
        { step: String, status: String, at: ISODate }
        // e.g. { step: "LAB_H264", status: "RUNNING", at: ... }
        //      { step: "GCP_H265", status: "FAILED", at: ... }
        //      { step: "GCP_H265", status: "RUNNING", at: ... }  ← retry
      ],
    }
  ],
  // Pipeline-level progress counters (updated each tick, avoids recomputing in UI)
  completed_count: Number,          // episodes in READY_TO_SYNC or SYNCED
  failed_count: Number,             // episodes in FAILED
  running_count: Number,            // episodes currently processing
  skipped_count: Number,            // episodes without s3_url
  eta_ms: Number | null,            // estimated time remaining based on avg episode duration
  gcp_queue_h264: Array,            // persisted GCP queue for crash recovery [{episodeId, codec, withVtt, retry_after}]
  gcp_queue_h265: Array,            // persisted GCP queue for crash recovery
  gcp_paused_until: ISODate | null, // circuit breaker — no new GCP starts until this time
}
```

---

## Orchestrator Logic (Detailed)

```
orchestrate(runId):

  // RUN-LEVEL LOCK — ensures only one orchestrator instance per pipeline
  // Critical in multi-instance (e.g. multiple App Runner tasks)
  instanceId = generateUniqueId()   // e.g. hostname + pid + timestamp
  result = updateOne(
    { _id: runId, $or: [
      { locked_by: null },                                    // not locked
      { locked_at: { $lt: now() - 5 min } }                   // stale lock (crashed instance)
    ]},
    { $set: { locked_by: instanceId, locked_at: now() } }
  )
  if result.matchedCount == 0:
    // Another instance owns this run — exit
    return
  
  // RENEW LOCK every tick (inside poll loop) to prevent stale-lock theft:
  // updateOne({ _id: runId, locked_by: instanceId }, { $set: { locked_at: now() } })
  
  run = load pipeline_run from DB
  
  // NEW BUG A FIX (corrected): determine isFreshStart BEFORE setting started_at.
  // isFreshStart must be checked against the DB value, before we write to it.
  // isResuming (used later for queue init) derives from isFreshStart — NOT from
  // run.started_at after the write, since after the write it is always non-null.
  isFreshStart = (run.started_at == null)
  if isFreshStart:
    updateOne({ _id: runId }, { $set: { started_at: now() } })
    run.started_at = now()
  
  eligible = run.episodes where s3_url exists (all with status QUEUED)
  // Episodes without s3_url already marked SKIPPED at pipeline_run creation
  // Only mark COMPLETED for a fresh start with nothing to do — on resume, episodes
  // have progressed past QUEUED so eligible is empty even though work is in progress.
  if isFreshStart AND eligible is empty → mark run COMPLETED (all episodes skipped)
  
  MAX_RETRIES = 2               // per step per episode
  TIMEOUT_LAB = 2 * 60 * 60    // 2 hours — stuck lab guard
  TIMEOUT_GCP = 1 * 60 * 60    // 1 hour — stuck GCP guard
  TIMEOUT_STARTING = 2 * 60    // 2 min — STARTING state not confirmed → treat as failed
  RETRY_BACKOFF_BASE = 30      // seconds — retry_delay = RETRY_BACKOFF_BASE * retries (avoids hammering APIs)

  ═══════════════════════════════════════════════
  LAB CONFIGURATION (two independent sliding windows)
  ═══════════════════════════════════════════════
  
  # SHARED POOL with codec priorities
  # H.264 gets priority up to its limit (18), H.265 gets its base limit (12)
  # SLOT BORROWING: when H.264 queue drains, H.265 can use idle H.264 slots
  #
  # Example: 30 episodes, h264_workers=18, h265_workers=12
  #   Start:     H.264: 18 running/12 queued, H.265: 12 running/18 queued
  #   Mid-run:   H.264: 8 running/0 queued → H.265 borrows 10 slots → 22 running
  #   Result:    no wasted time — H.265 fills the gap
  
  // Declare ALL in-memory state BEFORE RESUME LOGIC so variables exist when populated.
  // isResuming derives from isFreshStart (computed before started_at was written above).
  // Do NOT use run.started_at here — after the isFreshStart write it is always non-null.
  isResuming = !isFreshStart
  h264Queue = isFreshStart ? [...eligible] : []  // fresh = pre-populated; resume = filled by RESUME LOGIC below
  h265Queue = isFreshStart ? [...eligible] : []
  h264Active = new Set()
  h265Active = new Set()
  
  MAX_H264 = h264Workers          // configured, e.g. 18
  BASE_H265 = h265Workers         // configured, e.g. 12
  
  // PERSISTENT GCP queues — split by codec for round-robin fairness
  // Prevents H.264 (which finishes labs earlier) from starving H.265
  // Stored in DB (run.gcp_queue_h264 / run.gcp_queue_h265) for crash recovery
  // Each entry: { episodeId, codec, withVtt, retry_after }
  gcpQueueH264 = run.gcp_queue_h264 || []   // restored from DB if resuming
  gcpQueueH265 = run.gcp_queue_h265 || []   // restored from DB if resuming
  gcpActiveCount = 0              // maintained via increment/decrement
  MAX_GCP = max_gcp               // configured, e.g. 20 (GCP quota: 20/project/region)

  ═══════════════════════════════════════════════
  RESUME LOGIC (on startup / crash recovery)
  ═══════════════════════════════════════════════
  
  // If orchestrator restarts with a RUNNING pipeline_run,
  // rebuild in-memory state from DB before entering poll loop.
  // All queue/active variables declared above — assignments are valid.
  // On a fresh start this block is skipped entirely.
  
  if isResuming:
    for each episode in run.episodes:
      if lab_h264_status in (STARTING, RUNNING):
        h264Active.add(episode)
      if lab_h265_status in (STARTING, RUNNING):
        h265Active.add(episode)
      if gcp_h264_status in (STARTING, RUNNING):
        gcpActiveCount++
      if gcp_h265_status in (STARTING, RUNNING):
        gcpActiveCount++
      // CRITICAL: check "episodeId not in queue" NOT "not gcp_enqueued_h264".
      // If gcp_enqueued_h264=true but the job was lost from the queue (STEP 4 shift+persist
      // crash window), "not gcp_enqueued_h264" is false → episode permanently stuck.
      // Using "not in queue" recovers both cases: fresh enqueue AND lost-job recovery.
      // Duplicate entries are safe — STEP 4's IDEMPOTENCY GUARD discards them if already STARTING/RUNNING/SUCCEEDED.
      if lab_h264 = COMPLETE AND gcp_h264_status in (null, QUEUED) AND episodeId not in gcpQueueH264:
        gcpQueueH264.push({ episodeId, codec: "h264", withVtt: true, retry_after: episode.retry_after_h264 })
        if not gcp_enqueued_h264: mark gcp_enqueued_h264 = true
        // NOTE: persistQueues() called once after the full loop (below) — batching is safe here.
      if lab_h265 = COMPLETE AND gcp_h265_status in (null, QUEUED) AND episodeId not in gcpQueueH265:
        gcpQueueH265.push({ episodeId, codec: "h265", retry_after: episode.retry_after_h265 })
        if not gcp_enqueued_h265: mark gcp_enqueued_h265 = true
      // Handle mid-tick crash during GCP retry reset (FAILED with retries left, not in queue)
      if gcp_h264_status == FAILED AND retries.gcp_h264 < MAX_RETRIES:
        mark gcp_h264_status → QUEUED
        if episodeId not already in gcpQueueH264:
          // Include retry_after from DB so the backoff window survives the crash
          gcpQueueH264.push({ episodeId, codec: "h264", withVtt: true, retry_after: episode.retry_after_h264 })
      if gcp_h265_status == FAILED AND retries.gcp_h265 < MAX_RETRIES:
        mark gcp_h265_status → QUEUED
        if episodeId not already in gcpQueueH265:
          gcpQueueH265.push({ episodeId, codec: "h265", retry_after: episode.retry_after_h265 })
      if lab_h264_status in (QUEUED, FAILED) AND retries.lab_h264 < MAX_RETRIES:
        // QUEUED = waiting to start or retry pending
        // FAILED (non-final) with retries left = mid-tick crash during retry reset
        if lab_h264_status == FAILED: mark lab_h264_status → QUEUED  // complete the interrupted reset
        h264Queue.push(episode)
      if lab_h265_status in (QUEUED, FAILED) AND retries.lab_h265 < MAX_RETRIES:
        if lab_h265_status == FAILED: mark lab_h265_status → QUEUED
        h265Queue.push(episode)
  
  // Persist any queue changes made during RESUME LOGIC in one batch write.
  // If a second crash happens before this, RESUME LOGIC re-runs idempotently on next start.
  // gcp_enqueued_h264/265 flags were already written inside the loop — if crash happens
  // between those marks and this persist, the duplicate queue entry on re-run is handled
  // by STEP 4's IDEMPOTENCY GUARD (discards start if already STARTING/RUNNING/SUCCEEDED).
  if isResuming:
    persistQueues()
  
  function effectiveH265Limit():
    h264IdleSlots = MAX_H264 - h264Active.size
    h264QueuedRemaining = h264Queue.length
    borrowable = max(0, h264IdleSlots - h264QueuedRemaining)
    return BASE_H265 + borrowable
  
  function startLabH264(episode):
    // ATOMIC MONGO LOCK: updateOne({ episodeId, lab_h264_status: { $nin: ["STARTING", "RUNNING", "COMPLETE"] } }, ...)
    // Prevents duplicate lab runs if orchestrator loop overlaps
    // Only set status → LAB_RUNNING if not already in a later phase (GCP_RUNNING, COMBINING)
    newStatus = episode.status in (QUEUED, SKIPPED) ? "LAB_RUNNING" : episode.status
    // GAP 4 FIX: set started_at on first lab start (if not already set — handles both codecs)
    startedAtUpdate = episode.started_at == null ? { started_at: now() } : {}
    update episode.lab_h264_status → STARTING, current_step → LAB_H264, status → newStatus, ...startedAtUpdate
    log transition: { step: "LAB_H264", status: "STARTING", at: now() }
    update last_updated_at = now()
    call POST /api/push { episodeId, s3Url, codec: "h264" }
    // STARTING → RUNNING confirmed on next poll tick
    h264Active.add(episode)
  
  function startLabH265(episode):
    // ATOMIC MONGO LOCK: same pattern
    newStatus = episode.status in (QUEUED, SKIPPED) ? "LAB_RUNNING" : episode.status
    // GAP 4 FIX: set started_at if not already set (H.264 may have set it first)
    startedAtUpdate = episode.started_at == null ? { started_at: now() } : {}
    update episode.lab_h265_status → STARTING, current_step → LAB_H265, status → newStatus, ...startedAtUpdate
    log transition: { step: "LAB_H265", status: "STARTING", at: now() }
    update last_updated_at = now()
    call POST /api/push { episodeId, s3Url, codec: "h265" }
    h265Active.add(episode)
  
  function fillLabSlots():
    // Process queue with backoff — cooling-down jobs move to back (no head-of-line blocking)
    seen_h264 = 0
    while h264Active.size < MAX_H264 && h264Queue.length > 0 && seen_h264 < h264Queue.length:
      episode = h264Queue.shift()
      if episode.retry_after_lab_h264 AND now() < episode.retry_after_lab_h264:
        h264Queue.push(episode)   // move to back
        seen_h264++
        continue
      startLabH264(episode)
    seen_h265 = 0
    while h265Active.size < effectiveH265Limit() && h265Queue.length > 0 && seen_h265 < h265Queue.length:
      episode = h265Queue.shift()
      if episode.retry_after_lab_h265 AND now() < episode.retry_after_lab_h265:
        h265Queue.push(episode)
        seen_h265++
        continue
      startLabH265(episode)
  
  // Initial fill (skipped if resuming — already populated)
  fillLabSlots()

  ═══════════════════════════════════════════════
  UNIFIED POLL LOOP — ordered mini-phases per tick
  Runs every 30s until all episodes reach terminal state
  (READY_TO_SYNC / SYNCED / SKIPPED / FAILED)
  ═══════════════════════════════════════════════

  while any episode not in terminal state:
    wait 30s
    
    // ┌─────────────────────────────────────────┐
    // │  STEP 1: pollLabs()                     │
    // └─────────────────────────────────────────┘
    
    // RENEW RUN-LEVEL LOCK (prevents stale-lock theft by another instance)
    // Also gate on status != CANCELLED — if user cancels, lock renewal fails → orchestrator exits cleanly.
    // Without this check, setting run.status=CANCELLED has no effect on the running orchestrator.
    result = updateOne(
      { _id: runId, locked_by: instanceId, status: { $ne: 'CANCELLED' } },
      { $set: { locked_at: now() } }
    )
    if result.matchedCount == 0:
      // Lock was stolen (another instance took over) OR pipeline was cancelled
      // Either way: EXIT IMMEDIATELY
      log info: "Exiting orchestrator for runId={runId} — lock lost or pipeline cancelled"
      return
    
    for each episode in h264Active:
      // STARTING timeout — API called but never confirmed
      // TIMEOUT BUG FIX: mark FAILED_FINAL (not FAILED) so continue is safe.
      // FAILED + continue skips the retry logic below → episode stuck in LAB_RUNNING forever.
      // FAILED_FINAL + continue → STEP 7 catches it this same tick → marks episode status → FAILED.
      if lab_h264_status == STARTING AND now() - last_updated_at > TIMEOUT_STARTING:
        mark lab_h264_status → FAILED_FINAL, error: "Lab H.264 never confirmed RUNNING"
        log transition: { step: "LAB_H264", status: "FAILED_FINAL (STARTING timeout)", at: now() }
        h264Active.delete(episode)
        continue
      // General timeout guard — compare against the STARTING transition timestamp
      // (find last LAB_H264/STARTING entry in transition_log)
      if now() - transitionTime("LAB_H264", "STARTING") > TIMEOUT_LAB:
        mark lab_h264_status → FAILED_FINAL, error: "Lab H.264 timed out"
        log transition: { step: "LAB_H264", status: "FAILED_FINAL (lab timeout)", at: now() }
        h264Active.delete(episode)
        continue
      
      status = GET /api/status/{episodeId}?codec=h264
      // Only mark RUNNING when the poll response confirms the job is alive (RUNNING or PENDING).
      // If the first poll returns FAILED/COMPLETE, skip the RUNNING mark entirely — the branch below
      // handles it. Marking RUNNING unconditionally creates spurious log entries on fast failures.
      if lab_h264_status == STARTING AND status.labStatus in (RUNNING, PENDING):
        mark lab_h264_status → RUNNING
        log transition: { step: "LAB_H264", status: "RUNNING", at: now() }
        update last_updated_at = now()
      if lab COMPLETE:
        mark lab_h264_status → COMPLETE
        log transition: { step: "LAB_H264", status: "COMPLETE", at: now() }
        update last_updated_at = now()
        h264Active.delete(episode)
        // Enqueue for GCP (ONCE — persistent queue, flagged to prevent re-enqueue)
        // ORDER: persistQueues() BEFORE marking gcp_enqueued_h264.
        // If crash between the two, gcp_enqueued_h264 is still false → RESUME LOGIC re-adds
        // the entry → IDEMPOTENCY GUARD in STEP 4 discards the duplicate start. Safe.
        // Reversed order (mark first, persist second) → crash leaves gcp_enqueued_h264=true
        // with no queue entry → RESUME LOGIC skips it → episode permanently stuck.
        if not gcp_enqueued_h264:
          gcpQueueH264.push({ episodeId, codec: "h264", withVtt: true })
          persistQueues()          // write queue to DB FIRST
          mark gcp_enqueued_h264 = true   // then mark flag
      if lab FAILED:
        h264Active.delete(episode)
        if episode.retries.lab_h264 < MAX_RETRIES:
          episode.retries.lab_h264++
          // RESET state before retry — clear partial results
          // RETRY BACKOFF: fillLabSlots() skips jobs where now() < retry_after
          // Persist retry_after to DB in the SAME atomic write as the status reset —
          // so crash recovery can read it from run.episodes and preserve the backoff window.
          retryAfter = now() + (RETRY_BACKOFF_BASE * episode.retries.lab_h264)
          mark lab_h264_status → QUEUED, retries.lab_h264 → episode.retries.lab_h264,
               retry_after_lab_h264 → retryAfter   // DB write — not in-memory-only
          log transition: { step: "LAB_H264", status: "RETRY", at: now() }
          h264Queue.push(episode)
        else:
          mark lab_h264_status → FAILED_FINAL
          log transition: { step: "LAB_H264", status: "FAILED_FINAL", at: now() }
        update last_updated_at = now()
    
    for each episode in h265Active:
      // STARTING timeout — same FAILED_FINAL fix as H.264 above
      if lab_h265_status == STARTING AND now() - last_updated_at > TIMEOUT_STARTING:
        mark lab_h265_status → FAILED_FINAL, error: "Lab H.265 never confirmed RUNNING"
        log transition: { step: "LAB_H265", status: "FAILED_FINAL (STARTING timeout)", at: now() }
        h265Active.delete(episode)
        continue
      // General timeout guard — FAILED_FINAL so STEP 7 catches it this tick
      if now() - transitionTime("LAB_H265", "STARTING") > TIMEOUT_LAB:
        mark lab_h265_status → FAILED_FINAL, error: "Lab H.265 timed out"
        log transition: { step: "LAB_H265", status: "FAILED_FINAL (lab timeout)", at: now() }
        h265Active.delete(episode)
        continue
      
      status = GET /api/status/{episodeId}?codec=h265
      if lab_h265_status == STARTING AND status.labStatus in (RUNNING, PENDING):
        mark lab_h265_status → RUNNING
        log transition: { step: "LAB_H265", status: "RUNNING", at: now() }
        update last_updated_at = now()
      if lab COMPLETE:
        mark lab_h265_status → COMPLETE
        log transition: { step: "LAB_H265", status: "COMPLETE", at: now() }
        update last_updated_at = now()
        h265Active.delete(episode)
        if not gcp_enqueued_h265:
          gcpQueueH265.push({ episodeId, codec: "h265" })
          persistQueues()          // persist BEFORE marking flag (same ordering rule as H.264)
          mark gcp_enqueued_h265 = true
      if lab FAILED:
        h265Active.delete(episode)
        if episode.retries.lab_h265 < MAX_RETRIES:
          episode.retries.lab_h265++
          retryAfter = now() + (RETRY_BACKOFF_BASE * episode.retries.lab_h265)
          mark lab_h265_status → QUEUED, retries.lab_h265 → episode.retries.lab_h265,
               retry_after_lab_h265 → retryAfter   // DB write — persists backoff across crashes
          log transition: { step: "LAB_H265", status: "RETRY", at: now() }
          h265Queue.push(episode)
        else:
          mark lab_h265_status → FAILED_FINAL
          log transition: { step: "LAB_H265", status: "FAILED_FINAL", at: now() }
        update last_updated_at = now()
    
    // ┌─────────────────────────────────────────┐
    // │  STEP 2: refillLabSlots()               │
    // └─────────────────────────────────────────┘
    
    fillLabSlots()
    // H.265 automatically gets more slots as H.264 drains (slot borrowing)
    
    // ┌─────────────────────────────────────────┐
    // │  STEP 3: pollGCP()                      │
    // │  POLL FIRST, then start — frees slots   │
    // └─────────────────────────────────────────┘
    
    // gcpActiveCount is recalibrated from DB below (before Step 5)
    // but we still track it here for the poll loop
    
    for each episode with gcp_{codec}_status in (STARTING, RUNNING):
      // STARTING timeout — API called but never confirmed by poll
      // TIMEOUT BUG FIX: mark FAILED_FINAL (not FAILED). FAILED + continue skips the retry
      // logic below → episode stuck in GCP_RUNNING forever with no path to terminal state.
      // FAILED_FINAL + continue → STEP 5 (both codecs terminal) or STEP 7 catches it this tick
      // → marks episode status → FAILED. No manual decrement — gcpActiveCount recalibrated from DB before Step 4.
      if gcp_{codec}_status == STARTING AND now() - last_updated_at > TIMEOUT_STARTING:
        mark gcp_{codec}_status → FAILED_FINAL, error: "GCP never confirmed RUNNING"
        log transition: { step: "GCP_{CODEC}", status: "FAILED_FINAL (STARTING timeout)", at: now() }
        continue
      // General timeout guard — compare against GCP STARTING transition timestamp
      // FAILED_FINAL for same reason — no manual decrement needed
      if now() - transitionTime("GCP_{CODEC}", "STARTING") > TIMEOUT_GCP:
        mark gcp_{codec}_status → FAILED_FINAL, error: "GCP timed out"
        log transition: { step: "GCP_{CODEC}", status: "FAILED_FINAL (GCP timeout)", at: now() }
        continue
      
      poll GET /api/gcp-status/{episodeId}
      for each codec (h264, h265) in response:
        // Confirm STARTING → RUNNING on first successful poll
        if gcp_{codec}_status == STARTING AND gcp_job_status in (RUNNING, PENDING):
          mark gcp_{codec}_status → RUNNING
          log transition: { step: "GCP_{CODEC}", status: "RUNNING", at: now() }
        if gcp_job_status = SUCCEEDED:
          update gcp_{codec}_status → SUCCEEDED
          // NO manual gcpActiveCount-- here. Recalibrated from DB before Step 4.
          log transition: { step: "GCP_{CODEC}", status: "SUCCEEDED", at: now() }
          update last_updated_at = now()
        if gcp_job_status = FAILED:
          // NO manual gcpActiveCount-- here. Recalibrated from DB before Step 4.
          if episode.retries.gcp_{codec} < MAX_RETRIES:
            episode.retries.gcp_{codec}++
            // Reset status before retry
            // RETRY BACKOFF: delay = RETRY_BACKOFF_BASE * retries (e.g. 30s, 60s)
            // Persist retry_after to DB in the SAME write as the status reset
            // so RESUME LOGIC can include it in the re-queued job entry on crash recovery.
            retryAfter = now() + (RETRY_BACKOFF_BASE * episode.retries.gcp_{codec})
            mark gcp_{codec}_status → QUEUED, retries.gcp_{codec} → episode.retries.gcp_{codec},
                 retry_after_{codec} → retryAfter   // DB write
            log transition: { step: "GCP_{CODEC}", status: "RETRY", at: now() }
            if codec == "h264":
              gcpQueueH264.push({ episodeId, codec: "h264", withVtt: true, retry_after: retryAfter })
            else:
              gcpQueueH265.push({ episodeId, codec: "h265", retry_after: retryAfter })
            persistQueues()   // persist re-enqueued retry job immediately — crash safety
          else:
            mark gcp_{codec}_status → FAILED_FINAL
            log transition: { step: "GCP_{CODEC}", status: "FAILED_FINAL", at: now() }
          update last_updated_at = now()
    
    // ┌─────────────────────────────────────────┐
    // │  STEP 4: startGCP()                     │
    // │  Start new jobs from persistent queue   │
    // └─────────────────────────────────────────┘
    
    // RECALIBRATE gcpActiveCount — single source of truth from DB
    // Prevents drift from crashes, missed updates, or edge cases
    gcpActiveCount = count of episodes where gcp_{any_codec}_status in (STARTING, RUNNING)
    
    // CIRCUIT BREAKER CHECK: skip starting new GCP jobs if paused
    // (polling, lock renewal, labs, combine, QC all continue normally)
    if run.gcp_paused_until AND now() < run.gcp_paused_until:
      // skip Step 4 entirely — resume next tick when pause expires
    else:
    // Round-robin: alternate between H.264 and H.265 queues for fairness
    // Prevents early-finishing H.264 labs from starving H.265 GCP slots
    // If only one queue has items, drain it directly (no wasted iterations)
    // Track items seen to prevent infinite loop when all items are cooling down
    seenH264 = 0; seenH265 = 0
    while gcpActiveCount < MAX_GCP AND (gcpQueueH264.length > seenH264 OR gcpQueueH265.length > seenH265):
      // Take from H.264 queue (if it has items)
      if gcpQueueH264.length > seenH264 AND gcpActiveCount < MAX_GCP:
        job = gcpQueueH264.shift()
        // RETRY BACKOFF: if cooldown hasn't elapsed, move to back of queue (avoids head-of-line blocking)
        if job.retry_after AND now() < job.retry_after:
          gcpQueueH264.push(job)   // move to back — other jobs can proceed
          persistQueues()          // persist push-back immediately
          seenH264++
        else:
          // IDEMPOTENCY GUARD: skip if already starting/running/succeeded (race protection)
          if gcp_h264_status in (STARTING, RUNNING, SUCCEEDED):
            // already in progress — discard this queue entry (no persistQueues needed — shift already removes it)
          else:
            // ATOMIC MONGO LOCK: updateOne({ _id, gcp_h264_status: { $nin: ["STARTING","RUNNING","SUCCEEDED"] } },
            //   { $set: { gcp_h264_status: "STARTING" } })
            // Only proceeds if update matched — prevents duplicate API calls
            persistQueues()         // persist the shift (job removed from DB queue) BEFORE marking STARTING
            // If crash here: queue empty, gcp_h264_status=QUEUED → RESUME LOGIC recovery catches it
            mark gcp_h264_status → STARTING
            gcpRes = call POST /api/gcp { episodeId: job.episodeId, codec: "h264" }
            // GAP 5 FIX: handle 409 (job already active in video_episodes — treat as already running)
            if gcpRes.status == 409:
              mark gcp_h264_status → RUNNING   // already confirmed active — start polling it
              log transition: { step: "GCP_H264", status: "RUNNING (via 409)", at: now() }
              gcpActiveCount++
            elif gcpRes.status >= 400:
              // BUG K FIX: API error (e.g. 500, 400) — job was NOT started.
              // Revert STARTING → QUEUED and skip for this tick so it retries next tick.
              // IMPORTANT: use push() to back + seenH264++ (same pattern as retry_after path above).
              // Using unshift() without incrementing seenH264 would cause an infinite loop in this tick.
              mark gcp_h264_status → QUEUED
              gcpQueueH264.push(job)   // move to back — skip for remainder of this tick
              persistQueues()          // persist the push-back
              seenH264++
              log warning: "POST /api/gcp (h264) failed ({gcpRes.status}) for {job.episodeId}, reverting to QUEUED"
              // do NOT increment gcpActiveCount
            else:
              // STARTING → RUNNING confirmed on next poll tick
              if job.withVtt:
                // BUG 1 FIX: fire & forget — do NOT await. VTT worker has a 900s sync timeout.
                // Detach the promise entirely so it never blocks the poll tick.
                fireAndForget(fetch('/api/episode-vtt', { method: 'POST',
                  body: JSON.stringify({ episodeId: job.episodeId }) }))
              mark current_step → GCP_H264, status → GCP_RUNNING
              log transition: { step: "GCP_H264", status: "STARTING", at: now() }
              gcpActiveCount++
              // (queue already persisted above before marking STARTING)
      
      // Take from H.265 queue
      if gcpQueueH265.length > seenH265 AND gcpActiveCount < MAX_GCP:
        job = gcpQueueH265.shift()
        if job.retry_after AND now() < job.retry_after:
          gcpQueueH265.push(job)   // move to back
          persistQueues()
          seenH265++
        else:
          if gcp_h265_status in (STARTING, RUNNING, SUCCEEDED):
            // already in progress — discard
          else:
            // ATOMIC MONGO LOCK: same pattern
            persistQueues()         // persist the shift before marking STARTING (same as H.264)
            mark gcp_h265_status → STARTING
            gcpRes = call POST /api/gcp { episodeId: job.episodeId, codec: "h265" }
            // GAP 5 FIX: handle 409 same as H.264 above
            if gcpRes.status == 409:
              mark gcp_h265_status → RUNNING
              log transition: { step: "GCP_H265", status: "RUNNING (via 409)", at: now() }
              gcpActiveCount++
            elif gcpRes.status >= 400:
              // BUG K FIX: same as H.264 — revert to QUEUED, push to back, increment seenH265
              mark gcp_h265_status → QUEUED
              gcpQueueH265.push(job)
              persistQueues()
              seenH265++
              log warning: "POST /api/gcp (h265) failed ({gcpRes.status}) for {job.episodeId}, reverting to QUEUED"
            else:
              mark current_step → GCP_H265, status → GCP_RUNNING
              log transition: { step: "GCP_H265", status: "STARTING", at: now() }
              gcpActiveCount++
              // (queue already persisted above)
    // Remaining items stay in their queues for next tick
    
    // ┌─────────────────────────────────────────┐
    // │  STEP 5: runCombine()                   │
    // │  REQUIRES BOTH codecs to succeed        │
    // └─────────────────────────────────────────┘
    
    for each episode where combined == false:
      // FAILED_FINAL = exhausted all retries. FAILED (without _FINAL) = may still retry
      // Only evaluate when both codecs have reached a TERMINAL state
      h264_done = gcp_h264 in (SUCCEEDED, FAILED_FINAL)
      h265_done = gcp_h265 in (SUCCEEDED, FAILED_FINAL)
      
      if not (h264_done AND h265_done): continue   // wait — a FAILED codec may still retry
      
      // If EITHER codec failed → episode FAILED (combined URL requires both)
      if gcp_h264 = FAILED_FINAL OR gcp_h265 = FAILED_FINAL:
        mark episode status → FAILED
        error: gcp_h264 = FAILED_FINAL ? "H.264 GCP failed" : "H.265 GCP failed"
        continue
      
      // Both SUCCEEDED — verify URLs exist before combining (eventual consistency guard)
      // MINOR 8 FIX: read URLs from gcp-status response cached in this tick (already fetched in
      // STEP 3) rather than a separate DB query. If not cached, read from video_episodes directly.
      if not h264_master_m3u8_url: continue   // wait for URL to appear in DB
      if not h265_master_m3u8_url: continue   // wait for URL to appear in DB
      
      // Both codecs succeeded + both URLs ready → create combined manifest
      combineRes = call POST /api/create-combined-master { episodeId }
      if combineRes.status != 200:
        // create-combined-master failed — MINOR E FIX: cap retries to avoid infinite loop
        episode.retries.combine++
        if episode.retries.combine > MAX_RETRIES:
          mark episode status → FAILED, error: "create-combined-master failed after max retries"
          continue
        log warning: "create-combined-master failed for {episodeId} (attempt {retries.combine}): {combineRes.error}"
        continue   // will retry on next tick (combined still false)
      
      // BUG #3 FIX: write combined=true AND status→COMBINING in ONE atomic DB update.
      // Previously: combined=true was written first, then status→COMBINING separately.
      // Crash between the two left the episode in GCP_RUNNING with combined=true —
      // invisible to both STEP 5 (skips combined=true) and STEP 6 (skips non-COMBINING).
      // Atomic write eliminates this crash window entirely.
      updateOne({ _id: runId, 'episodes.$.episode_id': episodeId }, { $set: {
        'episodes.$.combined': true,
        'episodes.$.status': 'COMBINING',
        'episodes.$.current_step': 'QC',
        'episodes.$.last_updated_at': now()
      }})
      log transition: { step: "COMBINE", status: "DONE", at: now() }
      
      // Trigger QC — BUG 2 FIX: check POST response; do NOT enter null-poll loop on failure
      qcRes = call POST /api/quality-check/{episodeId}
      if qcRes.status != 200:
        // QC POST failed (e.g. Lambda not configured) — treat immediately as QC failure
        // status is already COMBINING (set atomically above) — STEP 6 will pick it up.
        if episode.retries.qc < MAX_RETRIES:
          episode.retries.qc++
          log transition: { step: "QC", status: "POST_FAILED (retry)", at: now() }
          // STEP 6 crash-recovery guard will re-attempt QC POST next tick
          // (combined=true AND quality_check.overall=null → re-trigger)
        else:
          // Exhausted QC retries — mark READY_TO_SYNC anyway (valid URL exists)
          update status → READY_TO_SYNC, current_step → DONE
          record finished_at = now()
          record duration_ms = finished_at - started_at
          log transition: { step: "QC", status: "SKIPPED (POST failed, max retries)", at: now() }
      // else: status already COMBINING — STEP 6 will poll QC next tick
    
    // ┌─────────────────────────────────────────┐
    // │  STEP 6: pollQC()                       │
    // └─────────────────────────────────────────┘
    
    for each episode with status COMBINING:
      // NEW BUG C FIX: quality_check.overall lives in video_episodes, NOT pipeline_run.
      // Must call GET /api/quality-check first to get the value — it cannot be read
      // from the in-memory episode object. The GET IS the poll; always call it first.
      qcResult = GET /api/quality-check/{episodeId}
      quality_check_overall = qcResult?.overall ?? null
      
      // BUG 2 FIX (crash recovery): if combined=true AND overall=null, QC was never
      // triggered (crash between mark combined=true and QC POST), OR QC POST failed
      // and retries remain. Re-trigger QC instead of waiting on null forever.
      if quality_check_overall == null AND episode.combined == true:
        qcRes = call POST /api/quality-check/{episodeId}
        if qcRes.status != 200:
          if episode.retries.qc < MAX_RETRIES:
            episode.retries.qc++
            log transition: { step: "QC", status: "POST_FAILED (retry)", at: now() }
          else:
            update status → READY_TO_SYNC, current_step → DONE
            record finished_at = now(), duration_ms = finished_at - started_at
            log transition: { step: "QC", status: "SKIPPED (POST failed, max retries)", at: now() }
        // Either way, skip result processing this tick — wait for next tick
        continue
      
      // Normal poll result handling
      if quality_check_overall = "PASS" or "ISSUES_FOUND":
        update status → READY_TO_SYNC, current_step → DONE
        record finished_at = now()
        record duration_ms = finished_at - started_at
      if quality_check_overall = "RUNNING":
        continue polling
      if quality_check_overall = null:
        // null AND combined=false should not reach here (handled above)
        // null AND combined=true handled by crash-recovery guard above
        // Defensive: log and skip
        log warning: "Unexpected null QC status for {episodeId} — combined={combined}"
        continue
      if quality_check_overall = "FAILED":
        if episode.retries.qc < MAX_RETRIES:
          episode.retries.qc++
          qcRetryRes = call POST /api/quality-check/{episodeId}   // retry QC
          if qcRetryRes.status != 200:
            // retry POST also failed — will re-enter this branch next tick
            log warning: "QC retry POST failed for {episodeId}"
        else:
          // QC failed but we still have a valid URL — mark READY_TO_SYNC
          update status → READY_TO_SYNC, current_step → DONE
          record finished_at, duration_ms
          // (user can investigate QC issues before syncing)
    
    // ┌─────────────────────────────────────────┐
    // │  STEP 7: checkEpisodeFailures()         │
    // │  Only FAIL if EITHER codec permanently   │
    // │  failed — both required for combine     │
    // └─────────────────────────────────────────┘
    
    for each episode in (LAB_RUNNING, GCP_RUNNING):
      // Combined URL requires both codecs — either failing is fatal
      // Check BOTH lab and GCP statuses — fail early to free slots
      if lab_h264 = FAILED_FINAL OR lab_h265 = FAILED_FINAL:
        failed_codec = lab_h264 = FAILED_FINAL ? "H.264" : "H.265"
        mark episode → FAILED, error: "{failed_codec} lab failed"
        // If the other codec's GCP is still RUNNING, it's wasting a slot on a doomed episode
        // gcpActiveCount will be recalibrated next tick from DB
      if gcp_h264 = FAILED_FINAL OR gcp_h265 = FAILED_FINAL:
        failed_codec = gcp_h264 = FAILED_FINAL ? "H.264" : "H.265"
        mark episode → FAILED, error: "{failed_codec} GCP failed"
    
    // ┌─────────────────────────────────────────┐
    // │  STEP 8: updateProgressCounters()       │
    // └─────────────────────────────────────────┘
    
    // Update pipeline-level counters (cheap — avoids frontend recomputing)
    run.completed_count = count of episodes in (READY_TO_SYNC, SYNCED)
    run.failed_count = count of episodes in FAILED
    run.running_count = count of episodes in (LAB_RUNNING, GCP_RUNNING, COMBINING)
    run.skipped_count = count of episodes in SKIPPED
    
    // NOTE: GCP queues are persisted to DB INLINE after every mutation
    // (shift, push, retry enqueue) — not batched at end of tick.
    // This ensures exact resume after mid-tick crash, not approximate.
    // Implementation: helper function persistQueues() called after each mutation:
    //   function persistQueues():
    //     updateOne({ _id: runId }, { $set: {
    //       gcp_queue_h264: gcpQueueH264,
    //       gcp_queue_h265: gcpQueueH265
    //     }})
    // Called in: Step 1 (enqueue after lab complete), Step 3 (re-enqueue on retry),
    //            Step 4 (shift + push-back on backoff), Step 4 (shift on start)
    
    // CIRCUIT BREAKER: pause GCP scheduling (non-blocking — polling + lock renewal continue)
    // MINOR 7 FIX: count per-codec completions (not per-episode) — each episode has 2 GCP jobs.
    // A single episode contributing 1 h264 failure + 1 h265 failure = 2 results counted.
    recent_gcp_codec_results = [
      ...episodes where gcp_h264_status finished (SUCCEEDED/FAILED/FAILED_FINAL) in last 10 min
          → each maps to { codec: "h264", status: gcp_h264_status },
      ...episodes where gcp_h265_status finished in last 10 min
          → each maps to { codec: "h265", status: gcp_h265_status }
    ]
    if recent_gcp_codec_results.length >= 5:
      failure_rate = count(status in FAILED or FAILED_FINAL) / recent_gcp_codec_results.length
      if failure_rate > 0.5:
        run.gcp_paused_until = now() + 5 minutes
        log warning: "Circuit breaker: >50% GCP failure rate, pausing new GCP starts until {gcp_paused_until}"
    
    // STUCK DETECTION: flag episodes with no state change in 10+ minutes
    for each episode where status not in terminal state:
      if now() - last_updated_at > 10 minutes:
        log warning: "Episode {episodeId} stuck at {current_step} for 10+ min"
        // (doesn't auto-fail — just surfaces for debugging via transition_log)
    
    // PIPELINE ETA: compute estimated time remaining
    finished_episodes = episodes where finished_at != null
    if finished_episodes.length > 0:
      avg_duration = avg(finished_episodes.map(e => e.duration_ms))
      remaining = run.running_count
      run.eta_ms = avg_duration * remaining
    
    save run to DB
  
  ═══════════════════════════════════════════════
  DONE — Mark pipeline_run as COMPLETED
  ═══════════════════════════════════════════════
  
  // All episodes are in terminal state — while loop exited.
  // CRITICAL: write COMPLETED status + finished_at and release the lock.
  // Without this: run stays RUNNING → recoverOrphanedPipelines() re-resumes it on every
  // server restart → "Run Pipeline" button stays disabled for this show permanently.
  updateOne({ _id: runId, locked_by: instanceId }, {
    $set: {
      status: 'COMPLETED',
      finished_at: now(),
      locked_by: null,
      locked_at: null
    }
  })
  log info: "Pipeline {runId} completed"
  
  // User sees all episodes as READY_TO_SYNC in the /show episode table
  // User clicks "Sync Show" button to sync all ready episodes at once
```

---

## New API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auto-pipeline/start` | POST | Start pipeline. Input: `{ showId }`. Creates `pipeline_run`, spawns orchestrator, returns `{ runId }` |
| `/api/auto-pipeline/status/[runId]` | GET | Poll full pipeline status (frontend polls this every 10s) |
| `/api/auto-pipeline/sync-all` | POST | Sync all READY_TO_SYNC episodes. Input: `{ showId }` |
| `/api/auto-pipeline/cancel` | POST | Cancel pipeline. Input: `{ runId }` |

### Start API behavior

```
POST /api/auto-pipeline/start { showId }

1. Guard: find pipeline_runs where show_id = showId AND status = 'RUNNING'
   - If exists → return 409 { error: "Pipeline already running for this show", runId: existing._id }
   - (Prevents duplicate orchestrators for the same show, regardless of button state)

2. Fetch show from master.showcache by _id = showId
   - Not found → 404

3. Collect all episodes from show.episodes[]
   - Filter eligible: those with non-empty s3_url
   - If eligible is empty → return 400 { error: "No eligible episodes (no s3_url found)" }

4. Build pipeline_run.episodes array:
   - eligible episodes → { episode_id, title, s3_url, status: "QUEUED", lab_h264_status: "QUEUED",
       lab_h265_status: "QUEUED", gcp_h264_status: null, gcp_h265_status: null,
       retries: { lab_h264:0, lab_h265:0, gcp_h264:0, gcp_h265:0, combine:0, qc:0 },
       retry_after_lab_h264: null, retry_after_lab_h265: null,
       retry_after_h264: null, retry_after_h265: null,
       gcp_enqueued_h264: false, gcp_enqueued_h265: false, combined: false,
       current_step: "LAB_H264", error: null, started_at: null, finished_at: null,
       duration_ms: null, last_updated_at: now(), synced_at: null, transition_log: [] }
   - ineligible episodes → { ..., status: "SKIPPED", error: "No s3_url" }

5. Insert pipeline_run:
   { show_id: showId, show_title: show.title, status: "RUNNING",
     h264_workers: 18, h265_workers: 12, max_gcp: 20,
     locked_by: null, locked_at: null,
     created_at: now(), started_at: null, finished_at: null,
     total_episodes: episodes.length, skipped_episodes: ineligible.length,
     episodes: [...],
     completed_count: 0, failed_count: 0,
     running_count: 0, skipped_count: ineligible.length,
     eta_ms: null, gcp_queue_h264: [], gcp_queue_h265: [], gcp_paused_until: null }

6. Spawn orchestrator in background: setImmediate(() => orchestrate(runId))

7. Return 200 { runId }
```

### Sync-All API behavior

```
POST /api/auto-pipeline/sync-all { showId }

1. Find show in master.showcache by _id = showId → 404 if not found

2. Collect episode IDs from show.episodes[].id

3. For each episodeId: read combined_master_m3u8_url from chai_q_lab.video_episodes
   - Build list: only those with a non-empty combined_master_m3u8_url

4. If none have a combined URL → return 400 { error: "No episodes ready to sync" }

5. For each episode with a combined URL:
   - POST /api/sync-showcache-episode { episodeId, signedPlaybackUrl: combined_master_m3u8_url }
   - On 200: add to synced[]
   - On error: add to failed[] with error message

6. For each synced episodeId: update pipeline_run (if any RUNNING/COMPLETED run exists for this show):
   - updateOne({ show_id: showId, 'episodes.episode_id': episodeId },
               { $set: { 'episodes.$.status': 'SYNCED', 'episodes.$.synced_at': now() } })
   - (Best-effort — don't fail the sync if no pipeline_run exists or update fails)

7. Return { synced: [episodeIds], failed: [{ episodeId, error }] }
```

### Cancel API behavior

```
POST /api/auto-pipeline/cancel { runId }

1. updateOne({ _id: runId, status: 'RUNNING' }, { $set: { status: 'CANCELLED', finished_at: now() } })
   - If matchedCount == 0: run not found or not RUNNING → return 409 "Pipeline not running"
2. Return { ok: true }

Orchestrator self-exits on its next tick via the lock renewal check
(lock renewal now gates on status != CANCELLED — see orchestrator logic).
Episodes are left in their current state — no forced FAILED marks needed.
In-flight Lab/GCP jobs continue running externally (SFN jobs are not stopped);
they will simply never be polled again. That is acceptable for a manual cancel.
```

---

## UI: Show Overview Page (`/show`)

Two buttons added above the existing episode table, next to the show selector:

```
┌──────────────────────────────────────────────────────────────────────┐
│  ← Catalog    Show overview                                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Select Show: [dropdown — existing]     [Show Stats Panel — existing]│
│                                                                      │
│  [▶ Run Pipeline]  [Sync Show]      Pipeline: RUNNING (12/30 done)  │
│                                                                      │
│  (existing episode table — already has Lab H.264, Lab H.265,        │
│   Golden, QC, GCP columns with live status updates every 15s)       │
│                                                                      │
│  Progress is visible in the existing table — no new columns needed. │
│  The existing live-polling already shows per-episode status.         │
└──────────────────────────────────────────────────────────────────────┘
```

### Button States

**"Run Pipeline" button:**
- Default: `▶ Run Pipeline` (green) — enabled when a show is selected
- Running: `Pipeline Running... (12/30)` (yellow, pulsing) — disabled, shows progress
- Already has a RUNNING pipeline_run → disabled with tooltip "Pipeline already running"
- All episodes already READY_TO_SYNC or SYNCED → disabled with tooltip "Already complete"

**"Sync Show" button:**
- Default: `Sync Show` (blue) — enabled when at least 1 episode is READY_TO_SYNC
- No episodes ready → disabled (greyed out)
- Running: `Syncing... (5/12)` — disabled, shows progress
- After sync: shows count of synced episodes

---

## Files to Create/Modify

### New files:
| File | Purpose |
|------|---------|
| `dashboard/app/api/auto-pipeline/start/route.js` | Start pipeline for a show |
| `dashboard/app/api/auto-pipeline/status/[runId]/route.js` | Poll pipeline status |
| `dashboard/app/api/auto-pipeline/sync-all/route.js` | Sync all ready episodes for a show |
| `dashboard/app/api/auto-pipeline/cancel/route.js` | Cancel a running pipeline |
| `dashboard/lib/pipelineOrchestrator.js` | Core orchestration logic |
| `dashboard/lib/pipelineRecovery.js` | Recovery logic — `recoverOrphanedPipelines()` scans for pipeline_runs with status=RUNNING, acquires lock, rebuilds in-memory state from DB, and resumes the orchestrator |
| `dashboard/instrumentation.ts` | **BUG 3 FIX**: Next.js App Router startup hook. Calls `recoverOrphanedPipelines()` on server start. Required — there is no other startup lifecycle in App Router. Implementation: `export async function register() { if (process.env.NEXT_RUNTIME === 'nodejs') { const { recoverOrphanedPipelines } = await import('./lib/pipelineRecovery'); await recoverOrphanedPipelines(); } }` |

### Modified files:
| File | Change |
|------|--------|
| `dashboard/app/show/page.js` | Add "Run Pipeline" and "Sync Show" buttons, pipeline status indicator, wire up to new APIs |

### No new pages. No layout changes.

---

## Time Tracking

Per episode:
- `started_at` — when lab jobs begin
- `finished_at` — when it reaches READY_TO_SYNC
- `duration_ms` — `finished_at - started_at`

Per pipeline run:
- `started_at` — when orchestrator starts labs
- `finished_at` — when all episodes reach terminal state (READY_TO_SYNC / FAILED / SKIPPED)
- Total wall-clock displayed live on the page

---

## Edge Cases

| Edge case | Handling |
|-----------|----------|
| Episode has no `s3_url` | SKIPPED with message "No s3_url" |
| Lab already running (409 from `/api/push`) | Poll and wait for existing run to finish |
| GCP already running (409 from `/api/gcp`) | Poll and wait for existing run to finish |
| VTT worker down (502) | Log warning, continue — VTT is non-blocking |
| Quality check Lambda not configured | Skip QC, still mark READY_TO_SYNC |
| Page closed / navigated away mid-pipeline | Orchestrator continues server-side; page shows status on return |
| Show has 0 episodes with s3_url | Reject with "No eligible episodes" |
| Pipeline already running for this show | "Run Pipeline" button disabled, shows current progress |
| Both labs complete but one has no golden_recipes | Mark episode FAILED for GCP step |
| One codec lab/GCP fails, other succeeds | Episode FAILED — combined URL requires both codecs |
| Both codec labs/GCPs fail | Episode FAILED — no playback URL possible |
| Transient lab/GCP/QC failure | Retry up to 2 times per step before marking permanent failure |
| Lab running > 2 hours | Timeout guard → mark FAILED_FINAL (no retry — protects against stuck jobs; STEP 7 marks episode FAILED same tick) |
| GCP running > 1 hour | Timeout guard → mark FAILED_FINAL (no retry; STEP 5/STEP 7 marks episode FAILED same tick) |
| GCP slots full (gcpActiveCount >= MAX_GCP) | Jobs stay in persistent gcpQueueH264/gcpQueueH265, start on next tick via round-robin when slots free up |
| Orchestrator crashes / server restarts mid-run | Resume logic rebuilds h264Active, h265Active, gcpQueueH264, gcpQueueH265, gcpActiveCount from DB state |
| sync-showcache-episode: signedPlaybackUrl mismatch | Route validates URL matches combined_master_m3u8_url — sync-all must read it fresh from DB |
| Re-running pipeline on a show that already ran | Allow it — creates a new pipeline_run doc, re-runs all steps (labs may 409 if still running) |
| QC returns ISSUES_FOUND | Still mark READY_TO_SYNC — user decides whether to sync or investigate |

---

## Detailed End-to-End Flowchart

### 1. User Action → Pipeline Start

```
USER on /show page
    │
    ├── Selects show from dropdown
    │
    ▼
[▶ Run Pipeline] button clicked
    │
    ▼
POST /api/auto-pipeline/start { showId }
    │
    ├── Fetch all episodes from master.showcache
    ├── Filter: only episodes with non-empty s3_url
    ├── No s3_url episodes → mark SKIPPED ("No s3_url")
    ├── Create pipeline_run doc in chai_q_lab.pipeline_runs
    │     status: "RUNNING", created_at: now()
    ├── Return { runId } to frontend
    │
    ▼
Spawn background orchestrator(runId)
Frontend polls GET /api/auto-pipeline/status/{runId} every 10s
```

### 2. Phase 1 — Labs (unified poll loop begins)

```
INITIAL FILL:
    H.264 pool: min(18, eligible.length) episodes started
    H.265 pool: min(12, eligible.length) episodes started

For each episode started:
    │
    ▼
POST /api/push { episodeId, s3Url, codec: "h264" }
    │
    ├── Checks for existing RUNNING lab → 409 if active
    ├── Starts SFN: Chai-Q-Orchestrator-H264
    │     └── search_orchestrator.py → AWS Batch jobs → research-worker
    │         └── worker.py: downloads S3 → two-pass FFmpeg encode → VMAF
    │         └── Writes source_fps (float) to video_episodes
    │         └── aggregator picks golden recipe per resolution
    ├── Sets lab_status_h264: "RUNNING"
    ├── Returns { executionArn }
    │
    ▼
(Same for H.265 with Chai-Q-Orchestrator-H265)

═══════════════════════════════════════════════
POLL LOOP — ordered mini-phases per 30s tick
(runs until all episodes reach terminal state)
═══════════════════════════════════════════════

Every 30s tick:
    │
    ├── STEP 1: POLL LABS ─────────────────────────────────
    │   For each active H.264 lab:
    │     Timeout check: if running > 2 hours → FAILED_FINAL (STEP 7 marks episode FAILED same tick)
    │     GET /api/status/{episodeId}?codec=h264
    │     │
    │     ├── COMPLETE → lab_h264_status: COMPLETE
    │     │     └── Enqueue ONCE to persistent gcpQueueH264
    │     │         (gcp_enqueued_h264 flag prevents duplicates)
    │     ├── FAILED →
    │     │     └── retries < 2? → re-queue to h264Queue (retry)
    │     │     └── retries >= 2? → lab_h264_status: FAILED_FINAL
    │     └── RUNNING → continue polling
    │
    │   (Same for H.265)
    │
    ├── STEP 2: REFILL LAB SLOTS ──────────────────────────
    │   Fill H.264 first, then H.265 with SLOT BORROWING
    │   (H.265 limit = base_12 + idle_h264_slots)
    │
    ├── STEP 3: POLL GCP (BEFORE starting new jobs!) ──────
    │   ⚠️ Poll FIRST so freed slots are available for Step 4
    │   For each episode with gcp_h264 or gcp_h265 RUNNING:
    │     Timeout check: if running > 1 hour → FAILED_FINAL (STEP 5/7 marks episode FAILED same tick)
    │     GET /api/gcp-status/{episodeId}
    │     │
    │     ├── SUCCEEDED → mark status, gcpActiveCount recalibrated from DB
    │     ├── FAILED →
    │     │     └── retries < 2? → re-enqueue to gcpQueueH264/H265 (retry)
    │     │     └── retries >= 2? → gcp_{codec}_status: FAILED_FINAL
    │     └── RUNNING/PENDING → continue polling
    │
    │   Note: gcp-status route auto-detects SFN failures
    │   (FAILED/TIMED_OUT/ABORTED) and writes them to DB
    │
    ├── STEP 4: START GCP (from persistent queue) ─────────
    │   Round-robin from gcpQueueH264 / gcpQueueH265:
    │   while either queue not empty AND gcpActiveCount < MAX_GCP:
    │     │
    │     ▼
    │   POST /api/gcp { episodeId, codec }
    │     ├── Validates golden_recipes + source_fps
    │     ├── Starts SFN: GCP-Orchestrator
    │     │     └── gcp_copy_s3_to_gcs.py → gcp_transcoder.py
    │     │           ├── frame_rate: source_fps (float)
    │     │           ├── gop_duration: 2s (time-based)
    │     │           └── Output: fMP4 + HLS manifest
    │     │     └── gcp_check_status.py → gcp_finalize_hls.py
    │     ├── Sets gcp_job_status_{codec}: "RUNNING"
    │     └── gcpActiveCount++
    │
    │   If job.withVtt (H.264 only):
    │     fireAndForget(fetch('/api/episode-vtt', ...))
    │     ⚠️ BUG 1 FIX: /api/episode-vtt awaits worker up to 900s.
    │     Must be fully detached (no await, no .then()) so it
    │     never blocks the poll tick. Errors are logged by the
    │     route itself; orchestrator does not observe them.
    │
    │   If gcpActiveCount >= MAX_GCP → rest stays in gcpQueue
    │
    ├── STEP 5: COMBINE (requires BOTH codecs) ─────────────
    │   For each episode where BOTH codecs reached terminal:
    │     │
    │     ├── Both SUCCEEDED → verify both URLs exist →
    │     │     POST /api/create-combined-master { episodeId }
    │     │       └── non-200? log + continue (retry next tick)
    │     │     atomic write: combined=true + status→COMBINING (before QC POST)
    │     │     qcRes = POST /api/quality-check/{episodeId}
    │     │       └── non-200? treat as QC failure immediately
    │     │             retries < 2? retry next tick (STEP 6 crash-recovery re-POSTs)
    │     │             else? mark READY_TO_SYNC (valid URL exists)
    │     │     200? STEP 6 polls QC result next tick (status already COMBINING)
    │     │
    │     └── Either FAILED → episode FAILED
    │           (combined URL requires both H.264 + H.265)
    │
    ├── STEP 6: POLL QC ───────────────────────────────────
    │   Crash recovery guard: if combined=true AND overall=null
    │     → QC was never triggered — re-POST before polling
    │   For each episode with status COMBINING:
    │     GET /api/quality-check/{episodeId}
    │     │
    │     ├── "PASS" or "ISSUES_FOUND" → READY_TO_SYNC
    │     │     record finished_at, duration_ms
    │     ├── "RUNNING" → continue polling
    │     ├── null → wait (Lambda writing — only safe after 200 POST)
    │     └── FAILED → retries < 2? retry QC : mark READY_TO_SYNC anyway
    │
    └── CHECK: all episodes in terminal state?
          ├── NO → next tick (wait 30s)
          └── YES → pipeline_run status: "COMPLETED"
                    finished_at: now()
```

### 3. Sync (manual — user clicks "Sync Show")

```
USER sees all episodes as READY_TO_SYNC in episode table
    │
    ▼
[Sync Show] button clicked
    │
    ▼
POST /api/auto-pipeline/sync-all { showId }
    │
    ├── GAP 6 FIX: resolve episodes via showcase, not pipeline_run
    │   (multiple pipeline_runs may exist for re-runs of same show)
    ├── Find show in master.showcache by showId
    ├── Collect all episode IDs from show.episodes[].id
    ├── For each ID: read combined_master_m3u8_url from video_episodes
    ├── Filter: only those with a non-empty combined URL
    │
    ▼
For each episode with combined URL:
    │
    ├── Read combined_master_m3u8_url from chai_q_lab.video_episodes
    │
    ▼
POST /api/sync-showcache-episode {
    episodeId,
    signedPlaybackUrl: combined_master_m3u8_url   ← MUST match DB value
  }
    │
    ├── Validates signedPlaybackUrl matches video_episodes.combined_master_m3u8_url
    ├── Builds download_config from golden_recipes + episode duration
    ├── Writes to master.showcache:
    │     episodes.$.signed_playback_url = combined_master_m3u8_url
    │     episodes.$.download_config = { h264: [...], h265: [...] }
    │
    ▼
Return { synced: [episodeIds], failed: [episodeIds] }
Episode status → SYNCED, synced_at: now()
```

### 4. Timeline Example (30 episodes, ~45min lab, ~12min GCP)

```
t=0min    H.264 labs start (18 slots) + H.265 labs start (12 slots)
t=38min   First H.264 labs complete → GCP H.264 + VTT kick off immediately
t=43min   More H.264 labs done → more GCP H.264s fire
          H.264 queue drains → H.265 borrows slots, speeds up
t=48min   First GCP H.264s finish
          First H.265 labs complete → GCP H.265 kicks off immediately
t=50min   First episode has BOTH GCPs done → Combine + QC
t=53min   QC finishes → first episode READY_TO_SYNC
t=58min   H.265 labs still running for later episodes (borrowed slots help)
t=68min   Last H.265 labs complete → last GCP H.265s fire
t=80min   Last GCP done → last Combine + QC
t=83min   All episodes READY_TO_SYNC
          User clicks "Sync Show"
```

### Systems Map

```
┌─ AWS (us-east-1) ─────────────────────────────────────────────┐
│                                                                │
│  App Runner (Dashboard)                                        │
│    └── /api/push              → starts Lab SFN                 │
│    └── /api/status/{id}       → reads lab progress from Mongo  │
│    └── /api/gcp               → starts GCP SFN                 │
│    └── /api/gcp-status/{id}   → reads GCP status + checks SFN  │
│    └── /api/episode-vtt       → calls Cloud Run VTT worker     │
│    └── /api/create-combined   → Lambda merges manifests        │
│    └── /api/quality-check     → Lambda async QC                │
│    └── /api/sync-showcache    → writes to master.showcache     │
│                                                                │
│  Step Functions                                                │
│    └── Chai-Q-Orchestrator-H264  → Batch → research-worker     │
│    └── Chai-Q-Orchestrator-H265  → Batch → research-worker     │
│    └── GCP-Orchestrator          → Lambda chain:               │
│          copy S3→GCS → submit transcode → poll → finalize      │
│                                                                │
│  AWS Batch                                                     │
│    └── research-worker container (FFmpeg + VMAF)               │
│                                                                │
│  Lambda                                                        │
│    └── gcp_copy_s3_to_gcs, gcp_transcoder, gcp_check_status   │
│    └── gcp_finalize_hls, create_combined_master                │
│    └── quality_check                                           │
│                                                                │
└────────────────────────────────────────────────────────────────┘

┌─ GCP (asia-south1 / Mumbai) ──────────────────────────────────┐
│  GCS Buckets (input + output)                                  │
│  Transcoder API (managed — queues jobs internally)             │
│  Cloud Run: VTT worker (WebP sprites + VTT generation)         │
└────────────────────────────────────────────────────────────────┘

┌─ MongoDB Atlas ───────────────────────────────────────────────┐
│  master.showcache         → source episodes, s3_url, playback │
│  chai_q_lab.video_episodes → lab status, golden_recipes,      │
│                              source_fps, GCP status, URLs     │
│  chai_q_lab.pipeline_runs  → NEW: orchestrator state tracking │
│  master.episode_vtt        → VTT + sprite URLs                │
└────────────────────────────────────────────────────────────────┘
```
