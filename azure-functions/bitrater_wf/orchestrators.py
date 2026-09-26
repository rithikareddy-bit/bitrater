"""Durable ports of the live Step Functions (orchestrator/*step_function*.json).

Each function mirrors its state machine state by state; the JSON constants are
asserted by tests/python/test_sfn_contract.py. Orchestrators are generators run
by Durable Functions; they must stay deterministic (no I/O, no wall clock).

Long loops call continue_as_new every GENERATION_POLLS polls so history stays
bounded (the lab loop can run 2880 polls); the carried state resumes at the
same point in the loop.
"""
from .sfn import PathMissing, TaskError, WorkflowFailed, call, call_with_retry, pick, wait

GENERATION_POLLS = 100
LAB_MAX_CYCLES = 2880
LAB_CAP_CAUSE = "Search polling exceeded maximum cycles (orchestration cap timeout — not a search logic failure)"
LAB_FAIL = ("ChaiQLabFailed", "Search orchestrator failed; see video_episodes.lab_error_h264/lab_error_h265")
GCP_FAIL = ("GCPTranscoderJobFailed", "GCP Transcoder job failed")
AUDIO_FAIL = ("AudioPipelineFailed", "Audio pipeline failed (copy, submit, or transcode)")
AUDIO_SHOW_MAX_CONCURRENCY = 30


class _CapTimeout(Exception):
    cause = LAB_CAP_CAUSE


def _carry(ctx):
    inp = ctx.get_input() or {}
    return inp, inp.get("__carry__")


# --- Chai-Q-Orchestrator-H264 / -H265 (step_function_def_search.json) ---------
def lab_search(ctx):
    inp, carry = _carry(ctx)
    exec_input = carry["exec_input"] if carry else inp
    state = carry["state"] if carry else None
    try:
        if state is None:
            state = yield from call(ctx, "search_orchestrator", exec_input)  # InitSearch
        polls = 0
        while True:
            yield from wait(ctx, 15 if state.get("next_wait") == "SHORT" else 25)  # ChooseWait
            state = yield from call(ctx, "search_orchestrator", state)  # CheckAndDecide
            if state.get("all_done") is True:  # IsSearchDone
                break
            if state["poll_count"] >= LAB_MAX_CYCLES:  # CheckMaxCycles -> SetTimeoutError
                raise _CapTimeout()
            polls += 1
            if polls >= GENERATION_POLLS:
                ctx.continue_as_new({"__carry__": {"exec_input": exec_input, "state": state}})
                return None
        # CalculateGoldenRecipe: Payload {episode_id.$, codec.$} from the current state
        return (yield from call(ctx, "aggregator", pick(state, ["episode_id", "codec"])))
    except (TaskError, _CapTimeout) as err:
        # MarkLabFailed (no Catch: if it fails, the execution fails with its error)
        yield from call(ctx, "mark_lab_failed", {
            "episode_id": exec_input["episode_id"],
            "codec": exec_input["codec"],
            "cause": err.cause,
        })
        raise WorkflowFailed(*LAB_FAIL)


# --- GCP-Orchestrator (gcp_step_function_def.json) -----------------------------
COPY_IN = ["episode_id", "s3_url", "golden_recipes", "codec", "source_fps", "has_audio"]
COPY_OUT = ["episode_id", "gcs_input_uri", "golden_recipes", "codec", "source_fps", "has_audio"]
SUBMIT_OUT = ["episode_id", "gcp_job_name", "golden_recipes", "output_uri", "codec", "source_fps"]
CHECK_OUT = ["episode_id", "gcp_job_name", "gcp_job_state", "golden_recipes", "output_uri", "codec"]
FINALIZE_OUT = ["episode_id", "h264_master_m3u8_url", "h265_master_m3u8_url"]


def gcp_transcode(ctx):
    inp, carry = _carry(ctx)
    if carry:
        cur = carry["cur"]
    else:
        # CopySourceToGCS: Retry 30s x2 backoff 2, no Catch
        copied = yield from call_with_retry(ctx, "gcp_copy_s3_to_gcs", pick(inp, COPY_IN), 30, 2, 2)
        cur = pick(copied, COPY_OUT)
        # SubmitGCPJob: Retry 10s x2 backoff 2, no Catch
        cur = pick((yield from call_with_retry(ctx, "gcp_transcoder", cur, 10, 2, 2)), SUBMIT_OUT)
    polls = 0
    while True:
        yield from wait(ctx, 60)  # WaitForJob
        try:  # CheckJobStatus: Retry 15s x3 backoff 2, Catch -> JobFailed
            checked = yield from call_with_retry(ctx, "gcp_check_status", cur, 15, 3, 2)
        except TaskError:
            raise WorkflowFailed(*GCP_FAIL)
        cur = pick(checked, CHECK_OUT)
        if cur["gcp_job_state"] == "SUCCEEDED":
            try:  # FinalizeHLS: Catch -> JobFailed
                finalized = yield from call(ctx, "gcp_finalize_hls", cur)
            except TaskError:
                raise WorkflowFailed(*GCP_FAIL)
            # Same ResultSelector as SFN: an av_-prefixed finalize result fails here
            # (States.Runtime) exactly as it does on AWS today, after Mongo is updated.
            return pick(finalized, FINALIZE_OUT)
        if cur["gcp_job_state"] == "FAILED":
            raise WorkflowFailed(*GCP_FAIL)
        polls += 1
        if polls >= GENERATION_POLLS:
            ctx.continue_as_new({"__carry__": {"cur": cur}})
            return None


