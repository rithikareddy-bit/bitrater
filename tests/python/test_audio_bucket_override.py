"""Audio modules: AUDIO_GCS_BUCKET overrides the shared GCS_* names (Azure); unset = AWS behaviour."""
import re
from pathlib import Path

import pytest

import runtime_config

ROOT = Path(__file__).resolve().parents[2] / "orchestrator"


@pytest.mark.parametrize("module", ["gcp_copy_audio_to_gcs", "gcp_audio_transcoder", "gcp_check_audio_status"])
def test_every_gcs_bucket_read_in_audio_modules_honours_override(module):
    src = (ROOT / f"{module}.py").read_text()
    reads = re.findall(r'os\.environ(?:\.get\(|\[)"GCS_(?:INPUT|OUTPUT)_BUCKET"', src)
    guarded = re.findall(r'os\.environ\.get\("AUDIO_GCS_BUCKET"\) or os\.environ(?:\.get\(|\[)"GCS_(?:INPUT|OUTPUT)_BUCKET"', src)
    assert reads and len(reads) == len(guarded)


def test_shadow_isolation_checks_audio_bucket():
    env = {"SHADOW_MODE": "true", "DB_LAB": "chai_q_lab_shadow", "DB_MASTER": "master_shadow",
           "CDN_BUCKET": "chai-q-az-shadow-manifests", "SKIP_CDN_INVALIDATION": "1",
           "AUDIO_GCS_BUCKET": "chai-q-audio-transcoder", "RESIGN_INVOKE_MODE": "inprocess"}
    with pytest.raises(runtime_config.IsolationError, match="AUDIO_GCS_BUCKET"):
        runtime_config.assert_isolation(env)
