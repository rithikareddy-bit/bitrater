"""search_orchestrator must make identical decisions on AWS Batch and Azure Batch.

Drives full searches (both codecs) through a simulated Batch backend with a
deterministic VMAF curve, once via the AWS path and once via the Azure path of
batch_jobs, and compares every submission, termination and the final state.
"""
import copy
import itertools
from pathlib import Path
from types import SimpleNamespace

import mongomock
import pytest
from freezegun import freeze_time

import batch_jobs
import search_orchestrator as so


def vmaf_for(res, bitrate):
    base = {"1080": 60, "720": 50, "480": 30}[res]
    return base + bitrate / {"1080": 100, "720": 60, "480": 25}[res]


class World:
    """Shared simulated Batch backend: every job submitted completes by the next poll."""

    def __init__(self, db, fail_every=0, one_per_tick=False, vanish_every=0):
        self.db, self.jobs, self.submissions, self.terminations = db, {}, [], []
        self.fail_every, self.n, self.one_per_tick = fail_every, 0, one_per_tick
        self.vanish_every = vanish_every

    def submit(self, job_id, env):
        self.n += 1
        fail = bool(self.fail_every) and self.n % self.fail_every == 0
        vanished = bool(self.vanish_every) and self.n % self.vanish_every == 0
        self.jobs[job_id] = {"env": env, "state": "VANISHED" if vanished else "RUNNABLE", "fail": fail}
        self.submissions.append((env["CODEC"], env["RESOLUTION"], env["BITRATE"]))

    def tick(self):
        for jid, j in self.jobs.items():
            if j["state"] != "RUNNABLE":
                continue
            if j["fail"]:
                j["state"] = "FAILED"
                if self.one_per_tick:
                    return
                continue
            e = j["env"]
            self.db.video_vmaf_research.insert_one({
                "episode_id": e["EPISODE_ID"], "codec": e["CODEC"], "resolution": e["RESOLUTION"] + "p",
                "bitrate_kbps": int(e["BITRATE"]), "vmaf_score": vmaf_for(e["RESOLUTION"], int(e["BITRATE"])),
                "lab_run_id": e.get("LAB_RUN_ID"), "timestamp": len(self.jobs),
            })
            j["state"] = "SUCCEEDED"
            if self.one_per_tick:  # slow backend: leaves others pending -> exercises discard/terminate
                return


class FakeAws:
    def __init__(self, world):
        self.w, self.ids = world, itertools.count(1)

    def submit_job(self, jobName, jobQueue, jobDefinition, containerOverrides):
        jid = f"aws-{next(self.ids)}"
        self.w.submit(jid, {e["name"]: e["value"] for e in containerOverrides["environment"]})
        return {"jobId": jid, "jobName": jobName}

    def describe_jobs(self, jobs):
        return {"jobs": [{"jobId": j, "status": self.w.jobs[j]["state"]} for j in jobs
                         if j in self.w.jobs and self.w.jobs[j]["state"] != "VANISHED"]}

    def terminate_job(self, jobId, reason):
        self.w.terminations.append(jobId)


class FakeAzureBatchClient:
    _state = {"RUNNABLE": ("active", None), "SUCCEEDED": ("completed", "success"), "FAILED": ("completed", "failure")}

    def __init__(self, world):
        self.w = world

    def create_task(self, job, opts):
        env = {s.name: s.value for s in opts.environment_settings}
        self.w.submit(f"azb:{job}/{opts.id}", env)

    def get_task(self, job, task):
        from azure.core.exceptions import ResourceNotFoundError
        j = self.w.jobs.get(f"azb:{job}/{task}")
        if j is None or j["state"] == "VANISHED":
            raise ResourceNotFoundError("nope")
        state, result = self._state[j["state"]]
        return SimpleNamespace(state=state, display_name=task, execution_info=SimpleNamespace(result=result))

    def terminate_task(self, job, task):
        self.w.terminations.append(f"azb:{job}/{task}")


