"""Behaviour of the Durable ports, driven deterministically with fake activities."""
import json

import pytest

from bitrater_wf import orchestrators as o
from bitrater_wf.sfn import ERROR_KEY, PathMissing, WorkflowFailed
from durable_fake import Run

ORCHS = {"audio_transcode": o.audio_transcode, "audio_episode_tolerant": o.audio_episode_tolerant}


def err(msg="boom", typ="RuntimeError"):
    return {ERROR_KEY: {"errorMessage": msg, "errorType": typ, "stackTrace": ["  File x"]}}


class Script:
    """Per-module queues of results; a callable is invoked with the event."""

    def __init__(self, **queues):
        self.q = {k: list(v) for k, v in queues.items()}

    def __call__(self, module, event):
        item = self.q[module].pop(0) if len(self.q[module]) > 1 else self.q[module][0]
        return item(event) if callable(item) else item


# ---------------- lab_search ----------------
LAB_IN = {"s3_url": "s3://b/k", "episode_id": "ep1", "codec": "h264", "run_id": "r1"}


def lab_state(poll, done, wait="SHORT"):
    return {"episode_id": "ep1", "codec": "h264", "s3_url": "s3://b/k", "search_state": {}, "poll_count": poll,
            "all_done": done, "next_wait": wait, "run_id": "r1"}


def test_lab_happy_path_waits_and_aggregates():
    script = Script(search_orchestrator=[lab_state(0, False), lab_state(1, False, "SHORT"), lab_state(5, False, "LONG"),
                                         lab_state(6, True, "LONG")],
                    aggregator=[{"ok": True}])
    run = Run(script)
    result, _ = run.drive(o.lab_search, LAB_IN)
    assert result == {"ok": True}
    assert [m for m, _ in run.calls] == ["search_orchestrator"] * 4 + ["aggregator"]
    assert run.calls[0][1] == LAB_IN                     # InitSearch gets the execution input
    assert run.calls[1][1] == lab_state(0, False)        # CheckAndDecide gets previous output
    assert run.calls[-1][1] == {"episode_id": "ep1", "codec": "h264"}
    assert run.waits == [15, 15, 25]                     # ChooseWait on next_wait of previous state


def test_lab_task_failure_marks_lab_failed_with_lambda_cause():
    script = Script(search_orchestrator=[lab_state(0, False), err("no scores", "ValueError")], mark_lab_failed=[{}])
    run = Run(script)
    with pytest.raises(WorkflowFailed) as ei:
        run.drive(o.lab_search, LAB_IN)
    assert (ei.value.error, ei.value.cause) == o.LAB_FAIL
    module, event = run.calls[-1]
    assert module == "mark_lab_failed"
    assert event["episode_id"] == "ep1" and event["codec"] == "h264"
    assert json.loads(event["cause"])["errorMessage"] == "no scores"
    assert json.loads(event["cause"])["errorType"] == "ValueError"


def test_lab_init_failure_is_caught_too():
    run = Run(Script(search_orchestrator=[err()], mark_lab_failed=[{}]))
    with pytest.raises(WorkflowFailed):
        run.drive(o.lab_search, LAB_IN)
    assert [m for m, _ in run.calls] == ["search_orchestrator", "mark_lab_failed"]


def test_lab_cap_passes_timeout_cause():
    run = Run(Script(search_orchestrator=[lab_state(0, False), lab_state(2880, False, "LONG")], mark_lab_failed=[{}]))
    with pytest.raises(WorkflowFailed):
        run.drive(o.lab_search, LAB_IN)
    assert run.calls[-1][1]["cause"] == o.LAB_CAP_CAUSE


def test_lab_mark_failed_error_fails_execution_with_its_own_error():
    run = Run(Script(search_orchestrator=[err()], mark_lab_failed=[err("mongo down")]))
    with pytest.raises(Exception) as ei:
        run.drive(o.lab_search, LAB_IN)
    assert "mongo down" in str(ei.value)


def test_lab_continue_as_new_carries_state_and_resumes():
    states = [lab_state(0, False)] + [lab_state(i, False, "LONG") for i in range(1, 101)]
    run = Run(Script(search_orchestrator=states))
    result, ctx = run.drive(o.lab_search, LAB_IN)
    assert result is None and ctx.continued["__carry__"]["exec_input"] == LAB_IN
    carried = ctx.continued
    run2 = Run(Script(search_orchestrator=[lab_state(101, True, "LONG")], aggregator=[{"ok": 1}]))
    result2, _ = run2.drive(o.lab_search, carried)
    assert result2 == {"ok": 1}
    assert run2.calls[0] == ("search_orchestrator", lab_state(100, False, "LONG"))  # resumes with carried state


