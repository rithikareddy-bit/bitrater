"""run_handler: Lambda-style results and errors, allowlist, shadow isolation."""
import sys
import types

import pytest

from bitrater_wf import handlers
from bitrater_wf.sfn import ERROR_KEY


def test_runs_handler_and_returns_result(monkeypatch):
    mod = types.ModuleType("aggregator")
    mod.handler = lambda event, ctx: {"echo": event, "ctx": ctx}
    monkeypatch.setitem(sys.modules, "aggregator", mod)
    assert handlers.run("aggregator", {"a": 1}) == {"echo": {"a": 1}, "ctx": None}


def test_exception_becomes_lambda_error_payload(monkeypatch):
    mod = types.ModuleType("mark_lab_failed")

    def boom(event, ctx):
        raise ValueError("bad input")

    mod.handler = boom
    monkeypatch.setitem(sys.modules, "mark_lab_failed", mod)
    out = handlers.run("mark_lab_failed", {})
    assert out[ERROR_KEY]["errorMessage"] == "bad input"
    assert out[ERROR_KEY]["errorType"] == "ValueError"
    assert isinstance(out[ERROR_KEY]["stackTrace"], list) and out[ERROR_KEY]["stackTrace"]


def test_module_allowlist():
    out = handlers.run("os", {})
    assert out[ERROR_KEY]["errorType"] == "ValueError"
    assert set(handlers.INVOKE_FUNCTIONS.values()) <= handlers.ALLOWED_MODULES


def test_shadow_misconfiguration_refuses_before_running(monkeypatch):
    mod = types.ModuleType("aggregator")
    mod.handler = lambda e, c: pytest.fail("must not run")
    monkeypatch.setitem(sys.modules, "aggregator", mod)
    monkeypatch.setenv("SHADOW_MODE", "true")
    monkeypatch.setenv("DB_LAB", "chai_q_lab")  # prod name in shadow -> refuse
    out = handlers.run("aggregator", {})  # reported like a function error -> SFN-style Catch runs
    assert out[ERROR_KEY]["errorType"] == "IsolationError"
    assert "Shadow isolation" in out[ERROR_KEY]["errorMessage"]