def run_search(monkeypatch, provider, codec, fail_every=0, one_per_tick=False, vanish_every=0, on_poll=None):
    mongo = mongomock.MongoClient()
    db = mongo[so.runtime_config.DB_LAB]
    world = World(db, fail_every, one_per_tick, vanish_every)
    monkeypatch.setattr(so.pymongo, "MongoClient", lambda *a, **k: mongo)
    monkeypatch.setattr(mongo, "close", lambda: None, raising=False)
    monkeypatch.setenv("MONGO_URI", "mongodb://fake")
    monkeypatch.setenv("BATCH_JOB_DEFINITION_ARN", "defn")
    if provider == "aws":
        monkeypatch.setenv("BATCH_JOB_QUEUE_ARN", "arn:aws:batch:us-east-1:1:job-queue/chai-q-queue")
        routing = batch_jobs.RoutingBatchClient(aws=FakeAws(world))
    else:
        monkeypatch.setenv("BATCH_JOB_QUEUE_ARN", "azb-job:chai-q-lab-shadow")
        monkeypatch.setenv("AZURE_BATCH_TASK_ENV_PASSTHROUGH", "")
        routing = batch_jobs.RoutingBatchClient(azure=batch_jobs.AzureBatchJobs(FakeAzureBatchClient(world)))
    monkeypatch.setattr(so.batch_jobs, "client", lambda: routing)
    uuids = (SimpleNamespace(hex=f"{i:032x}") for i in itertools.count())
    monkeypatch.setattr(so.uuid, "uuid4", lambda: next(uuids))

    event = {"episode_id": "ep123456789012345678901234", "codec": codec, "s3_url": "s3://b/k.mp4", "run_id": "run1"}
    resp = so.handler(copy.deepcopy(event), None)
    polls = 0
    while not resp.get("all_done"):
        world.tick()
        if on_poll:
            on_poll()
        resp = so.handler(copy.deepcopy(resp), None)
        polls += 1
        assert polls < 200, "search did not converge"
    return world, resp


def _strip_ids(state):
    s = copy.deepcopy(state)
    for rs in s.get("resolutions", {}).values():
        for entry in rs.get("tested", {}).values():
            entry.pop("job_id", None)
    return s


@freeze_time("2026-09-26 12:00:00")
@pytest.mark.parametrize("codec", ["h264", "h265"])
@pytest.mark.parametrize("fail_every", [0, 4])  # 4: every 4th job fails -> exercises resubmit path
@pytest.mark.parametrize("one_per_tick", [False, True])  # True: slow backend -> exercises discard path
def test_same_decisions_on_aws_and_azure(monkeypatch, codec, fail_every, one_per_tick):
    aws_world, aws_resp = run_search(monkeypatch, "aws", codec, fail_every, one_per_tick)
    az_world, az_resp = run_search(monkeypatch, "azure", codec, fail_every, one_per_tick)
    assert aws_world.submissions, "search submitted nothing"
    assert az_world.submissions == aws_world.submissions
    assert len(az_world.terminations) == len(aws_world.terminations)
    assert _strip_ids(az_resp["search_state"]) == _strip_ids(aws_resp["search_state"])
    assert all(j.startswith("azb:chai-q-lab-shadow/ChaiQSearch-") for j in az_world.jobs)


def test_describe_routes_mixed_ids():
    class A:
        def describe_jobs(self, jobs):
            return {"jobs": [{"jobId": j, "status": "RUNNING"} for j in jobs]}

    class Z:
        def describe_jobs(self, ids):
            return [{"jobId": i, "status": "SUCCEEDED"} for i in ids]

    r = batch_jobs.RoutingBatchClient(aws=A(), azure=Z())
    got = {j["jobId"]: j["status"] for j in r.describe_jobs(["uuid-1", "azb:q/t"])["jobs"]}
    assert got == {"uuid-1": "RUNNING", "azb:q/t": "SUCCEEDED"}


