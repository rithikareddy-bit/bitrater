"""resign_guard must refuse unsafe config, abort on canary failure, and never write in DRY_RUN."""
import importlib
from datetime import datetime, timezone

import mongomock
import pytest

import resign_guard
import runtime_config

GOOD = {"SIGNING_ENABLED": "true", "SIGNING_MODE": "token", "TOKEN_QUERY_PARAM": "edge-cache-token",
        "SIGNED_URL_TTL_SECONDS": "36000", "MONGO_URI": "mongodb://fake"}
NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)


@pytest.fixture
def world(monkeypatch):
    mongo = mongomock.MongoClient()
    mongo["master"]["showcache"].insert_many([
        {"_id": __import__("bson").ObjectId("64b000000000000000000001"),
         "episodes": [{"id": "e1", "signed_playback_url": "https://cdn.chaishots.in/e1/t/x_combined.m3u8?edge-cache-token=old"},
                      {"id": "e2", "signed_playback_url": "https://cdn.chaishots.in/e2/t/y_combined.m3u8"}],
         "trailers_playback_urls": [{"_key": "k1", "gcpUrl": "https://cdn.chaishots.in/tr/t/z_combined.m3u8"}]},
    ])
    import resign_playback_urls as rp
    monkeypatch.setattr(rp, "_sign", lambda url, now: (url + "?edge-cache-token=SIGNED", now))
    before = list(mongo["master"]["showcache"].find())
    return mongo, before


def _set_lab(monkeypatch, name):
    monkeypatch.setenv("DB_LAB", name)
    importlib.reload(runtime_config)
    monkeypatch.setattr(resign_guard, "runtime_config", runtime_config)


@pytest.fixture(autouse=True)
def _restore():
    yield
    importlib.reload(runtime_config)


def cdn_ok(url):
    return 200 if "SIGNED" in url else 403


@pytest.mark.parametrize("drop", list(resign_guard.EXPECTED_SETTINGS))
def test_refuses_when_a_setting_is_missing(world, monkeypatch, drop):
    mongo, _ = world
    _set_lab(monkeypatch, "chai_q_lab_shadow")
    env = {k: v for k, v in GOOD.items() if k != drop}
    logs = []
    assert resign_guard.run(env, mongo, cdn_ok, NOW, logs.append) == 2
    assert logs[0].startswith("RESIGN_CONFIG_INVALID")


def test_refuses_signature_mode(world, monkeypatch):
    mongo, _ = world
    _set_lab(monkeypatch, "chai_q_lab_shadow")
    assert resign_guard.run({**GOOD, "SIGNING_MODE": "signature"}, mongo, cdn_ok, NOW, lambda m: None) == 2


def test_dry_run_requires_shadow_run_log(world, monkeypatch):
    mongo, _ = world
    _set_lab(monkeypatch, "chai_q_lab")
    logs = []
    assert resign_guard.run(GOOD, mongo, cdn_ok, NOW, logs.append) == 2
    assert "DRY_RUN needs DB_LAB" in logs[0]


def test_dry_run_never_writes_showcache(world, monkeypatch):
    mongo, before = world
    _set_lab(monkeypatch, "chai_q_lab_shadow")
    logs = []
    assert resign_guard.run(GOOD, mongo, cdn_ok, NOW, logs.append) == 0
    assert list(mongo["master"]["showcache"].find()) == before           # prod catalog untouched
    doc = mongo["chai_q_lab_shadow"]["playback_resign_runs"].find_one()
    assert doc["dry_run"] is True and doc["target_count"] == 3 and doc["would_update"] == 3
    assert doc["canary"]["ok"] is True and len(doc["canary"]["checks"]) == 3
    assert mongo["chai_q_lab"]["playback_resign_runs"].count_documents({}) == 0
    assert logs[-1].startswith("RESIGN_DRY_RUN_OK")


@pytest.mark.parametrize("cdn", [
    lambda url: 403,                                   # our tokens rejected
    lambda url: 200,                                   # enforcement off (unsigned plays)
    lambda url: -1,                                    # CDN unreachable
])
def test_canary_failure_aborts_without_writing(world, monkeypatch, cdn):
    mongo, before = world
    _set_lab(monkeypatch, "chai_q_lab")
    import resign_playback_urls as rp
    monkeypatch.setattr(rp, "handler", lambda e, c: pytest.fail("must not run handler"))
    logs = []
    assert resign_guard.run({**GOOD, "DRY_RUN": "false"}, mongo, cdn, NOW, logs.append) == 1
    assert list(mongo["master"]["showcache"].find()) == before
    assert logs[-1].startswith("RESIGN_CANARY_FAIL")
    assert mongo["chai_q_lab"]["playback_resign_runs"].find_one()["canary_failed"] is True