# --- Audio-Orchestrator (gcp_audio_step_function_def.json) --------------------
AUDIO_COPY_OUT = ["episode_id", "gcs_input_uri", "source_ext"]
AUDIO_SUBMIT_OUT = ["episode_id", "gcp_job_name", "output_uri", "ladder"]
AUDIO_CHECK_OUT = ["episode_id", "gcp_job_name", "gcp_job_state", "output_uri", "ladder"]


def audio_transcode(ctx):
    inp, carry = _carry(ctx)
    if carry:
        cur = carry["cur"]
    else:
        try:  # CopyAudioToGCS: Retry 30s x2 backoff 2, Catch -> JobFailed
            copied = yield from call_with_retry(ctx, "gcp_copy_audio_to_gcs", pick(inp, ["episode_id", "audio_url"]), 30, 2, 2)
        except TaskError:
            raise WorkflowFailed(*AUDIO_FAIL)
        cur = pick(copied, AUDIO_COPY_OUT)
        # SubmitAudioJob: Retry 10s x2 backoff 2, no Catch
        cur = pick((yield from call_with_retry(ctx, "gcp_audio_transcoder", cur, 10, 2, 2)), AUDIO_SUBMIT_OUT)
    polls = 0
    while True:
        yield from wait(ctx, 30)  # WaitForJob
        try:  # CheckJobStatus: Retry 15s x3 backoff 2, Catch -> JobFailed
            checked = yield from call_with_retry(ctx, "gcp_check_audio_status", cur, 15, 3, 2)
        except TaskError:
            raise WorkflowFailed(*AUDIO_FAIL)
        cur = pick(checked, AUDIO_CHECK_OUT)
        if cur["gcp_job_state"] == "SUCCEEDED":
            return cur  # GenerateDone
        if cur["gcp_job_state"] == "FAILED":
            raise WorkflowFailed(*AUDIO_FAIL)
        polls += 1
        if polls >= GENERATION_POLLS:
            ctx.continue_as_new({"__carry__": {"cur": cur}})
            return None


def audio_episode_tolerant(ctx):
    """One Map item: run the child and never fail (ToleratedFailurePercentage 100)."""
    item = ctx.get_input()
    try:
        output = yield ctx.call_sub_orchestrator("audio_transcode", item, f"{ctx.instance_id}:child")
        return {"episode_id": item.get("episode_id"), "status": "SUCCEEDED", "output": output}
    except Exception as err:  # noqa: BLE001 - child failure is tolerated by design
        return {"episode_id": item.get("episode_id"), "status": "FAILED", "error": str(err)}


# --- Audio-Show-Batch (gcp_audio_show_batch_def.json) --------------------------
def audio_show_batch(ctx):
    inp = ctx.get_input() or {}
    # ListEpisodes: Payload = execution input; no Retry/Catch
    listed = pick((yield from call(ctx, "list_audio_episodes", inp)), ["slug", "count", "episodes"])
    items = [pick(ep, ["episode_id", "audio_url"]) for ep in listed["episodes"]]
    # ConvertAll: Map, MaxConcurrency 30, tolerated failures 100% -> sliding window of children
    results, running, nxt = [None] * len(items), {}, 0
    while nxt < len(items) or running:
        while nxt < len(items) and len(running) < AUDIO_SHOW_MAX_CONCURRENCY:
            task = ctx.call_sub_orchestrator("audio_episode_tolerant", items[nxt], f"{ctx.instance_id}:{nxt}")
            running[nxt] = task
            nxt += 1
        done = yield ctx.task_any(list(running.values()))
        for idx, task in list(running.items()):
            if task is done or getattr(task, "is_completed", False):
                results[idx] = task.result
                del running[idx]
    return results


# --- /api/invoke?mode=async: Lambda Event invoke (async retries: 2, ~1 min then ~2 min)
def invoke_async(ctx):
    req = ctx.get_input()
    try:
        return (yield from call_with_retry(ctx, req["module"], req["event"], 60, 2, 2))
    except TaskError as err:
        raise WorkflowFailed(err.error.get("errorType", "Error"), err.cause)