@pytest.mark.parametrize("state,result,expected", [
    ("active", None, "RUNNABLE"), ("preparing", None, "STARTING"), ("running", None, "RUNNING"),
    ("completed", "success", "SUCCEEDED"), ("completed", "failure", "FAILED"),
])
def test_azure_state_mapping(state, result, expected):
    task = SimpleNamespace(state=state, execution_info=SimpleNamespace(result=result))
    assert batch_jobs.map_azure_task(task) == expected


def test_passthrough_env_reaches_task(monkeypatch):
    captured = {}

    class C:
        def create_task(self, job, opts):
            captured.update({s.name: s.value for s in opts.environment_settings})

    monkeypatch.setenv("DB_LAB", "chai_q_lab_shadow")
    monkeypatch.setenv("SHADOW_MODE", "true")
    monkeypatch.delenv("AZURE_BATCH_TASK_ENV_PASSTHROUGH", raising=False)
    batch_jobs.AzureBatchJobs(C()).submit_job("ChaiQSearch-x", "chai-q-lab-shadow", "img",
                                               {"environment": [{"name": "BITRATE", "value": "900"}]})
    assert captured["DB_LAB"] == "chai_q_lab_shadow" and captured["SHADOW_MODE"] == "true"
    assert captured["BITRATE"] == "900"


def test_task_dir_retention_is_short(monkeypatch):
    """Task dirs hold 11 GB+ sources on the node's shared temp disk (Batch default: 7 days)."""
    from datetime import timedelta
    captured = {}

    class C:
        def create_task(self, job, opts):
            captured["c"] = opts.constraints

    batch_jobs.AzureBatchJobs(C()).submit_job("ChaiQSearch-x", "chai-q-lab-shadow", "img", {"environment": []})
    assert captured["c"].retention_time == timedelta(hours=1) and captured["c"].max_task_retry_count == 0
    js = (Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "jobs.js").read_text()
    assert f"TASK_RETENTION = 'PT{batch_jobs.TASK_RETENTION_HOURS}H'" in js


def test_shadow_refuses_every_aws_batch_call(monkeypatch):
    class A:
        def __getattr__(self, name):
            raise AssertionError(f"AWS Batch {name} called from shadow")

    monkeypatch.setenv("SHADOW_MODE", "true")
    r = batch_jobs.RoutingBatchClient(aws=A(), azure=SimpleNamespace(describe_jobs=lambda ids: []))
    for call in (lambda: r.submit_job("j", "chai-q-queue", "chai-q-worker", {}),
                 lambda: r.describe_jobs(["uuid-from-prod"]),
                 lambda: r.terminate_job("uuid-from-prod", "x")):
        with pytest.raises(RuntimeError, match="shadow stamp refuses AWS Batch"):
            call()
    assert r.describe_jobs(["azb:q/t"]) == {"jobs": []}


@pytest.mark.parametrize("codec", ["h264", "h265"])
def test_lost_jobs_time_out_and_terminate_identically(monkeypatch, codec):
    """A job Batch no longer knows about (AWS: absent from describe; Azure: 404) is
    terminated after its hard timeout and resubmitted once - same on both clouds."""
    results = {}
    for provider in ("aws", "azure"):
        with freeze_time("2026-09-26 12:00:00") as frozen:
            world, resp = run_search(monkeypatch, provider, codec, vanish_every=3,
                                     on_poll=lambda: frozen.tick(900))
        results[provider] = (world, resp)
    aws_world, aws_resp = results["aws"]
    az_world, az_resp = results["azure"]
    assert aws_world.terminations, "timeout/terminate path was not exercised"
    assert len(az_world.terminations) == len(aws_world.terminations)
    assert all(t.startswith("azb:") for t in az_world.terminations)
    assert az_world.submissions == aws_world.submissions
    assert _strip_ids(az_resp["search_state"]) == _strip_ids(aws_resp["search_state"])
