# Orchestrator

Step Functions and Lambda handlers for the Chai-Q lab and GCP transcoding pipelines.

## Research pipeline (VMAF lab) — 21 jobs in parallel

The research Step Function (`step_function_def.json`) runs **21 encoding jobs in parallel**:

1. **GenerateLadder** outputs a fixed array of 21 items (codec + bitrate + resolution).
2. **ParallelResearch** is a **Map** state over that array. Each iteration submits one AWS Batch job (`submitJob.sync`) and waits for it to finish.
3. **Map state concurrency**: The definition does **not** set `MaxConcurrency`. In AWS Step Functions, a Map state with no `MaxConcurrency` uses the default **0 = unlimited**, so **all 21 iterations start at once** and run in parallel.
4. **Batch capacity**: The Batch compute environment has `max_vcpus = 84` and each job requests **4 vCPUs**, so at most **21 jobs** can run at once — matching the 21 ladder items. All 21 can therefore run in parallel.

### How to verify that jobs run in parallel

- **Total time ≈ slowest job**: If the **total** execution time of the research pipeline is around **1–2 hours** (e.g. “almost 1.5 hours”), that matches **parallel** execution: wall-clock time is roughly the duration of the slowest of the 21 jobs. If the 21 jobs ran **sequentially**, total time would be about **21 × (average job time)** (e.g. 21 × 1.5 h ≈ 31.5 hours).
- **AWS Console**: In Step Functions, open an execution of the research state machine. The **Map** state will show 21 branches; their “Started” times should be almost the same (all started together).
- **AWS Batch**: In the Batch console, for a given run you should see 21 jobs in the queue with similar start times and overlapping run times.

So: **all 21 jobs are configured to run in parallel**; a total time of ~1.5 hours is evidence that they do (parallel ≈ 1.5 h total vs sequential ≈ 30+ h total).
