# One "stamp" = a full copy of the pipeline (identities, Function App, Batch jobs,
# dashboard, scheduled jobs) with its own names. shadow uses *_shadow DBs +
# chai-q-az-shadow-* buckets + SHADOW_MODE=true (every entrypoint refuses to start
# otherwise) and identities that can only read shadow secrets; prod uses today's
# names. Phase switches live in var.stamps. See AZURE-MIGRATION-PLAN.md.

locals {
  enabled_stamps = { for k, s in var.stamps : k => s if s.enabled }
  app_stamps     = { for k, s in local.enabled_stamps : k => s if s.apps }
  dash_stamps    = { for k, s in local.app_stamps : k => s if s.dashboard_replicas == 1 } # 0 = no dashboard (Container Apps needs max >= 1)

  names = { for k, s in local.enabled_stamps : k => {
    db_lab       = s.shadow ? "chai_q_lab_shadow" : "chai_q_lab"
    db_master    = s.shadow ? "master_shadow" : "master"
    gcs_input    = s.shadow ? "chai-q-az-shadow-input" : "chai-q-transcoder-input"
    gcs_output   = s.shadow ? "chai-q-az-shadow-output" : "chai-q-transcoder-output"
    cdn_bucket   = s.shadow ? "chai-q-az-shadow-manifests" : "chai-shots-manifests"
    audio_bucket = s.shadow ? "chai-q-az-shadow-audio" : "chai-q-audio-transcoder"
    audio_public = s.shadow ? "chai-q-az-shadow-audio" : "chai-q-audio-public"
    cdn_base     = s.shadow ? "https://storage.googleapis.com/chai-q-az-shadow-manifests" : var.cdn_base
    upload_acct  = s.shadow ? azurerm_storage_account.shadow_uploads.name : var.prod_upload.account
    upload_cont  = s.shadow ? azurerm_storage_container.shadow_uploads.name : var.prod_upload.container
    kv_mongo     = s.shadow ? "mongo-uri-shadow" : "mongo-uri" # shadow URI carries appName=bitrater-azure-shadow (tripwire)
    kv_subtitle  = "subtitle-mongo-uri"
    kv_gcp       = s.shadow ? "gcp-credentials-shadow" : "gcp-credentials" # shadow SA cannot write prod buckets
    kv_aws       = s.aws_key                                               # <prefix>-access-key-id / -secret-access-key / -json
    kv_durable   = "durable-task-key-${k}"                                 # written by scripts/publish_functions.sh
    kv_fnkey     = "functions-invoke-key-${k}"
    lab_job      = "chai-q-lab-${k}"
    visqol_job   = "audio-visqol-${k}"
    hub          = "Bitrater${title(k)}"
  } }

  # Secrets each identity may read (Key Vault RBAC is granted per secret).
  secrets = { for k, s in local.enabled_stamps : k => {
    func = [local.names[k].kv_mongo, local.names[k].kv_subtitle, local.names[k].kv_gcp, "media-cdn-signing-key",
    "${local.names[k].kv_aws}-access-key-id", "${local.names[k].kv_aws}-secret-access-key"]
    dash = concat([local.names[k].kv_mongo, local.names[k].kv_subtitle, "upload-token-secret", "entra-client-secret",
      local.names[k].kv_durable, local.names[k].kv_fnkey, local.names[k].kv_gcp,
      "${local.names[k].kv_aws}-access-key-id", "${local.names[k].kv_aws}-secret-access-key"],
    s.shadow ? [] : ["vtt-worker-secret"])
    jobs  = [local.names[k].kv_mongo, "media-cdn-signing-key", local.names[k].kv_durable]
    batch = [local.names[k].kv_mongo, "${local.names[k].kv_aws}-json"]
  } }

  kv_ref = { for k, n in local.names : k => {
    for alias, secret in {
      mongo    = n.kv_mongo
      subtitle = n.kv_subtitle
      aws_id   = "${n.kv_aws}-access-key-id"
      aws_key  = "${n.kv_aws}-secret-access-key"
    } : alias => "@Microsoft.KeyVault(VaultName=${azurerm_key_vault.main.name};SecretName=${secret})"
  } }

  acr             = azurerm_container_registry.main.login_server
  batch_endpoints = { for k, account in azurerm_batch_account.main : k => "https://${account.account_endpoint}" }
}

