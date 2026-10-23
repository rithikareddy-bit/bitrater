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
      union isfuzzy=true (datatable(TimeGenerated: datetime)[]), ContainerAppConsoleLogs_CL
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
      union isfuzzy=true (datatable(TimeGenerated: datetime)[]), ContainerAppConsoleLogs_CL
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
  # One per stamp, filtered by cloud role (= Function App name): App Insights is shared,
  # so without the filter shadow test failures would page prod on-call.
  for_each            = var.alert_email == "" ? {} : local.app_stamps
  name                = "alert-bitrater-function-exceptions-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_application_insights.main.id]
  description         = "Azure Functions/Durable pipeline exceptions were recorded (${each.key})."
  severity            = each.value.shadow ? 3 : 1
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "microsoft.insights/components"
    metric_name      = "exceptions/count"
    aggregation      = "Count"
    operator         = "GreaterThan"
    threshold        = 5
    dimension {
      name     = "cloud/roleName"
      operator = "Include"
      values   = [azurerm_function_app_flex_consumption.main[each.key].name]
    }
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
      | where OperationName == 'PoolResizeCompleteEvent'
      | where column_ifexists('resultCode_s', '') !in ('', 'Success')
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

# The Replicas metric emits nothing when the app is gone or the environment is down, and
# a metric alert never fires on missing data. An external probe of the (auth-exempt)
# shallow /api/health catches "dashboard unreachable" whatever the cause.
resource "azurerm_application_insights_standard_web_test" "dashboard" {
  for_each                = var.alert_email == "" ? {} : local.dash_stamps
  name                    = "webtest-bitrater-dashboard-${each.key}"
  resource_group_name     = azurerm_resource_group.main.name
  location                = var.location
  application_insights_id = azurerm_application_insights.main.id
  geo_locations           = ["apac-sg-sin-azr", "apac-hk-hkn-azr", "emea-nl-ams-azr", "us-va-ash-azr"]
  frequency               = 300
  timeout                 = 30
  enabled                 = true

  request {
    url = "https://${azurerm_container_app.dashboard[each.key].ingress[0].fqdn}/api/health"
  }
  validation_rules {
    expected_status_code        = 200
    ssl_check_enabled           = true
    ssl_cert_remaining_lifetime = 7
  }
  tags = merge(local.tags, { "hidden-link:${azurerm_application_insights.main.id}" = "Resource" })

  lifecycle { ignore_changes = [tags] } # Azure re-adds the hidden-link tag in its own casing
}

resource "azurerm_monitor_metric_alert" "dashboard_unavailable" {
  for_each            = azurerm_application_insights_standard_web_test.dashboard
  name                = "alert-bitrater-dashboard-unavailable-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value.id, azurerm_application_insights.main.id]
  description         = "The dashboard /api/health probe fails from 2+ locations."
  severity            = local.dash_stamps[each.key].shadow ? 3 : 1
  frequency           = "PT1M"
  window_size         = "PT5M"

  application_insights_web_test_location_availability_criteria {
    web_test_id           = each.value.id
    component_id          = azurerm_application_insights.main.id
    failed_location_count = 2
  }
  action { action_group_id = azurerm_monitor_action_group.oncall[0].id }
}

# Crash loop: the replica exists (Replicas = 1) but keeps restarting.
resource "azurerm_monitor_metric_alert" "dashboard_restarts" {
  for_each            = var.alert_email == "" ? {} : local.dash_stamps
  name                = "alert-bitrater-dashboard-restarts-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.dashboard[each.key].id]
  description         = "The dashboard container restarted repeatedly."
  severity            = each.value.shadow ? 3 : 1
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "RestartCount"
    aggregation      = "Maximum"
    operator         = "GreaterThan"
    threshold        = 2
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
      union isfuzzy=true (datatable(TimeGenerated: datetime)[]), ContainerAppSystemLogs_CL, ContainerAppConsoleLogs_CL
      | where column_ifexists('ContainerJobName_s', '') startswith 'acaj-bitrater-${each.key}-'
          or column_ifexists('ContainerGroupName_s', '') startswith 'acaj-bitrater-${each.key}-'
      | where column_ifexists('Reason_s', '') has_any ('Failed', 'Error')
          or column_ifexists('Log_s', '') has_any ('Traceback', 'URL_HEALTH_ERROR', 'BATCH_CLEANUP_ERROR',
               'WORKFLOW_WATCHDOG_ERROR', 'RESIGNER_ERROR', 'RESIGN_PARTIAL')
    KQL
    time_aggregation_method = "Count"
    operator                = "GreaterThan"
    threshold               = 0
  }
  action { action_groups = [azurerm_monitor_action_group.oncall[0].id] }
}
