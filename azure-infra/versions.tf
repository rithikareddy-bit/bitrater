terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.40" }
    azapi   = { source = "azure/azapi", version = "~> 2.5" }
  }
  # State in the bootstrap storage account (azure-infra/bootstrap), AAD auth.
  backend "azurerm" {
    resource_group_name  = "rg-bitrater-tfstate"
    storage_account_name = "bitratertfstate"
    container_name       = "tfstate"
    key                  = "bitrater.tfstate"
    use_azuread_auth     = true
    subscription_id      = "ff1dad43-0464-4958-8179-94669f96c927"
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }
  subscription_id = var.subscription_id
}

provider "azapi" {}