def test_real_run_calls_handler_after_canary(world, monkeypatch):
    mongo, _ = world
    _set_lab(monkeypatch, "chai_q_lab")
    import resign_playback_urls as rp
    called = []
    monkeypatch.setattr(rp, "handler", lambda e, c: called.append(e) or {"updated_count": 3, "errors": []})
    logs = []
    assert resign_guard.run({**GOOD, "DRY_RUN": "false"}, mongo, cdn_ok, NOW, logs.append) == 0
    assert called == [{}] and logs[-1].startswith("RESIGN_OK")


def test_canary_samples_are_deterministic_and_cover_episode_and_trailer():
    targets = [{"episode_id": f"e{i}", "canonical": f"u{i}"} for i in range(10)] + [
        {"episode_id": "trailer_x_k", "canonical": "ut"}]
    a = resign_guard.canary_targets(targets, "2026-09-26")
    assert a == resign_guard.canary_targets(targets, "2026-09-26")
    assert a[0]["episode_id"] == "e0" and a[1]["episode_id"] == "trailer_x_k" and len(a) <= 3


def test_range_206_counts_as_playable(world, monkeypatch):
    """_http_status sends Range: bytes=0-0, so a real CDN answers 206 for a valid token."""
    mongo, _ = world
    _set_lab(monkeypatch, "chai_q_lab_shadow")
    logs = []
    assert resign_guard.run(GOOD, mongo, lambda url: 206 if "SIGNED" in url else 403, NOW, logs.append) == 0
    assert logs[-1].startswith("RESIGN_DRY_RUN_OK")


def test_real_resign_refused_on_shadow_stamp(world, monkeypatch):
    mongo, before = world
    _set_lab(monkeypatch, "chai_q_lab_shadow")
    import resign_playback_urls as rp
    monkeypatch.setattr(rp, "handler", lambda e, c: pytest.fail("must not write prod"))
    logs = []
    env = {**GOOD, "DRY_RUN": "false", "DB_LAB": "chai_q_lab_shadow"}
    assert resign_guard.run(env, mongo, cdn_ok, NOW, logs.append) == 2
    assert "refused on a shadow stamp" in logs[0]
    assert list(mongo["master"]["showcache"].find()) == before


def test_runtime_shadow_tripwire_runs_before_resigner(world, monkeypatch):
    mongo, before = world
    logs = []
    # Job-specific rules: a shadow resigner writing a real (non-dry) run is refused up front.
    env = {**GOOD, "SHADOW_MODE": "true", "DB_LAB": "chai_q_lab_shadow", "DB_MASTER": "master", "DRY_RUN": "false"}
    assert resign_guard.run(env, mongo, cdn_ok, NOW, logs.append) == 2
    assert "Shadow job isolation check failed" in logs[0]
    assert list(mongo["master"]["showcache"].find()) == before


def test_http_status_sends_range_header(monkeypatch):
    import requests
    seen = {}

    class R:
        status_code = 206

    monkeypatch.setattr(requests, "get", lambda url, timeout, headers: seen.update(headers) or R())
    assert resign_guard._http_status("https://cdn.chaishots.in/x_combined.m3u8") == 206
    assert seen == {"Range": "bytes=0-0"}


def test_phase_f_shadow_dry_run_reads_prod_master(world, monkeypatch):
    """Exact Phase F job env: SHADOW_MODE=true, DB_MASTER=master (read), DB_LAB shadow, DRY_RUN."""
    mongo, before = world
    _set_lab(monkeypatch, "chai_q_lab_shadow")
    env = {**GOOD, "SHADOW_MODE": "true", "DB_MASTER": "master", "DB_LAB": "chai_q_lab_shadow", "DRY_RUN": "true"}
    logs = []
    assert resign_guard.run(env, mongo, cdn_ok, NOW, logs.append) == 0
    assert logs[-1].startswith("RESIGN_DRY_RUN_OK")
    assert list(mongo["master"]["showcache"].find()) == before


def test_shadow_job_writing_prod_lab_is_refused(world, monkeypatch):
    mongo, _ = world
    env = {**GOOD, "SHADOW_MODE": "true", "DB_MASTER": "master", "DB_LAB": "chai_q_lab", "DRY_RUN": "true"}
    logs = []
    assert resign_guard.run(env, mongo, cdn_ok, NOW, logs.append) == 2
    assert "RESIGN_CONFIG_INVALID" in logs[0]
