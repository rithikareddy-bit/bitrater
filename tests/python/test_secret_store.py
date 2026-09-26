"""secret_store: AWS path must be the same Secrets Manager call as before; kv: goes to Key Vault."""
import json
from types import SimpleNamespace

import boto3
import pytest
from botocore.stub import Stubber

import secret_store


@pytest.fixture(autouse=True)
def _region(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setattr(secret_store, "_kv_client", None)


def test_arn_goes_to_secrets_manager(monkeypatch):
    sm = boto3.client("secretsmanager", region_name="us-east-1")
    stub = Stubber(sm)
    arn = "arn:aws:secretsmanager:us-east-1:1:secret:chai-q-gcp-credentials"
    stub.add_response("get_secret_value", {"SecretString": json.dumps({"type": "service_account"})},
                      {"SecretId": arn})
    monkeypatch.setattr(boto3, "client", lambda name, **kw: sm if name == "secretsmanager" else None)
    with stub:
        assert secret_store.get_json(arn) == {"type": "service_account"}
    stub.assert_no_pending_responses()


def test_plain_secret_name_also_goes_to_secrets_manager(monkeypatch):
    # resign uses SIGNING_KEY_SECRET_ID="chai-q/media-cdn-signing-key" (a name, not an ARN)
    calls = []
    fake = SimpleNamespace(get_secret_value=lambda SecretId: calls.append(SecretId) or {"SecretString": "{}"})
    monkeypatch.setattr(boto3, "client", lambda name, **kw: fake)
    secret_store.get_json("chai-q/media-cdn-signing-key")
    assert calls == ["chai-q/media-cdn-signing-key"]


def test_kv_prefix_goes_to_key_vault(monkeypatch):
    got = []

    class FakeKV:
        def get_secret(self, name):
            got.append(name)
            return SimpleNamespace(value=json.dumps({"key_name": "k"}))

    monkeypatch.setattr(secret_store, "_kv_client", FakeKV())
    monkeypatch.setattr(boto3, "client", lambda *a, **k: pytest.fail("must not touch AWS"))
    assert secret_store.get_json("kv:media-cdn-signing-key") == {"key_name": "k"}
    assert got == ["media-cdn-signing-key"]


def test_no_module_calls_secrets_manager_directly():
    from pathlib import Path
    root = Path(__file__).resolve().parents[2] / "orchestrator"
    ported = ["gcp_check_status", "gcp_audio_transcoder", "gcp_check_audio_status", "gcp_copy_s3_to_gcs",
              "gcp_copy_audio_to_gcs", "gcp_create_combined_master", "gcp_finalize_hls", "gcp_transcoder",
              "resign_playback_urls"]
    offenders = [m for m in ported if 'client("secretsmanager")' in (root / f"{m}.py").read_text()]
    assert offenders == []
