# Alerts that protect playback: the resigner must succeed every 2 h (tokens live 10 h).
# column_ifexists(): Container Apps job log columns are verified after the first run (A6/F).

resource "azurerm_monitor_action_group" "oncall" {
  count               = var.alert_email == "" ? 0 : 1
  name                = "ag-bitrater-oncall"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = "bitrater"
  email_receiver {
    name          = "oncall"
    email_address = var.alert_email
  }
}

locals {
  resign_writing = { for k, s in local.app_stamps : k => s if s.resigner.enabled && !s.resigner.dry_run }
  resign_on      = { for k, s in local.app_stamps : k => s if s.resigner.enabled }
  job_filter     = "(column_ifexists('ContainerJobName_s', '') == '%s' or column_ifexists('ContainerAppName_s', '') == '%s' or column_ifexists('ContainerGroupName_s', '') startswith '%s')"
}

resource "azurerm_monitor_diagnostic_setting" "batch" {
  for_each                   = azurerm_batch_account.main
  name                       = "batch-to-log-analytics"
  target_resource_id         = each.value.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log { category_group = "allLogs" }
  enabled_metric { category = "AllMetrics" }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "resign_stale" {
  for_each             = local.resign_writing
  name                 = "alert-bitrater-resign-stale-${each.key}"
  resource_group_name  = azurerm_resource_group.main.name
  location             = var.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 1
  evaluation_frequency = "PT15M"
  window_duration      = "PT3H"
  criteria {
    query                   = <<-KQL
      ContainerAppConsoleLogs_CL
      | where ${format(local.job_filter, "acaj-bitrater-${each.key}-resigner", "acaj-bitrater-${each.key}-resigner", "acaj-bitrater-${each.key}-resigner")}
      | where column_ifexists('Log_s', '') has "RESIGN_OK"
    KQL
    time_aggregation_method = "Count"
    operator                = "LessThan"
    threshold               = 1
  }
  action {
    action_groups = azurerm_monitor_action_group.oncall[*].id
  }
  description = "No successful resign in 3 h: signed playback URLs expire 10 h after signing."

  lifecycle {
    precondition {
      condition     = var.alert_email != ""
      error_message = "Set alert_email before the resigner writes (dry_run=false): playback depends on this alert."
    }
  }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "resign_refused" {
  for_each             = local.resign_on
  name                 = "alert-bitrater-resign-refused-${each.key}"
  resource_group_name  = azurerm_resource_group.main.name
  location             = var.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 1
  evaluation_frequency = "PT15M"
  window_duration      = "PT15M"
  criteria {
    query                   = <<-KQL
      ContainerAppConsoleLogs_CL
      | where ${format(local.job_filter, "acaj-bitrater-${each.key}-resigner", "acaj-bitrater-${each.key}-resigner", "acaj-bitrater-${each.key}-resigner")}
      | where column_ifexists('Log_s', '') has "RESIGN_CANARY_FAIL" or column_ifexists('Log_s', '') has "RESIGN_CONFIG_INVALID"
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }
  action {
    action_groups = azurerm_monitor_action_group.oncall[*].id
  }
  description = "Resigner refused to write (bad config or tokens not accepted by the CDN)."
}

# Function/Durable activity failures surface through the workspace-based App
# Insights resource. This complements the workflow status UI: operators are
# alerted even when nobody is polling a failed instance.
resource "azurerm_monitor_metric_alert" "function_exceptions" {
  count               = var.alert_email == "" ? 0 : 1
  name                = "alert-bitrater-function-exceptions"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_application_insights.main.id]
  description         = "Azure Functions/Durable pipeline exceptions were recorded."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "microsoft.insights/components"
    metric_name      = "exceptions/count"
    aggregation      = "Count"
    operator         = "GreaterThan"
    threshold        = 0
  }
  action { action_group_id = azurerm_monitor_action_group.oncall[0].id }
}

# A failed Batch task or allocation event can otherwise leave a lab waiting for
# its application-level timeout. The account covers both isolated stamp pools.
resource "azurerm_monitor_metric_alert" "batch_task_failures" {
  for_each            = var.alert_email == "" ? {} : azurerm_batch_account.main
  name                = "alert-bitrater-batch-task-failures-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value.id]
  description         = "One or more Azure Batch tasks failed."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.Batch/batchAccounts"
    metric_name      = "TaskFailEvent"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 0
  }
  action { action_group_id = azurerm_monitor_action_group.oncall[0].id }
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "batch_allocation_failures" {
  count                = var.alert_email == "" ? 0 : 1
  name                 = "alert-bitrater-batch-allocation-failures"
  resource_group_name  = azurerm_resource_group.main.name
  location             = var.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 1
  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"
  criteria {
    query                   = <<-KQL
      AzureDiagnostics
      | where ResourceProvider == 'MICROSOFT.BATCH'
      | where OperationName has_any ('PoolResize', 'Node')
      | where ResultType !in ('Success', 'Succeeded') or Level == 'Error'
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }
  action { action_groups = [azurerm_monitor_action_group.oncall[0].id] }
}

resource "azurerm_monitor_metric_alert" "dashboard_no_replicas" {
  for_each            = var.alert_email == "" ? {} : local.dash_stamps
  name                = "alert-bitrater-dashboard-down-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.dashboard[each.key].id]
  description         = "The dashboard has no healthy running replica."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Replicas"
    aggregation      = "Average"
    operator         = "LessThan"
    threshold        = 1
  }
  action { action_group_id = azurerm_monitor_action_group.oncall[0].id }
}

# Container Apps Job failures include url-health, resigner and Batch cleanup.
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "scheduled_job_failed" {
  for_each             = var.alert_email == "" ? {} : local.app_stamps
  name                 = "alert-bitrater-scheduled-job-failed-${each.key}"
  resource_group_name  = azurerm_resource_group.main.name
  location             = var.location
  scopes               = [azurerm_log_analytics_workspace.main.id]
  severity             = 1
  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"
  criteria {
    query                   = <<-KQL
      union isfuzzy=true ContainerAppSystemLogs_CL, ContainerAppConsoleLogs_CL
      | where column_ifexists('ContainerJobName_s', '') startswith 'acaj-bitrater-${each.key}-'
          or column_ifexists('ContainerGroupName_s', '') startswith 'acaj-bitrater-${each.key}-'
      | where column_ifexists('Reason_s', '') has_any ('Failed', 'Error')
          or column_ifexists('Log_s', '') has_any ('Traceback', 'URL_HEALTH_ERROR', 'BATCH_CLEANUP_ERROR')
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }
  action { action_groups = [azurerm_monitor_action_group.oncall[0].id] }
}