# ---------------- gcp_transcode ----------------
GCP_IN = {"s3_url": "https://x/src.mp4", "episode_id": "ep1", "golden_recipes": {"resolutions": {}}, "codec": "h264",
          "source_fps": 25, "has_audio": True, "kind": "trailer", "trailer_key": "t1", "show_slug": "s"}


def copy_ok(e):
    return {"episode_id": e["episode_id"], "gcs_input_uri": "gs://in/ep1/source.mp4", "golden_recipes": e["golden_recipes"],
            "codec": e["codec"], "source_fps": e["source_fps"], "has_audio": e["has_audio"], "extra": 1}


def submit_ok(e):
    return {**{k: e[k] for k in ("episode_id", "golden_recipes", "codec", "source_fps")},
            "gcp_job_name": "projects/p/jobs/j", "output_uri": "gs://out/ep1/"}


def check(state):
    return lambda e: {"episode_id": e["episode_id"], "gcp_job_name": e["gcp_job_name"], "gcp_job_state": state,
                      "golden_recipes": e["golden_recipes"], "output_uri": e["output_uri"], "codec": e["codec"]}


FINAL = {"episode_id": "ep1", "h264_master_m3u8_url": "u264", "h265_master_m3u8_url": None}


def test_gcp_happy_path_selectors_and_polling():
    run = Run(Script(gcp_copy_s3_to_gcs=[copy_ok], gcp_transcoder=[submit_ok],
                     gcp_check_status=[check("RUNNING"), check("RUNNING"), check("SUCCEEDED")],
                     gcp_finalize_hls=[FINAL]))
    result, _ = run.drive(o.gcp_transcode, GCP_IN)
    assert result == FINAL
    assert run.calls[0][1] == {k: GCP_IN[k] for k in o.COPY_IN}          # kind/trailer_key dropped, as in SFN
    assert set(run.calls[1][1]) == set(o.COPY_OUT)                       # "extra" dropped by ResultSelector
    assert set(run.calls[2][1]) == set(o.SUBMIT_OUT)
    assert "source_fps" not in run.calls[-1][1]                          # CHECK_OUT drops source_fps
    assert run.waits == [60, 60, 60]


def test_gcp_copy_retries_30_60_then_fails_uncaught():
    run = Run(Script(gcp_copy_s3_to_gcs=[err("timeout")]))
    with pytest.raises(Exception) as ei:
        run.drive(o.gcp_transcode, GCP_IN)
    assert not isinstance(ei.value, WorkflowFailed)                      # no Catch on copy
    assert [m for m, _ in run.calls] == ["gcp_copy_s3_to_gcs"] * 3        # MaxAttempts 2 = 3 calls
    assert run.waits == [30, 60]


def test_gcp_check_retries_then_job_failed():
    run = Run(Script(gcp_copy_s3_to_gcs=[copy_ok], gcp_transcoder=[submit_ok], gcp_check_status=[err()]))
    with pytest.raises(WorkflowFailed) as ei:
        run.drive(o.gcp_transcode, GCP_IN)
    assert (ei.value.error, ei.value.cause) == o.GCP_FAIL
    assert [m for m, _ in run.calls].count("gcp_check_status") == 4       # 1 + 3 retries
    assert run.waits == [60, 15, 30, 60]


def test_gcp_failed_state_and_finalize_error_go_to_job_failed():
    for script in (
        Script(gcp_copy_s3_to_gcs=[copy_ok], gcp_transcoder=[submit_ok], gcp_check_status=[check("FAILED")]),
        Script(gcp_copy_s3_to_gcs=[copy_ok], gcp_transcoder=[submit_ok], gcp_check_status=[check("SUCCEEDED")],
               gcp_finalize_hls=[err()]),
    ):
        with pytest.raises(WorkflowFailed) as ei:
            Run(script).drive(o.gcp_transcode, GCP_IN)
        assert ei.value.cause == "GCP Transcoder job failed"


def test_gcp_av_prefixed_finalize_fails_like_sfn_results_selector():
    av_final = {"episode_id": "ep1", "av_h264_master_m3u8_url": "u", "av_h265_master_m3u8_url": None}
    run = Run(Script(gcp_copy_s3_to_gcs=[copy_ok], gcp_transcoder=[submit_ok], gcp_check_status=[check("SUCCEEDED")],
                     gcp_finalize_hls=[av_final]))
    with pytest.raises(PathMissing):
        run.drive(o.gcp_transcode, GCP_IN)
    assert run.calls[-1][0] == "gcp_finalize_hls"                         # finalize ran (Mongo updated) first


