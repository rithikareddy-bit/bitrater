"""runtime_config defaults must reproduce the pre-migration literals exactly."""
import importlib

import pytest

import runtime_config

NAME_VARS = ("DB_LAB", "DB_MASTER", "DB_SUBTITLES", "CDN_BUCKET", "CLOUD_PROVIDER", "SHADOW_MODE")


@pytest.fixture(autouse=True)
def _restore_module():
    # Reloading with test env must not leak into other test modules.
    yield
    importlib.reload(runtime_config)


def _reload(monkeypatch, **env):
    for var in NAME_VARS:
        monkeypatch.delenv(var, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return importlib.reload(runtime_config)


def test_defaults_equal_prod_literals(monkeypatch):
    rc = _reload(monkeypatch)
    assert rc.DB_LAB == "chai_q_lab"
    assert rc.DB_MASTER == "master"
    assert rc.DB_SUBTITLES == "gld2sqs"
    assert rc.CDN_BUCKET == "chai-shots-manifests"
    assert rc.CLOUD_PROVIDER == "aws"
    assert rc.SHADOW_MODE is False


def test_env_overrides(monkeypatch):
    rc = _reload(monkeypatch, DB_LAB="chai_q_lab_shadow", CDN_BUCKET="chai-q-az-shadow-manifests")
    assert rc.DB_LAB == "chai_q_lab_shadow"
    assert rc.CDN_BUCKET == "chai-q-az-shadow-manifests"


def test_isolation_is_noop_in_prod():
    runtime_config.assert_isolation({})  # prod: no SHADOW_MODE, nothing to check


GOOD_SHADOW = {
    "SHADOW_MODE": "true",
    "DB_LAB": "chai_q_lab_shadow",
    "DB_MASTER": "master_shadow",
    "CDN_BUCKET": "chai-q-az-shadow-manifests",
    "GCS_INPUT_BUCKET": "chai-q-az-shadow-input",
    "GCS_OUTPUT_BUCKET": "chai-q-az-shadow-output",
    "AUDIO_PUBLIC_BUCKET": "chai-q-az-shadow-audio",
    "SKIP_CDN_INVALIDATION": "1",
    "RESIGN_INVOKE_MODE": "inprocess",
}


def test_isolation_passes_for_full_shadow_config():
    runtime_config.assert_isolation(GOOD_SHADOW)


@pytest.mark.parametrize("var,value", [
    ("DB_LAB", "chai_q_lab"),
    ("DB_MASTER", "master"),
    ("CDN_BUCKET", "chai-shots-manifests"),
    ("GCS_OUTPUT_BUCKET", "chai-q-transcoder-output"),
    ("GCS_INPUT_BUCKET", "chai-q-transcoder-input"),
    ("AUDIO_PUBLIC_BUCKET", "chai-q-audio-public"),
    ("SKIP_CDN_INVALIDATION", "0"),
    ("RESIGN_INVOKE_MODE", "lambda"),
])
def test_isolation_rejects_any_prod_name(var, value):
    env = dict(GOOD_SHADOW, **{var: value})
    with pytest.raises(runtime_config.IsolationError, match=var):
        runtime_config.assert_isolation(env)


def test_isolation_rejects_unset_names_in_shadow():
    # SHADOW_MODE alone: DB defaults are prod names -> must refuse
    with pytest.raises(runtime_config.IsolationError):
        runtime_config.assert_isolation({"SHADOW_MODE": "true", "SKIP_CDN_INVALIDATION": "1"})


@pytest.mark.parametrize("job,env,ok", [
    # Phase F: shadow resigner dry run reads prod master
    ("resigner", {"SHADOW_MODE": "true", "DB_MASTER": "master", "DB_LAB": "chai_q_lab_shadow", "DRY_RUN": "true"}, True),
    ("resigner", {"SHADOW_MODE": "true", "DB_MASTER": "master", "DB_LAB": "chai_q_lab_shadow", "DRY_RUN": "false"}, False),
    # G1 compare: shadow url-health reads prod master, writes shadow lab
    ("url_health", {"SHADOW_MODE": "true", "DB_MASTER": "master", "DB_LAB": "chai_q_lab_shadow"}, True),
    ("url_health", {"SHADOW_MODE": "true", "DB_MASTER": "master", "DB_LAB": "chai_q_lab"}, False),
    ("batch_cleanup", {"SHADOW_MODE": "true", "DB_LAB": "chai_q_lab_shadow"}, True),
    ("resigner", {"DB_LAB": "chai_q_lab", "DRY_RUN": "false"}, True),          # prod stamp: no shadow rules
    ("nope", {}, False),
])
def test_job_isolation(job, env, ok):
    assert (runtime_config.job_isolation_violations(job, env) == []) is ok
