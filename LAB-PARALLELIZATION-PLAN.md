# Lab Parallelization Plan — Work-Conserving 120-Wide Grid Scheduler

**Goal:** Keep all **120 worker slots continuously full** with bitrate encodes.
Fill slots **episode-wise** (an episode's full grid goes in as a unit), queue the rest,
and the instant any worker finishes, **immediately backfill** the freed slot from the
queue — no idle slots, no waiting for a whole "wave" to drain.

**Replaces:** the serial adaptive binary search (`step_function_def_search.json` +
`search_orchestrator.py`), which uses **1 worker per lab** and takes ~3 h/episode.

---

## 0. CRITICAL CORRECTION (2nd verification pass, 2026-07-11)

The first two drafts **missed that a full pipeline orchestrator already exists** and got two
things wrong. Both are now corrected below.

- **A work-conserving pool scheduler already exists** — `dashboard/lib/pipelineOrchestrator.js`
  `orchestrate()` → `fillLabSlots()` (line 248): *"Flat pool of MAX_LAB concurrent jobs across
  all episodes"*, refilled every poll. **We do NOT need to build a scheduler, EventBridge
  counter, or Distributed Map.** The knob is `MAX_LAB = run.lab_workers || 30` (line 124).
- **GCP is already auto-chained**, not a separate manual step (my earlier "G2" was wrong).
  `orchestrate()` runs **lab → GCP → combine → QC** end-to-end: on `lab_h264_status==='COMPLETE'`
  it enqueues GCP (lines 298-306, 461-463), bounded by `MAX_GCP = run.max_gcp || 20`.
- **Each pool slot dispatches `/api/push`** (line 203/225) → the **serial search** SFN
  (`Chai-Q-Orchestrator-H264/H265`), which uses **1 Batch worker per lab**.

### What this means — the two real levers

The 128-worker budget (§1) is partitioned: **`MAX_LAB × (workers per lab) ≤ 128`.**
Today that's `30 × 1 = 30` — you're using ~30 of 128 workers.

| Lever | Change | Effect | Cost |
|---|---|---|---|
| **1. Throughput** | raise `lab_workers` 30 → up to ~120 | more labs at once (uses idle workers) | **config only, zero code** — but each lab still ~3 h (serial) |
| **2. Latency** | swap the search behind `/api/push` for the **parallel grid** (§3) + drop `MAX_LAB` to ~5 (5 × 25 ≈ 125) | each lab ~11 min instead of ~3 h | new grid path; orchestrate/GCP untouched |

**The grid plugs into the existing orchestrator unchanged** — orchestrate keys off
`lab_status_<codec>` and `golden_recipes`, which the grid still produces via `aggregator.py`.
So we only replace the **inside** of a lab, not the pool, GCP chaining, combine, or QC.

---

## 1. The numbers this plan is built on

| Quantity | Value | Source |
|---|---|---|
| Worker slots (hard cap) | **120** | 512 `max_vcpus` ÷ 4 vCPU/job (`main.tf:74`, `batch-job.tf`) |
| vCPU at 120 jobs | 480 | under the 538 spot quota ✅ |
| Encodes per H.264 lab (full grid) | 25 | 1080p×13 + 720p×7 + 480p×5 |
| Encodes per H.265 lab (full grid) | 22 | 1080p×10 + 720p×7 + 480p×5 |
| **Encodes per episode (both codecs)** | **~47** | grid, not search |
| Episodes in flight at once | **~2.5** | 120 ÷ 47 |
| Median encode time | ~8 min (1080p ~8.7, p90 ~11) | Batch job history |

**Key insight:** the binary search already runs ~22 encodes/lab — the full grid is only
~25. We pay 3 hours to save ~3 encodes. Testing the whole grid in parallel gives the same
(more accurate) winner in **~11 min per episode**, at ~same spot cost.

---

## 2. Definition of done

1. At any instant, **≤120 encodes running, and 120 running whenever ≥120 are queued** (work-conserving — zero idle slots while work remains).
2. On **any** job completion, the next queued encode starts **immediately** (event-driven backfill, not batch/wave).
3. Jobs are enqueued **episode-first** so whole episodes complete in order; the earliest episode is done in ~11–20 min, not after the whole batch.
4. As soon as a **(episode, codec) grid** finishes (25 for H.264 / 22 for H.265), run the aggregator **with that `codec`** (golden recipe for that codec), **without** waiting for other grids.
5. **Failed encodes are tolerated** — a single bad bitrate must not abort its grid; the aggregator picks a winner from whatever landed.
6. Never exceed the **512-vCPU `max_vcpus` cap = 128 jobs** (the binding limit; the 538 spot
   quota is *not* binding — 128×4=512 < 538, and you could even go to 134 before the quota bites).

> **Scope:** this plan changes **only the inside of a lab** — the serial search becomes a
> parallel grid. The **pool scheduler, GCP chaining, combine, and QC in `orchestrate()` stay
> untouched** (they key off `lab_status_<codec>` / `golden_recipes`, which the grid still
> writes). GCP is **already** auto-chained (§0) — no new GCP work is needed.

---

## 3. The scheduler already exists — don't build one

`orchestrate()` **is** the work-conserving pool: `fillLabSlots()` holds `MAX_LAB` labs active
across all episodes and refills each poll. So the grid does **not** add a new scheduler,
EventBridge counter, or Distributed Map. Two ways to make the *lab itself* parallel:

- **Recommended — grid Step Function behind `/api/push`.** `/api/push` currently starts the
  serial search SFN (`Chai-Q-Orchestrator-<codec>`). Point it at a new **grid SFN** that fans
  out all ~25 candidate encodes at once (`Map`, or one `SubmitJob` per candidate), waits for
  all (tolerating failures), then calls `aggregator.py` with `{episode_id, codec}`. It writes
  the **same** `lab_status_<codec>=COMPLETE` + `golden_recipes` → `orchestrate()` and GCP see
  no difference. Then set `lab_workers ≈ 5` so `5 × 25 ≈ 125 ≤ 128`.
- **Repartition-only (no grid), throughput lever.** Leave the search as-is and just raise
  `lab_workers` toward the number of concurrent labs you want (≤128). Faster *batch*
  throughput, but each episode still ~3 h. Use this as an immediate zero-code win while the
  grid is built.

The historical Options A/B below (Batch queue vs standalone Distributed Map) are kept for
reference, but the seam above (grid SFN behind `/api/push`) is preferred because it reuses the
existing pool, GCP chaining, retries, combine, and QC verbatim.

### (reference) Option A — AWS Batch queue is the scheduler (simplest)
- Expand every episode into its ~47 `(codec, resolution, bitrate)` encode jobs and
  **submit them all** to `chai-q-queue`.
- The compute env cap (512 vCPU / 4 = 120) means Batch runs **exactly 120** and parks the
  rest in `RUNNABLE`. When one `SUCCEEDED`/`FAILED`, Batch **auto-starts the next RUNNABLE
  job** — instant backfill, no code.
- Episode-first ordering: submit episode-by-episode (Batch schedules ~FIFO by submit time
  within a priority), optionally attach a **fair-share scheduling policy** or per-episode
  `shareIdentifier` for strict ordering.
- Completion tracking: an **EventBridge rule on Batch Job State Change → `SUCCEEDED` *and*
  `FAILED`** (count both — worker `sys.exit(1)` on failure, `worker.py:201`) decrements a
  **per-`(episode, codec)` counter**; when a codec's counter hits 0, fire the aggregator
  **with that `codec`**. Failed encodes just don't write a doc; the aggregator picks from what
  landed.

### Option B — Step Functions **Distributed Map**, `MaxConcurrency: 120` (recommended)
- **Distributed Map (NOT inline** — inline Map caps at 40 concurrency, can't hold 120**).**
- One flattened input list of **all** items across all grids:
  `[{episode_id, s3_url, codec, resolution, bitrate, kind, ...}, ...]`, ordered episode-first.
- `MaxConcurrency: 120`; each iteration = **submit + wait for one Batch encode**
  (`arn:aws:states:::batch:submitJob.sync`).
- Set **`ToleratedFailurePercentage`** (or a per-iteration `Catch`) so one FAILED encode
  doesn't abort the run — the aggregator tolerates missing bitrates (`aggregator.py find_winner`).
- The Map holds 120 iterations active; when one finishes it **starts the next list item
  immediately** → continuous 120-wide fill, backfill built in.
- Fan-in: group items by `(episode, codec)` (a nested per-`(episode,codec)` Map, or the same
  EventBridge counter as Option A) → call the aggregator **once per codec** as each group drains.

**Recommendation: Option A** (pure Batch queue + EventBridge counter) — it is the least new
surface area, is inherently work-conserving, and sidesteps Distributed Map's child-execution
quotas. Option B is preferable **only** if you want the fan-in/aggregation orchestration
expressed as one state machine. Either way, aggregation and completion are **per
`(episode, codec)`**, and GCP delivery is triggered separately (unchanged, §7 G2).

---

## 4. Architecture (Option B)

```
Dashboard "Run N episodes"
        │  episode_ids[], s3_urls[]
        ▼
┌─────────────────────────────────────────────┐
│ PlanGrid Lambda                              │
│  for each episode → expand to ~47 items      │
│  (codec × resolution × candidate bitrate)    │
│  emit ONE flat list, ordered episode-first   │
└───────────────┬─────────────────────────────┘
                ▼
┌─────────────────────────────────────────────┐
│ Distributed Map  (MaxConcurrency: 120)       │  ← keeps 120 slots full,
│   each item:                                 │     backfills instantly
│     SubmitJob.sync → chai-q-queue            │
│       (4 vCPU worker: ffmpeg encode + VMAF)  │
│     write result to video_vmaf_research      │
└───────────────┬─────────────────────────────┘
                ▼  (per-(episode,codec) counter hits 0)
┌─────────────────────────────────────────────┐
│ Aggregator(episode_id, codec) → golden recipe│  ← per codec, as soon as
│   writes golden_recipes.*.<codec> to Mongo   │     its 25/22 are done
└─────────────────────────────────────────────┘
                ▼  (SEPARATE, unchanged — user clicks GCP, or a later automation)
        existing /api/gcp  (re-probes has_audio, re-resolves s3_url) — §7 G2
```

The worker container is **unchanged** — it already does one `(resolution, bitrate)` encode +
VMAF and writes to `video_vmaf_research`. We only change *how jobs are fanned out and
scheduled* (grid + Map), not what a worker does.

---

## 5. Implementation steps

1. **`plan_grid.py`** (Lambda) — input `episode_ids[]` (+ `codec`). For each id: resolve
   `s3_url` **from `master.showcache`** exactly as `push`/`gcp` routes do — `findEpisodeInShowcache`
   for episodes, and the `trailer_<24hex>_<key>` path via `findTrailerInShowcase` for trailers
   (`dashboard/app/api/gcp/route.js:117-145`). Then expand to the flat, episode-ordered item
   list from the `SEARCH_CONFIG` candidate arrays in `search_orchestrator.py:16-49`.
2. **Clear stale docs** — before enqueuing a `(episode, codec)` grid, `deleteMany({episode_id,
   codec})` on `video_vmaf_research` (parity with `push/route.js:76-79`), and reset
   `lab_status_<codec>` / `golden_recipes.resolutions.*.<codec>` like the push route does.
3. **Scheduler** — Option A: submit all jobs to `chai-q-queue`; the 512-vCPU cap holds 120,
   Batch backfills. Option B: `step_function_def_grid.json` **Distributed Map**,
   `MaxConcurrency: 120`, `ToleratedFailurePercentage` set, iterator =
   `batch:submitJob.sync`. **Worker image and job def are unchanged.**
4. **Winner selection** — reuse `aggregator.py` as-is, invoked **once per `(episode, codec)`**
   with `{episode_id, codec}`; it already does "lowest bitrate ≥ threshold, else highest VMAF"
   and tolerates missing bitrates. Brute grid = exhaustive → true optimum.
5. **Completion → aggregator** — EventBridge on Batch `SUCCEEDED`+`FAILED` decrements a
   per-`(episode, codec)` counter; at 0, invoke the aggregator for that codec.
   **GCP is NOT started here** — it remains the existing `/api/gcp` per-codec step (§7 G2).
6. **Terraform / dashboard** — point "Push" / "Run all" at the grid path instead of
   `Chai-Q-Orchestrator-H264/H265`; keep the search machines parked for rollback (§8).
   `LabStatus.js` already polls `/api/status/[id]`; extend it to show grid progress
   (`done/25` H.264, `done/22` H.265) instead of the search phase.

---

## 6. Expected performance

| | Serial search (today) | **Grid, 120-wide (plan)** |
|---|---|---|
| Workers per episode | 2 (1/codec) | up to 47 |
| First episode done | ~3 h | **~11–20 min** |
| 30 episodes (1410 encodes) | ~3 h, only ~60/120 slots used | **~1.5–2.5 h, 120 saturated** |
| Slot utilization | ~50% | **~100% while work remains** |
| Winner accuracy | approximate | exhaustive |
| Spot cost | baseline | ~same (~+15% encodes) |

Throughput ≈ 120 workers ÷ ~8 min/encode ≈ **~900 encodes/hour ≈ ~19 episodes/hour** once
the pipe is full.

---

## 6a. Verified against code (2026-07-11) — confirmations & gaps closed

**Confirmed true:** candidate ladders → 25/22 encodes (`search_orchestrator.py:16-49`); worker
= one `(res,bitrate)` encode+VMAF writing `chai_q_lab.video_vmaf_research` (`worker.py:159-190`);
job env params + `RESOLUTION="1080/720/480"` (`search_orchestrator.py:442-448`); worker
`sys.exit(1)` on failure so Batch status is authoritative (`worker.py:200-204`); aggregator
winner rule + thresholds 88/75/48 (`aggregator.py:5-9,29-45`); 120 jobs = 480 vCPU < 538 quota.

**Gaps found in the first draft and now fixed above:**
- **G1 — per-codec, not per-episode.** Aggregator/push/gcp/`lab_status` are all keyed by codec
  (`aggregator.py:47-56`). The unit is a `(episode, codec)` grid (25 or 22), aggregated with its
  own `codec`. Completion counters are per `(episode, codec)`.
- **G2 — [RETRACTED, was wrong] GCP *is* auto-chained.** `orchestrate()` runs lab→GCP→combine
  →QC (`pipelineOrchestrator.js:298-306,461-463`, `MAX_GCP`), assembling the `has_audio`/`s3_url`
  inputs itself. The grid does NOT touch this — it just writes `lab_status_<codec>`/`golden_recipes`
  as today. (The `/api/gcp` route's `has_audio` ffprobe + showcache/trailer resolution still
  matter, but they already run inside the existing chain.)
- **G7 — NO Batch `retryStrategy`** (`batch-job.tf` has none). A spot-interrupted encode →
  `FAILED`, no retry. The serial search *resubmits* lost jobs; the grid must not silently DROP a
  candidate bitrate (could be the winner). **Add a `retryStrategy` with `evaluateOnExit` for
  host/spot errors (attempts 2–3)** before switching to the grid, or the grid re-submits failed
  candidates itself.
- **G3 — inline Map can't do 120** (~40 cap) → Option B must be a **Distributed Map**.
- **G4 — tolerate failed encodes** (`ToleratedFailurePercentage`/Catch); aggregator already
  copes with missing bitrates.
- **G5 — clear stale `video_vmaf_research` per `(episode, codec)`** before re-run (parity with
  `push/route.js:76-79`).
- **G6 — `s3_url` must be resolved from `master.showcache`** (episode + trailer paths), not
  assumed as an input.

## 7. Watch-outs

- **Straggler floor:** one slow 1080p encode (tail up to ~111 min) delays only *its* episode's
  fan-in, not the global fill — the 120 pipe stays busy on other episodes. Keep the 3000s
  per-job timeout so a hung encode can't block an episode forever.
- **Hard 120 ceiling:** `MaxConcurrency: 120` (Map) **and** the 512 vCPU cap both bound it —
  121 jobs would breach the 538 spot quota, so do **not** raise either without a quota increase.
- **Cold start:** `min_vcpus=0` → the first jobs pay one spot acquisition (median 8 s). To keep
  the pipe warm across back-to-back batches, consider `min_vcpus` = a small value during runs.
- **Shared queue:** confirm the audio VisQOL fleet (`audio-visqol.tf`) isn't competing for the
  same 538-vCPU spot quota during a big run.
- **Episode-first vs fairness:** episode-ordered submission finishes episodes in order (good for
  "first result fast"). If you'd rather every episode progress evenly, interleave the list
  instead — one-line change in `plan_grid.py`.

---

## 8. Rollback

Keep `Chai-Q-Orchestrator-H264/H265` (search) deployed and unwired. If the grid run misbehaves,
repoint the dashboard back to the search machines — no data migration (both write the same
`video_vmaf_research` / golden-recipe shape).
