output "acr_login_server" { value = azurerm_container_registry.main.login_server }
output "key_vault_uri" { value = azurerm_key_vault.main.vault_uri }
output "batch_endpoints" { value = local.batch_endpoints }
output "function_apps" { value = { for k, f in azurerm_function_app_flex_consumption.main : k => f.default_hostname } }
output "dashboards" { value = { for k, d in azurerm_container_app.dashboard : k => d.ingress[0].fqdn } }
output "batch_pool_client_ids" { value = { for k, identity in azurerm_user_assigned_identity.batch : k => identity.client_id } }