def test_gcp_continue_as_new_after_100_polls():
    run = Run(Script(gcp_copy_s3_to_gcs=[copy_ok], gcp_transcoder=[submit_ok], gcp_check_status=[check("RUNNING")]))
    result, ctx = run.drive(o.gcp_transcode, GCP_IN)
    assert result is None and set(ctx.continued["__carry__"]["cur"]) == set(o.CHECK_OUT)
    run2 = Run(Script(gcp_check_status=[check("SUCCEEDED")], gcp_finalize_hls=[FINAL]))
    assert run2.drive(o.gcp_transcode, ctx.continued)[0] == FINAL
    assert [m for m, _ in run2.calls] == ["gcp_check_status", "gcp_finalize_hls"]   # no re-copy / re-submit


# ---------------- audio ----------------
AUDIO_IN = {"episode_id": "a1", "audio_url": "https://x/a.mp3"}
a_copy = {"episode_id": "a1", "gcs_input_uri": "gs://a/in", "source_ext": "mp3"}
a_submit = {"episode_id": "a1", "gcp_job_name": "j", "output_uri": "gs://a/out", "ladder": [64]}


def a_check(state):
    return {**a_submit, "gcp_job_state": state}


def test_audio_happy_and_copy_failure_is_caught():
    run = Run(Script(gcp_copy_audio_to_gcs=[a_copy], gcp_audio_transcoder=[a_submit],
                     gcp_check_audio_status=[a_check("RUNNING"), a_check("SUCCEEDED")]))
    result, _ = run.drive(o.audio_transcode, AUDIO_IN)
    assert result == a_check("SUCCEEDED") and run.waits == [30, 30]
    run = Run(Script(gcp_copy_audio_to_gcs=[err()]))
    with pytest.raises(WorkflowFailed) as ei:
        run.drive(o.audio_transcode, AUDIO_IN)
    assert ei.value.cause == o.AUDIO_FAIL[1] and run.waits == [30, 60]


def test_audio_show_batch_tolerates_failures_and_caps_concurrency():
    episodes = [{"episode_id": f"a{i}", "audio_url": f"u{i}", "title": "x"} for i in range(40)]

    def copy(e):
        return err() if e["episode_id"] in ("a3", "a17") else {**a_copy, "episode_id": e["episode_id"]}

    run = Run(Script(list_audio_episodes=[{"slug": "s", "count": 40, "episodes": episodes}],
                     gcp_copy_audio_to_gcs=[copy], gcp_audio_transcoder=[a_submit],
                     gcp_check_audio_status=[a_check("SUCCEEDED")]), ORCHS)
    results, _ = run.drive(o.audio_show_batch, {"slug": "s"})
    assert len(results) == 40
    assert sorted(r["episode_id"] for r in results if r["status"] == "FAILED") == ["a17", "a3"]
    assert run.calls[0] == ("list_audio_episodes", {"slug": "s"})
    child_inputs = [e for m, e in run.calls if m == "gcp_copy_audio_to_gcs"]
    assert all(set(e) == {"episode_id", "audio_url"} for e in child_inputs)   # title not passed to child
    assert max(run.window_sizes) == 30                                          # MaxConcurrency 30


def test_invoke_async_retries_like_lambda_event_invoke():
    run = Run(Script(quality_checker=[err("x"), err("x"), {"ok": 1}]))
    result, _ = run.drive(o.invoke_async, {"module": "quality_checker", "event": {"episode_id": "e"}})
    assert result == {"ok": 1} and run.waits == [60, 120]


def test_activity_level_failure_still_runs_catch():
    """Worker crash / serialization error raises at the yield (not a returned error):
    must still reach MarkLabFailed like SFN's States.ALL Catch."""
    from durable_fake import FakeCtx

    ctx = FakeCtx(LAB_IN)
    gen = o.lab_search(ctx)
    task = gen.send(None)
    assert task[0] == "activity" and task[2]["module"] == "search_orchestrator"
    task = gen.throw(RuntimeError("activity host crashed"))       # activity itself failed
    assert task[2]["module"] == "mark_lab_failed"
    assert "activity host crashed" in json.loads(task[2]["event"]["cause"])["errorMessage"]
    with pytest.raises(WorkflowFailed):
        gen.send({})