# --- Per-stamp identities -------------------------------------------------------
resource "azurerm_user_assigned_identity" "stamp" {
  for_each            = { for pair in setproduct(keys(local.enabled_stamps), ["dash", "func", "jobs"]) : "${pair[0]}-${pair[1]}" => pair }
  name                = "id-bitrater-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  tags                = local.tags
}

resource "azurerm_role_assignment" "stamp_acr_pull" {
  for_each             = azurerm_user_assigned_identity.stamp
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = each.value.principal_id
}

# Per-secret read access, created once the stamp's secrets exist (apps=true, after A5 + publish).
locals {
  secret_grants = merge(
    merge([for k, s in local.app_stamps : merge(
      { for name in local.secrets[k].func : "${k}-func-${name}" => { principal = azurerm_user_assigned_identity.stamp["${k}-func"].principal_id, secret = name } },
      { for name in local.secrets[k].func : "${k}-funcsys-${name}" => { principal = azurerm_function_app_flex_consumption.main[k].identity[0].principal_id, secret = name } },
      { for name in local.secrets[k].dash : "${k}-dash-${name}" => { principal = azurerm_user_assigned_identity.stamp["${k}-dash"].principal_id, secret = name } },
      { for name in local.secrets[k].jobs : "${k}-jobs-${name}" => { principal = azurerm_user_assigned_identity.stamp["${k}-jobs"].principal_id, secret = name } },
    )]...),
    merge([for k, s in local.app_stamps :
      { for name in local.secrets[k].batch : "${k}-batch-${name}" => {
        principal = azurerm_user_assigned_identity.batch[k].principal_id
        secret    = name
      } }
    ]...),
  )
}

# Names only (no values enter state): lets the plan fail early, with the list of missing
# secrets, instead of the apply failing mid-way on a grant to a secret that doesn't exist.
data "azurerm_key_vault_secrets" "existing" {
  count        = length(local.app_stamps) > 0 ? 1 : 0
  key_vault_id = azurerm_key_vault.main.id
}

locals {
  missing_secrets = length(local.app_stamps) > 0 ? sort(setsubtract(
    distinct(concat([for g in values(local.secret_grants) : g.secret], ["entra-client-secret"])),
    data.azurerm_key_vault_secrets.existing[0].names,
  )) : []
}

resource "azurerm_role_assignment" "secret_read" {
  for_each             = local.secret_grants
  scope                = "${azurerm_key_vault.main.id}/secrets/${each.value.secret}"
  role_definition_name = "Key Vault Secrets User"
  principal_id         = each.value.principal

  lifecycle {
    precondition {
      condition     = length(local.missing_secrets) == 0
      error_message = "Create these Key Vault secrets before apps=true: ${join(", ", local.missing_secrets)}"
    }
  }
}

# --- Function App (Durable orchestrators + activities + /api/invoke) -----------
resource "azurerm_storage_account" "func" {
  for_each                 = local.enabled_stamps
  name                     = "bitraterfunc${each.key}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = local.tags
}

resource "azurerm_storage_container" "func_deploy" {
  for_each              = local.enabled_stamps
  name                  = "deploy"
  storage_account_id    = azurerm_storage_account.func[each.key].id
  container_access_type = "private"
}

# Durable (Azure Storage provider) needs blobs, queues and tables.
resource "azurerm_role_assignment" "func_storage" {
  for_each = { for pair in setproduct(keys(local.enabled_stamps),
  ["Storage Blob Data Owner", "Storage Queue Data Contributor", "Storage Table Data Contributor"]) : "${pair[0]}|${pair[1]}" => pair }
  scope                = azurerm_storage_account.func[each.value[0]].id
  role_definition_name = each.value[1]
  principal_id         = azurerm_user_assigned_identity.stamp["${each.value[0]}-func"].principal_id
}

