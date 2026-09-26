# One-time: storage for azure-infra's remote Terraform state (local state here).
# Apply needs approval (AZURE-MIGRATION-PLAN.md P8, Phase A1).
terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.40" }
  }
}

provider "azurerm" {
  features {
    storage {
      data_plane_available = false # shared keys off + Owner has no data actions: manage via ARM only
    }
  }
  subscription_id     = var.subscription_id
  storage_use_azuread = true # shared keys are disabled on the state account
}

data "azurerm_client_config" "current" {}

variable "subscription_id" {
  type    = string
  default = "ff1dad43-0464-4958-8179-94669f96c927"
}

resource "azurerm_resource_group" "tfstate" {
  name     = "rg-bitrater-tfstate"
  location = "centralindia"
  tags     = { project = "bitrater", purpose = "tfstate" }
}

resource "azurerm_storage_account" "tfstate" {
  name                            = "bitratertfstate"
  resource_group_name             = azurerm_resource_group.tfstate.name
  location                        = azurerm_resource_group.tfstate.location
  account_tier                    = "Standard"
  account_replication_type        = "ZRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  blob_properties {
    versioning_enabled = true
  }
}

resource "azurerm_storage_container" "tfstate" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.tfstate.id
  container_access_type = "private"
}

# The backend uses AAD auth (use_azuread_auth); Owner has no blob data actions.
resource "azurerm_role_assignment" "tfstate_deployer" {
  scope                = azurerm_storage_account.tfstate.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}
