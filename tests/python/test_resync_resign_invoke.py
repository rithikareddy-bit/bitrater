"""resync_subtitles._invoke_resign: default path unchanged (Lambda); inprocess only when flagged."""
import io
import json
import sys
import types

import pytest

import resync_subtitles as rs


def test_default_invokes_lambda_with_same_payload(monkeypatch):
    monkeypatch.delenv("RESIGN_INVOKE_MODE", raising=False)
    monkeypatch.setattr(rs, "RESIGN_LAMBDA_ARN", "arn:aws:lambda:us-east-1:1:function:chai-q-resign-playback-urls")
    calls = []

    class FakeLambda:
        def invoke(self, **kw):
            calls.append(kw)
            return {"Payload": io.BytesIO(b'{"signed": true}')}

    monkeypatch.setattr(rs, "_lambda_client", FakeLambda())
    assert rs._invoke_resign("ep1", "https://cdn/x_combined.m3u8") == {"signed": True}
    assert calls == [{
        "FunctionName": "arn:aws:lambda:us-east-1:1:function:chai-q-resign-playback-urls",
        "InvocationType": "RequestResponse",
        "Payload": json.dumps({"episode_id": "ep1", "canonical_url": "https://cdn/x_combined.m3u8"}).encode(),
    }]


def test_default_still_fails_loud_without_arn(monkeypatch):
    monkeypatch.delenv("RESIGN_INVOKE_MODE", raising=False)
    monkeypatch.setattr(rs, "RESIGN_LAMBDA_ARN", None)
    with pytest.raises(RuntimeError, match="RESIGN_PLAYBACK_URLS_LAMBDA_ARN"):
        rs._invoke_resign("ep1", "u")


def test_inprocess_calls_handler_not_lambda(monkeypatch):
    monkeypatch.setenv("RESIGN_INVOKE_MODE", "inprocess")
    monkeypatch.setattr(rs, "RESIGN_LAMBDA_ARN", None)
    monkeypatch.setattr(rs, "_lambda_client", None)
    fake = types.ModuleType("resign_playback_urls")
    fake.handler = lambda event, ctx: {"episode_id": event["episode_id"], "signed": True}
    monkeypatch.setitem(sys.modules, "resign_playback_urls", fake)
    monkeypatch.setattr(rs.boto3, "client", lambda *a, **k: pytest.fail("must not call AWS"))
    assert rs._invoke_resign("ep1", "u") == {"episode_id": "ep1", "signed": True}