resource "azurerm_service_plan" "func" {
  for_each            = local.enabled_stamps
  name                = "asp-bitrater-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  os_type             = "Linux"
  sku_name            = "FC1"
  tags                = local.tags
}

resource "azurerm_function_app_flex_consumption" "main" {
  for_each            = local.enabled_stamps
  name                = "fa-bitrater-${each.key}"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  service_plan_id     = azurerm_service_plan.func[each.key].id

  storage_container_type            = "blobContainer"
  storage_container_endpoint        = "${azurerm_storage_account.func[each.key].primary_blob_endpoint}${azurerm_storage_container.func_deploy[each.key].name}"
  storage_authentication_type       = "UserAssignedIdentity"
  storage_user_assigned_identity_id = azurerm_user_assigned_identity.stamp["${each.key}-func"].id

  runtime_name           = "python"
  runtime_version        = "3.11"
  instance_memory_in_mb  = 4096 # host.json caps activities at 3; COPY_MAX_WORKERS keeps 3 copies under this
  maximum_instance_count = 40

  # System identity resolves @Microsoft.KeyVault(...) settings (the Flex resource has no
  # keyVaultReferenceIdentity); the user identity is used by code (AZURE_CLIENT_ID).
  identity {
    type         = "SystemAssigned, UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.stamp["${each.key}-func"].id]
  }

  site_config {
    application_insights_connection_string = azurerm_application_insights.main.connection_string
  }

  depends_on = [azurerm_role_assignment.func_storage] # deployment storage + AzureWebJobsStorage use this identity

  app_settings = merge({
    # Identity-based host storage. An explicit empty AzureWebJobsStorage stops the Flex
    # resource/platform injecting a connection string with an EMPTY AccountKey, which
    # overrides the __ settings below (seen 2026-09-27: host startup 403s).
    AzureWebJobsStorage              = ""
    AzureWebJobsStorage__accountName = azurerm_storage_account.func[each.key].name
    AzureWebJobsStorage__credential  = "managedidentity"
    AzureWebJobsStorage__clientId    = azurerm_user_assigned_identity.stamp["${each.key}-func"].client_id
    AZURE_CLIENT_ID                  = azurerm_user_assigned_identity.stamp["${each.key}-func"].client_id
    DURABLE_TASK_HUB                 = local.names[each.key].hub

    # isolation + names (orchestrator/runtime_config.py)
    SHADOW_MODE           = tostring(each.value.shadow)
    CLOUD_PROVIDER        = "azure"
    DB_LAB                = local.names[each.key].db_lab
    DB_MASTER             = local.names[each.key].db_master
    CDN_BUCKET            = local.names[each.key].cdn_bucket
    GCS_INPUT_BUCKET      = local.names[each.key].gcs_input
    GCS_OUTPUT_BUCKET     = local.names[each.key].gcs_output
    AUDIO_GCS_BUCKET      = local.names[each.key].audio_bucket
    AUDIO_PUBLIC_BUCKET   = local.names[each.key].audio_public
    SKIP_CDN_INVALIDATION = each.value.shadow ? "1" : "0"
    CDN_BASE              = local.names[each.key].cdn_base

    # same values the AWS Lambdas use (aws-infra/lambda.tf, audio.tf)
    GCP_PROJECT                = var.gcp.project
    GCP_LOCATION               = var.gcp.location
    GCP_CREDENTIALS_SECRET_ARN = "kv:${local.names[each.key].kv_gcp}"
    KEY_VAULT_URL              = azurerm_key_vault.main.vault_uri
    MONGO_URI                  = local.kv_ref[each.key].mongo
    SUBTITLE_MONGO_URI         = local.kv_ref[each.key].subtitle
    AUDIO_SEGMENT_SECONDS      = "2"
    AUDIO_LADDER_KBPS          = "64"
    AUDIO_LOUDNESS_LUFS        = "-16"
    SIGNING_KEY_SECRET_ID      = "kv:media-cdn-signing-key"
    SIGNING_ENABLED            = "true"
    SIGNING_MODE               = "token"
    TOKEN_QUERY_PARAM          = "edge-cache-token"
    SIGNED_URL_TTL_SECONDS     = "36000"
    # Copy step peak ~= 2 x 64 MiB x workers (~640 MiB at 5). 3 concurrent copies on one
    # 4 GiB instance stay < 2 GiB (AWS default 16 = ~2 GiB, on its own 3008 MB Lambda).
    COPY_MAX_WORKERS   = "5"
    RESIGN_INVOKE_MODE = each.value.resign_invoke # lambda until G4 (bridge key: lambda:InvokeFunction)

    # AWS creds: S3 reads for sources still on S3 (+ resigner Lambda invoke while resign_invoke=lambda)
    AWS_ACCESS_KEY_ID     = local.kv_ref[each.key].aws_id
    AWS_SECRET_ACCESS_KEY = local.kv_ref[each.key].aws_key
    AWS_DEFAULT_REGION    = "us-east-1"

    # lab search -> Azure Batch (orchestrator/batch_jobs.py); tasks get the POOL identity's client id
    BATCH_JOB_QUEUE_ARN              = "azb-job:${local.names[each.key].lab_job}"
    BATCH_JOB_DEFINITION_ARN         = "${local.acr}/${coalesce(var.images.lab, "not-published")}"
    AZURE_BATCH_ENDPOINT             = local.batch_endpoints[each.key]
    AZURE_BATCH_TASK_ENV_PASSTHROUGH = "DB_LAB,SHADOW_MODE,KEY_VAULT_URL,MONGO_URI_KV_SECRET,AWS_S3_KEY_KV_SECRET,AZURE_CLIENT_ID_BATCH"
    AZURE_CLIENT_ID_BATCH            = azurerm_user_assigned_identity.batch[each.key].client_id
    MONGO_URI_KV_SECRET              = local.names[each.key].kv_mongo
    AWS_S3_KEY_KV_SECRET             = "${local.names[each.key].kv_aws}-json"
    }, each.value.resign_invoke == "lambda" ? {
    RESIGN_PLAYBACK_URLS_LAMBDA_ARN = var.aws_bridge["RESIGN_PLAYBACK_URLS_LAMBDA_ARN"]
  } : {})
  tags = local.tags

  lifecycle {
    # Do NOT ignore_changes on app_settings["AzureWebJobsStorage"]: when Terraform omits it,
    # the provider re-injects a connection string with an EMPTY AccountKey and the host stops
    # (verified 2026-09-27). Consequence: every plan shows `+ "AzureWebJobsStorage" = ""`
    # (the provider never reads it back). That one-line diff is expected and harmless.

    precondition {
      condition     = !each.value.apps || (var.images.lab != null && var.images.visqol != null)
      error_message = "Set immutable lab and visqol image digests before apps=true."
    }
  }
}

