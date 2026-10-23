# Shared foundation for both stamps: resource group, logs, registry, Key Vault,
# Container Apps environment, Batch. Nothing here reads or writes prod data.
# Pre-step (approval): `az provider register -n Microsoft.Batch` (not registered yet).

data "azurerm_client_config" "current" {}

locals {
  tags = { project = "bitrater", managed_by = "terraform", source = "azure-infra" }
}

resource "azurerm_resource_group" "main" {
  name     = "rg-bitrater-prod"
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-bitrater"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "appi-bitrater"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "web"
  tags                = local.tags
}

resource "azurerm_container_registry" "main" {
  name                = "bitraterprodacr"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  sku                 = "Standard"
  admin_enabled       = false
  tags                = local.tags
}

# Secrets are NOT managed by Terraform (values never enter state); they are written
# by scripts/copy_secrets_sm_to_kv.sh (A5) and scripts/publish_functions.sh (D).
# Access is granted per secret (stamps.tf), so the shadow stamp cannot read prod secrets.
resource "azurerm_key_vault" "main" {
  name                       = "kv-bitrater-prod"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = var.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 30
  tags                       = local.tags
}

resource "azurerm_role_assignment" "kv_officer_deployer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_container_app_environment" "main" {
  name                       = "cae-bitrater"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = var.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  # Azure adds the built-in Consumption profile on create; declare it so plans stay clean
  # (seen after A2 on 2026-09-27: otherwise every plan tries to remove it).
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
  tags = local.tags
}

# --- Azure Batch (research lab + ViSQOL) ---------------------------------------
# BatchService allocation mode: Spot (low-priority) cores come from the BATCH ACCOUNT
# quota (request an increase for the account in A3, after it exists), not the
# subscription's regional Spot quota. Pool starts at 0 nodes, autoscales on pending tasks.
# Every stamp has a separate pool identity. This is an isolation boundary: a
# shadow task must never be able to retrieve a production secret.
resource "azurerm_user_assigned_identity" "batch" {
  for_each            = local.enabled_stamps
  name                = "id-bitrater-${each.key}-batch"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  tags                = local.tags
}

resource "azurerm_role_assignment" "batch_acr_pull" {
  for_each             = local.enabled_stamps
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.batch[each.key].principal_id
}

resource "azurerm_batch_account" "main" {
  for_each             = local.enabled_stamps
  name                 = "bitraterbatch${each.key}"
  resource_group_name  = azurerm_resource_group.main.name
  location             = var.location
  pool_allocation_mode = "BatchService"
  tags                 = local.tags
}

locals {
  batch_pool = { for k, s in local.enabled_stamps : k => {
    vm_size       = coalesce(try(var.batch_pool_overrides[k].vm_size, null), var.batch_vm_size)
    image_version = coalesce(try(var.batch_pool_overrides[k].image_version, null), var.batch_image_version)
    # Never ask for more nodes than the granted quota allows (4 vCPU per node).
    max_nodes = max(0, min(lookup(var.batch_max_spot_nodes, k, 1), floor(lookup(var.batch_spot_core_quota, k, 6) / 4)))
  } }
}

resource "azurerm_batch_pool" "spot" {
  for_each            = local.enabled_stamps
  name                = "chai-q-spot-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  account_name        = azurerm_batch_account.main[each.key].name
  vm_size             = local.batch_pool[each.key].vm_size
  node_agent_sku_id   = var.batch_image.node_agent_sku_id
  max_tasks_per_node  = 1

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.batch[each.key].id]
  }

  storage_image_reference {
    publisher = var.batch_image.publisher
    offer     = var.batch_image.offer
    sku       = var.batch_image.sku
    version   = local.batch_pool[each.key].image_version
  }

  container_configuration {
    type = "DockerCompatible"
    container_registries {
      registry_server           = azurerm_container_registry.main.login_server
      user_assigned_identity_id = azurerm_user_assigned_identity.batch[each.key].id
    }
  }

  auto_scale {
    evaluation_interval = "PT5M"
    formula             = <<-EOT
      $samples = $PendingTasks.GetSamplePercent(TimeInterval_Minute * 5);
      $tasks = $samples < 70 ? max(0, $PendingTasks.GetSample(1)) : max($PendingTasks.GetSample(1), avg($PendingTasks.GetSample(TimeInterval_Minute * 5)));
      $TargetLowPriorityNodes = min(${local.batch_pool[each.key].max_nodes}, $tasks);
      $TargetDedicatedNodes = 0;
      $NodeDeallocationOption = taskcompletion;
    EOT
  }

  depends_on = [azurerm_role_assignment.batch_acr_pull]

  lifecycle {
    precondition {
      condition     = each.value.shadow || each.value.cloud_provider != "azure" || local.batch_pool[each.key].max_nodes >= 128 || var.accept_reduced_lab_capacity
      error_message = "Prod lab capacity is ${local.batch_pool[each.key].max_nodes} nodes (< 128 = AWS 512 vCPU). Get the Spot quota granted and set batch_spot_core_quota.${each.key}, or set accept_reduced_lab_capacity = true."
    }
  }
}

# --- Shadow upload target (own account; never another team's container) -------
resource "azurerm_storage_account" "shadow_uploads" {
  name                            = "bitratershadowup"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = true # sources are fetched by URL (copy step, workers), like sanity-dev-store
  blob_properties {
    cors_rule {
      allowed_origins    = ["*"]
      allowed_methods    = ["GET", "HEAD", "PUT", "OPTIONS"]
      allowed_headers    = ["*"]
      exposed_headers    = ["ETag"]
      max_age_in_seconds = 3600
    }
  }
  tags = local.tags
}

resource "azurerm_storage_container" "shadow_uploads" {
  name                  = "uploads-shadow"
  storage_account_id    = azurerm_storage_account.shadow_uploads.id
  container_access_type = "blob"
}
