"""The Durable ports must use the same constants as the live Step Functions JSON."""
import inspect
import json
from pathlib import Path

from bitrater_wf import orchestrators as o

ROOT = Path(__file__).resolve().parents[2] / "orchestrator"


def sm(name):
    return json.loads((ROOT / name).read_text())["States"]


def retry(state):
    r = state["Retry"][0]
    return r["IntervalSeconds"], r["MaxAttempts"], r["BackoffRate"]


def src(fn):
    return inspect.getsource(fn)


def test_lab_search_constants():
    s = sm("step_function_def_search.json")
    assert s["Wait15s"]["Seconds"] == 15 and s["Wait25s"]["Seconds"] == 25
    assert s["CheckMaxCycles"]["Choices"][0]["NumericGreaterThanEquals"] == o.LAB_MAX_CYCLES
    assert s["SetTimeoutError"]["Result"]["Cause"] == o.LAB_CAP_CAUSE
    assert (s["LabExecutionFailed"]["Error"], s["LabExecutionFailed"]["Cause"]) == o.LAB_FAIL
    assert "wait(ctx, 15 if" in src(o.lab_search) and "else 25" in src(o.lab_search)


def test_gcp_constants():
    s = sm("gcp_step_function_def.json")
    assert retry(s["CopySourceToGCS"]) == (30, 2, 2)
    assert retry(s["SubmitGCPJob"]) == (10, 2, 2)
    assert retry(s["CheckJobStatus"]) == (15, 3, 2)
    assert s["WaitForJob"]["Seconds"] == 60
    assert (s["JobFailed"]["Error"], s["JobFailed"]["Cause"]) == o.GCP_FAIL
    assert sorted(s["CopySourceToGCS"]["ResultSelector"]) == sorted(k + ".$" for k in o.COPY_OUT)
    assert sorted(s["CopySourceToGCS"]["Parameters"]["Payload"]) == sorted(k + ".$" for k in o.COPY_IN)
    assert sorted(s["SubmitGCPJob"]["ResultSelector"]) == sorted(k + ".$" for k in o.SUBMIT_OUT)
    assert sorted(s["CheckJobStatus"]["ResultSelector"]) == sorted(k + ".$" for k in o.CHECK_OUT)
    assert sorted(s["FinalizeHLS"]["ResultSelector"]) == sorted(k + ".$" for k in o.FINALIZE_OUT)
    body = src(o.gcp_transcode)
    assert '"gcp_copy_s3_to_gcs", pick(inp, COPY_IN), 30, 2, 2' in body
    assert '"gcp_transcoder", cur, 10, 2, 2' in body
    assert '"gcp_check_status", cur, 15, 3, 2' in body
    assert "wait(ctx, 60)" in body


def test_audio_constants():
    s = sm("gcp_audio_step_function_def.json")
    assert retry(s["CopyAudioToGCS"]) == (30, 2, 2)
    assert retry(s["SubmitAudioJob"]) == (10, 2, 2)
    assert retry(s["CheckJobStatus"]) == (15, 3, 2)
    assert s["WaitForJob"]["Seconds"] == 30
    assert (s["JobFailed"]["Error"], s["JobFailed"]["Cause"]) == o.AUDIO_FAIL
    assert sorted(s["CopyAudioToGCS"]["ResultSelector"]) == sorted(k + ".$" for k in o.AUDIO_COPY_OUT)
    assert sorted(s["SubmitAudioJob"]["ResultSelector"]) == sorted(k + ".$" for k in o.AUDIO_SUBMIT_OUT)
    assert sorted(s["CheckJobStatus"]["ResultSelector"]) == sorted(k + ".$" for k in o.AUDIO_CHECK_OUT)
    assert "wait(ctx, 30)" in src(o.audio_transcode)


def test_audio_show_batch_constants():
    s = sm("gcp_audio_show_batch_def.json")
    assert s["ConvertAll"]["MaxConcurrency"] == o.AUDIO_SHOW_MAX_CONCURRENCY
    assert s["ConvertAll"]["ToleratedFailurePercentage"] == 100