resource "azurerm_role_assignment" "batch_submitter" {
  for_each             = { for pair in setproduct(keys(local.enabled_stamps), ["func", "dash", "jobs"]) : "${pair[0]}-${pair[1]}" => pair }
  scope                = azurerm_batch_account.main[each.value[0]].id
  role_definition_name = "Azure Batch Job Submitter"
  principal_id         = azurerm_user_assigned_identity.stamp[each.key].principal_id
}

# --- Batch jobs (long-lived; tasks are added per lab unit) ---------------------
resource "azurerm_batch_job" "lab" {
  for_each      = local.enabled_stamps
  name          = local.names[each.key].lab_job
  batch_pool_id = azurerm_batch_pool.spot[each.key].id
  priority      = each.value.shadow ? -100 : 1000
  # Read by workers/azure_entry.py: tasks refuse to run with any other DB_LAB, so
  # isolation doesn't depend on the submitter's env passthrough.
  common_environment_properties = { STAMP_DB_LAB = local.names[each.key].db_lab }
}

resource "azurerm_batch_job" "visqol" {
  for_each      = local.enabled_stamps
  name          = local.names[each.key].visqol_job
  batch_pool_id = azurerm_batch_pool.spot[each.key].id
  priority      = each.value.shadow ? -100 : 1000
  # Read by workers/azure_entry.py: tasks refuse to run with any other DB_LAB, so
  # isolation doesn't depend on the submitter's env passthrough.
  common_environment_properties = { STAMP_DB_LAB = local.names[each.key].db_lab }
}

