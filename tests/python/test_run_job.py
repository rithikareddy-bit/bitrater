"""azure-jobs/run_job.py: every failure prints the <JOB>_ERROR marker the alert matches."""
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("run_job", ROOT / "azure-jobs" / "run_job.py")
run_job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_job)


def test_failure_prints_job_marker_and_exits_nonzero(monkeypatch, capsys):
    def boom(job):
        raise RuntimeError("mongo down")

    monkeypatch.setattr(run_job, "_run", boom)
    for job in run_job.JOBS:
        assert run_job.main(["run_job.py", job]) == 1
        assert f"{job.upper()}_ERROR RuntimeError: mongo down" in capsys.readouterr().out


def test_every_marker_is_matched_by_the_alert():
    tf = (ROOT / "azure-infra" / "monitoring.tf").read_text()
    block = tf[tf.index('"scheduled_job_failed"'):]
    for job in run_job.JOBS:
        assert f"'{job.upper()}_ERROR'" in block, job
    assert "'RESIGN_PARTIAL'" in block


def test_usage_error():
    assert run_job.main(["run_job.py", "nope"]) == 64
