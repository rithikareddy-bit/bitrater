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


def test_scheduled_jobs_get_shadow_tripwire_and_cleanup():
    stamps = text("azure-infra/stamps.tf")
    assert 'job = "batch_cleanup"' in stamps
    assert 'job = "workflow_watchdog"' in stamps
    for name in ("SHADOW_MODE", "CDN_BUCKET", "SKIP_CDN_INVALIDATION", "RESIGN_INVOKE_MODE"):
        assert name in stamps


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