# --- Upload target access -------------------------------------------------------
resource "azurerm_role_assignment" "dash_upload_shadow" {
  for_each             = { for k, s in local.enabled_stamps : k => s if s.shadow }
  scope                = azurerm_storage_account.shadow_uploads.id
  role_definition_name = "Storage Blob Data Contributor" # includes generateUserDelegationKey
  principal_id         = azurerm_user_assigned_identity.stamp["${each.key}-dash"].principal_id
}

data "azurerm_storage_account" "prod_upload" {
  count               = var.prod_upload.grant_role_to_prod_dashboard ? 1 : 0
  name                = var.prod_upload.account
  resource_group_name = var.prod_upload.resource_group
}

resource "azurerm_role_assignment" "dash_upload_prod" {
  for_each             = var.prod_upload.grant_role_to_prod_dashboard ? { for k, s in local.enabled_stamps : k => s if !s.shadow } : {}
  scope                = data.azurerm_storage_account.prod_upload[0].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.stamp["${each.key}-dash"].principal_id
}

# --- Dashboard (0 or 1 replica: in-process orchestrator) -----------------------
locals {
  dash_env = { for k, s in local.app_stamps : k => merge({
    APP_BASE_URL             = "http://localhost:3000" # self-calls bypass the login
    EASY_AUTH_ENABLED        = "true"                  # /api/health?deep=1 needs a signed-in user
    AZURE_CLIENT_ID          = azurerm_user_assigned_identity.stamp["${k}-dash"].client_id
    SHADOW_MODE              = tostring(s.shadow)
    CLOUD_PROVIDER           = s.cloud_provider
    UPLOAD_PROVIDER          = s.upload_provider
    UPLOAD_AZURE_ACCOUNT     = local.names[k].upload_acct
    UPLOAD_AZURE_CONTAINER   = local.names[k].upload_cont
    DB_LAB                   = local.names[k].db_lab
    DB_MASTER                = local.names[k].db_master
    MONGO_DATABASE           = local.names[k].db_master
    STARTUP_RECOVERY_ENABLED = "true" # re-adopt RUNNING pipelines after any replica restart
    # Off on both: AWS prod never ran it (its instrumentation hook was off), so turning it
    # on is a separate owner decision, not part of the migration.
    TRAILER_SCANNER_ENABLED              = "false"
    VTT_ENABLED                          = s.shadow ? "false" : "true"
    UPLOAD_DEV_SYNC_ENABLED              = s.shadow ? "false" : "true"
    DURABLE_BASE_URL                     = "https://${azurerm_function_app_flex_consumption.main[k].default_hostname}"
    FUNCTIONS_BASE_URL                   = "https://${azurerm_function_app_flex_consumption.main[k].default_hostname}"
    INVOKE_PROVIDER_RESIGN_PLAYBACK_URLS = s.resign_invoke == "lambda" ? "aws" : "azure"
    AZURE_BATCH_ENDPOINT                 = local.batch_endpoints[k]
    AZURE_BATCH_LAB_JOB                  = local.names[k].lab_job
    AZURE_BATCH_LAB_IMAGE                = "${local.acr}/${coalesce(var.images.lab, "not-published")}"
    AZURE_BATCH_VISQOL_JOB               = local.names[k].visqol_job
    AZURE_BATCH_VISQOL_IMAGE             = "${local.acr}/${coalesce(var.images.visqol, "not-published")}"
    AZURE_CLIENT_ID_BATCH                = azurerm_user_assigned_identity.batch[k].client_id
    LAB_COMPUTE_PROVIDER                 = s.cloud_provider
    LAB_WORKER_CAPACITY                  = tostring(s.cloud_provider == "azure" ? local.batch_pool[k].max_nodes : 128)
    KEY_VAULT_URL                        = azurerm_key_vault.main.vault_uri
    MONGO_URI_KV_SECRET                  = local.names[k].kv_mongo
    AWS_S3_KEY_KV_SECRET                 = "${local.names[k].kv_aws}-json"
    AWS_REGION                           = "us-east-1"
    SIGNED_URL_TTL_SECONDS               = "36000"
    RESIGN_SCHEDULE_EXPRESSION           = "rate(2 hours)" # display only; parsed by signing/config + alerts
    GCP_CREDENTIALS_SECRET_ARN           = "kv:${local.names[k].kv_gcp}"
    TEST_JAS_H264_ENABLED                = tostring(!s.shadow)
    },
    # G2 bridge: the dashboard starts AWS workflows/jobs/Lambdas exactly as App Runner did.
    s.cloud_provider == "aws" ? var.aws_bridge : {},
    s.resign_invoke == "lambda" ? { RESIGN_PLAYBACK_URLS_LAMBDA_ARN = var.aws_bridge["RESIGN_PLAYBACK_URLS_LAMBDA_ARN"] } : {},
    s.shadow ? {} : { VTT_WORKER_URL = var.vtt_worker_url },
  ) }

  dash_secret_env = { for k, s in local.app_stamps : k => merge({
    MONGO_URI             = local.names[k].kv_mongo
    SUBTITLE_MONGO_URI    = local.names[k].kv_subtitle
    AWS_ACCESS_KEY_ID     = "${local.names[k].kv_aws}-access-key-id"
    AWS_SECRET_ACCESS_KEY = "${local.names[k].kv_aws}-secret-access-key"
    UPLOAD_TOKEN_SECRET   = "upload-token-secret"
    DURABLE_TASK_KEY      = local.names[k].kv_durable
    FUNCTIONS_INVOKE_KEY  = local.names[k].kv_fnkey
  }, s.shadow ? {} : { VTT_WORKER_SECRET = "vtt-worker-secret" }) }
}

