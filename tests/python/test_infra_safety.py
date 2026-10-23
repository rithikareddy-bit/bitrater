"""Static safety invariants for Azure infrastructure that must not regress."""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def text(path):
    return (ROOT / path).read_text()


def test_batch_identity_and_pool_are_per_stamp():
    foundation = text("azure-infra/foundation.tf")
    stamps = text("azure-infra/stamps.tf")
    assert 'name                = "id-bitrater-${each.key}-batch"' in foundation
    assert 'name                = "chai-q-spot-${each.key}"' in foundation
    assert 'name                 = "bitraterbatch${each.key}"' in foundation
    assert "azurerm_user_assigned_identity.batch[k].principal_id" in stamps
    assert "azurerm_batch_pool.spot[each.key].id" in stamps


def test_dashboard_auth_and_immutable_artifacts_fail_closed():
    variables = text("azure-infra/variables.tf")
    stamps = text("azure-infra/stamps.tf")
    assert 'var.entra_client_id != ""' in stamps
    assert "clientSecretSettingName" in stamps
    assert "repository@sha256" in variables
    assert 'lower(var.batch_image_version) != "latest"' in variables
    next_config = text("dashboard/next.config.js")
    assert "**.amazonaws.com" in next_config and "**.blob.core.windows.net" in next_config


def test_scheduled_jobs_get_shadow_tripwire_and_cleanup():
    stamps = text("azure-infra/stamps.tf")
    assert 'job = "batch_cleanup"' in stamps
    assert 'job = "workflow_watchdog"' in stamps
    for name in ("SHADOW_MODE", "CDN_BUCKET", "SKIP_CDN_INVALIDATION", "RESIGN_INVOKE_MODE"):
        assert name in stamps
    assert "LAB_COMPUTE_PROVIDER" in stamps and "LAB_WORKER_CAPACITY" in stamps
    assert text("scripts/cutover/audit_legacy_s3_trigger.sh").startswith("#!/usr/bin/env bash")


def test_container_app_job_names_fit_azure_limit():
    """Container Apps job names are limited to 32 chars; `terraform validate` does not catch it."""
    import re
    from pathlib import Path
    stamps_tf = (Path(__file__).resolve().parents[2] / "azure-infra" / "stamps.tf").read_text()
    keys = re.findall(r'"\$\{k\}-([a-z-]+)" =>', stamps_tf)
    assert keys, "no scheduled job keys found"
    for stamp in ("shadow", "prod"):
        for key in keys:
            name = f"acaj-bitrater-{stamp}-{key}"
            assert len(name) <= 32, f"{name} is {len(name)} chars"


def test_function_app_always_sends_empty_azurewebjobsstorage():
    """If Terraform omits AzureWebJobsStorage (e.g. via ignore_changes), the Flex provider
    re-injects a connection string with an EMPTY AccountKey and the Functions host stops
    (verified live 2026-09-27). The explicit empty value must stay and must not be ignored."""
    import re
    from pathlib import Path
    tf = (Path(__file__).resolve().parents[2] / "azure-infra" / "stamps.tf").read_text()
    assert re.search(r'^\s*AzureWebJobsStorage\s*=\s*""', tf, re.M)
    assert not re.search(r'ignore_changes\s*=\s*\[[^\]]*AzureWebJobsStorage', tf)


def test_copy_step_memory_fits_the_flex_instance():
    """3 concurrent copies (host.json) x 2 x PART_SIZE x COPY_MAX_WORKERS must leave headroom
    on the Flex instance; AWS keeps the 16-worker default on its own Lambda."""
    import json
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    tf = (root / "azure-infra" / "stamps.tf").read_text()
    workers = int(re.search(r'COPY_MAX_WORKERS\s*=\s*"(\d+)"', tf).group(1))
    mem_mb = int(re.search(r"instance_memory_in_mb\s*=\s*(\d+)", tf).group(1))
    host = json.loads((root / "azure-functions" / "host.json").read_text())
    concurrent = host["extensions"]["durableTask"]["maxConcurrentActivityFunctions"]
    peak_mb = concurrent * 2 * 64 * workers
    assert peak_mb <= mem_mb * 0.6, f"copy peak {peak_mb} MiB vs {mem_mb} MiB instance"
    src = (root / "orchestrator" / "gcp_copy_s3_to_gcs.py").read_text()
    assert 'os.environ.get("COPY_MAX_WORKERS", "16")' in src  # AWS behaviour unchanged