resource "azurerm_container_app" "dashboard" {
  for_each                     = local.dash_stamps
  name                         = "ca-bitrater-dash-${each.key}"
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption" # matches the env profile (foundation.tf); unset drifts every plan
  # Single mode still overlaps old/new revision briefly on deploy; the Mongo
  # locked_by/pr_lock/scanner locks cover it, but only deploy outside runs (P6).
  revision_mode = "Single"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.stamp["${each.key}-dash"].id]
  }
  registry {
    server   = local.acr
    identity = azurerm_user_assigned_identity.stamp["${each.key}-dash"].id
  }

  # Easy Auth reads the Entra client secret from this Container App secret
  # (authConfigs clientSecretSettingName); it is not exposed to the app as an env var.
  secret {
    name                = "entra-client-secret"
    key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/entra-client-secret"
    identity            = azurerm_user_assigned_identity.stamp["${each.key}-dash"].id
  }

  dynamic "secret" {
    for_each = setsubtract(toset(values(local.dash_secret_env[each.key])), ["entra-client-secret"])
    content {
      name                = secret.value
      key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${secret.value}"
      identity            = azurerm_user_assigned_identity.stamp["${each.key}-dash"].id
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = each.value.dashboard_replicas # never scale on load
    max_replicas = each.value.dashboard_replicas # never two
    container {
      name   = "dashboard"
      image  = "${local.acr}/${coalesce(var.images.dashboard, "not-published")}"
      cpu    = 1
      memory = "2Gi"

      dynamic "env" {
        for_each = local.dash_env[each.key]
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.dash_secret_env[each.key]
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      liveness_probe {
        transport = "HTTP"
        port      = 3000
        path      = "/api/health"
      }
    }
  }
  tags = local.tags

  depends_on = [azurerm_role_assignment.secret_read, azurerm_role_assignment.stamp_acr_pull]

  lifecycle {
    precondition {
      condition     = var.entra_client_id != ""
      error_message = "A dashboard cannot be exposed until entra_client_id is configured."
    }
    precondition {
      condition     = length(var.dashboard_allowed_principals.groups) + length(var.dashboard_allowed_principals.identities) > 0
      error_message = "Set dashboard_allowed_principals (operator group or user object ids); otherwise every tenant user and guest could use the dashboard."
    }
    precondition {
      condition     = var.images.dashboard != null
      error_message = "Set an immutable dashboard image digest before creating the dashboard."
    }
  }
}

# Entra ID login for the dashboard (it has none today).
resource "azapi_resource" "dashboard_auth" {
  for_each  = local.dash_stamps
  type      = "Microsoft.App/containerApps/authConfigs@2024-03-01"
  name      = "current"
  parent_id = azurerm_container_app.dashboard[each.key].id
  body = {
    properties = {
      platform = { enabled = true }
      globalValidation = {
        unauthenticatedClientAction = "RedirectToLoginPage"
        redirectToProvider          = "azureactivedirectory"
        # Only the shallow liveness check is public (availability test, monitoring.tf);
        # the route itself refuses ?deep=1 without a signed-in principal.
        excludedPaths = ["/api/health"]
      }
      identityProviders = {
        azureActiveDirectory = {
          registration = {
            clientId                = var.entra_client_id
            clientSecretSettingName = "entra-client-secret" # Container App secret name (verify on first deploy)
            openIdIssuer            = "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/v2.0"
          }
          # Only these operators/groups may use the dashboard; any other tenant user or
          # guest who signs in gets 403 (the dashboard can resign, upload and cancel prod work).
          validation = {
            defaultAuthorizationPolicy = {
              allowedPrincipals = {
                groups     = var.dashboard_allowed_principals.groups
                identities = var.dashboard_allowed_principals.identities
              }
            }
          }
        }
      }
    }
  }
}

# --- Scheduled jobs: resigner (every 2 h) and url-health (hourly) --------------
resource "azurerm_container_app_job" "scheduled" {
  for_each = merge(
    { for k, s in local.app_stamps : "${k}-resigner" => {
    stamp = k, job = "resigner", cron = "0 */2 * * *", on = s.resigner.enabled, db_master = s.resigner.db_master } },
    { for k, s in local.app_stamps : "${k}-urlhealth" => {
    stamp = k, job = "url_health", cron = "0 * * * *", on = s.url_health.enabled, db_master = s.url_health.db_master } },
    { for k, s in local.app_stamps : "${k}-bcleanup" => {
    stamp = k, job = "batch_cleanup", cron = "30 2 * * *", on = true, db_master = local.names[k].db_master } },
    { for k, s in local.app_stamps : "${k}-watchdog" => {
    stamp = k, job = "workflow_watchdog", cron = "*/15 * * * *", on = true, db_master = local.names[k].db_master } },
  )
  name                         = "acaj-bitrater-${each.key}"
  resource_group_name          = azurerm_resource_group.main.name
  location                     = var.location
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = 3600 # the Lambda's 900 s ceiling was already hit by the full sweep
  replica_retry_limit          = 0

  # Off = manual trigger only (never fires on its own).
  dynamic "schedule_trigger_config" {
    for_each = each.value.on ? [1] : []
    content {
      cron_expression          = each.value.cron
      parallelism              = 1
      replica_completion_count = 1
    }
  }
  dynamic "manual_trigger_config" {
    for_each = each.value.on ? [] : [1]
    content {
      parallelism              = 1
      replica_completion_count = 1
    }
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.stamp["${each.value.stamp}-jobs"].id]
  }
  registry {
    server   = local.acr
    identity = azurerm_user_assigned_identity.stamp["${each.value.stamp}-jobs"].id
  }
  secret {
    name                = "mongo-uri"
    key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${local.names[each.value.stamp].kv_mongo}"
    identity            = azurerm_user_assigned_identity.stamp["${each.value.stamp}-jobs"].id
  }
  secret {
    name                = "durable-task-key"
    key_vault_secret_id = "${azurerm_key_vault.main.vault_uri}secrets/${local.names[each.value.stamp].kv_durable}"
    identity            = azurerm_user_assigned_identity.stamp["${each.value.stamp}-jobs"].id
  }

  template {
    container {
      name   = "job"
      image  = "${local.acr}/${coalesce(var.images.jobs, "not-published")}"
      args   = [each.value.job]
      cpu    = 2
      memory = "4Gi"
      env {
        name        = "MONGO_URI"
        secret_name = "mongo-uri"
      }
      env {
        name        = "DURABLE_TASK_KEY"
        secret_name = "durable-task-key"
      }
      dynamic "env" {
        for_each = {
          AZURE_CLIENT_ID        = azurerm_user_assigned_identity.stamp["${each.value.stamp}-jobs"].client_id
          KEY_VAULT_URL          = azurerm_key_vault.main.vault_uri
          SIGNING_KEY_SECRET_ID  = "kv:media-cdn-signing-key"
          SIGNING_ENABLED        = "true"
          SIGNING_MODE           = "token"
          TOKEN_QUERY_PARAM      = "edge-cache-token"
          SIGNED_URL_TTL_SECONDS = "36000"
          # Reads DB_MASTER (per job/phase); writes run logs to the stamp's lab DB, so a
          # shadow stamp's dry run / compare never writes prod collections.
          DB_MASTER                       = each.value.db_master
          DB_LAB                          = local.names[each.value.stamp].db_lab
          SHADOW_MODE                     = tostring(var.stamps[each.value.stamp].shadow)
          CDN_BUCKET                      = local.names[each.value.stamp].cdn_bucket
          GCS_INPUT_BUCKET                = local.names[each.value.stamp].gcs_input
          GCS_OUTPUT_BUCKET               = local.names[each.value.stamp].gcs_output
          AUDIO_GCS_BUCKET                = local.names[each.value.stamp].audio_bucket
          AUDIO_PUBLIC_BUCKET             = local.names[each.value.stamp].audio_public
          SKIP_CDN_INVALIDATION           = var.stamps[each.value.stamp].shadow ? "1" : "0"
          RESIGN_INVOKE_MODE              = "inprocess"
          DRY_RUN                         = tostring(var.stamps[each.value.stamp].resigner.dry_run)
          CDN_BASE                        = var.cdn_base
          URL_HEALTH_WORKERS              = "50"
          AZURE_BATCH_ENDPOINT            = local.batch_endpoints[each.value.stamp]
          AZURE_BATCH_JOBS                = "${local.names[each.value.stamp].lab_job},${local.names[each.value.stamp].visqol_job}"
          AZURE_BATCH_RETENTION_DAYS      = "7"
          DURABLE_BASE_URL                = "https://${azurerm_function_app_flex_consumption.main[each.value.stamp].default_hostname}"
          AZURE_DURABLE_MAX_RUNNING_HOURS = "24"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
  tags = local.tags

  depends_on = [azurerm_role_assignment.secret_read, azurerm_role_assignment.stamp_acr_pull]

  lifecycle {
    precondition {
      condition     = var.alert_email != ""
      error_message = "Set alert_email before apps=true so pipeline, Batch, dashboard and scheduled-job alerts are active."
    }
    precondition {
      condition     = var.images.jobs != null
      error_message = "Set an immutable jobs image digest before apps=true."
    }
  }
}
