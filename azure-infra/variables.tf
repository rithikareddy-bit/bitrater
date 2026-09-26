variable "subscription_id" {
  type    = string
  default = "ff1dad43-0464-4958-8179-94669f96c927"
}

variable "location" {
  type    = string
  default = "centralindia"
}

variable "stamps" {
  description = <<-EOT
    Deployments of the same code. shadow: isolated test copy (shadow DBs/buckets,
    SHADOW_MODE=true). prod: real names. Every phase switch is a field here, so each
    step and each rollback is a one-line change + apply (+ scripts/publish_functions.sh
    <stamp> --keys-only afterwards, which restarts the Function App so new Key Vault
    access takes effect).

    Staging per stamp: enabled=true (foundation for the stamp: identities, Function App
    without code, Batch jobs) -> secrets copied + publish_functions.sh <stamp> ->
    apps=true (Key Vault grants, dashboard, scheduled jobs).
  EOT
  type = map(object({
    enabled            = bool
    apps               = bool # grants + dashboard + jobs (needs secrets + published function code)
    shadow             = bool
    dashboard_replicas = number # 1 = dashboard exists (one replica, never two); 0 = no dashboard
    cloud_provider     = string # dashboard: where NEW workflows/jobs start. aws = bridge (G2), azure (G3+)
    upload_provider    = string # s3 | azure
    resign_invoke      = string # lambda (AWS resigner Lambda, until G4) | inprocess (Azure)
    aws_key            = string # KV prefix for AWS creds: aws-bridge (SFN/Batch/Lambda/S3, G2..G4) | aws-s3-readonly
    resigner = object({
      enabled   = bool   # cron on/off (off = manual trigger only)
      dry_run   = bool   # true until G4 (always true on a shadow stamp)
      db_master = string # showcache it signs: F reads prod "master" in dry run
    })
    url_health = object({
      enabled   = bool
      db_master = string # G1 compare: read prod "master" while writing the stamp's lab DB
    })
  }))
  default = {
    shadow = {
      enabled            = true
      apps               = false
      shadow             = true
      dashboard_replicas = 1
      cloud_provider     = "azure"
      upload_provider    = "azure"
      resign_invoke      = "inprocess"
      aws_key            = "aws-s3-readonly"
      resigner           = { enabled = false, dry_run = true, db_master = "master" }
      url_health         = { enabled = false, db_master = "master_shadow" }
    }
    prod = {
      enabled            = false
      apps               = false
      shadow             = false
      dashboard_replicas = 0
      cloud_provider     = "aws"
      upload_provider    = "s3"
      resign_invoke      = "lambda"
      aws_key            = "aws-s3-readonly" # switch to aws-bridge at G2 (bridge key created then)
      resigner           = { enabled = false, dry_run = true, db_master = "master" }
      url_health         = { enabled = false, db_master = "master" }
    }
  }

  validation {
    condition     = alltrue([for s in values(var.stamps) : contains([0, 1], s.dashboard_replicas)])
    error_message = "dashboard_replicas must be 0 or 1 (two replicas would double-drive pipelines)."
  }
  validation {
    condition = alltrue([for s in values(var.stamps) :
      contains(["aws", "azure"], s.cloud_provider) && contains(["s3", "azure"], s.upload_provider) &&
      contains(["lambda", "inprocess"], s.resign_invoke) && contains(["aws-bridge", "aws-s3-readonly"], s.aws_key)
    ])
    error_message = "cloud_provider: aws|azure; upload_provider: s3|azure; resign_invoke: lambda|inprocess; aws_key: aws-bridge|aws-s3-readonly."
  }
  validation {
    condition     = alltrue([for s in values(var.stamps) : !s.shadow || (s.cloud_provider == "azure" && s.resign_invoke == "inprocess" && s.aws_key == "aws-s3-readonly")])
    error_message = "A shadow stamp must use azure / inprocess / aws-s3-readonly (never AWS prod resources)."
  }
  validation {
    condition     = alltrue([for s in values(var.stamps) : !s.shadow || s.resigner.dry_run || endswith(s.resigner.db_master, "_shadow")])
    error_message = "A shadow stamp's resigner may only write shadow data: keep dry_run=true while it reads prod master."
  }
  validation {
    # AWS is actually called when: a bridge dashboard exists (cloud_provider=aws), or the
    # Azure backends call the AWS resigner Lambda (cloud_provider=azure + resign_invoke=lambda).
    condition = alltrue([for s in values(var.stamps) :
      !s.apps || s.shadow || s.aws_key == "aws-bridge" ||
    !((s.dashboard_replicas == 1 && s.cloud_provider == "aws") || (s.cloud_provider == "azure" && s.resign_invoke == "lambda"))])
    error_message = "The prod bridge dashboard (cloud_provider=aws) or Azure backends using the AWS resigner Lambda need aws_key=aws-bridge."
  }
}

variable "aws_bridge" {
  description = <<-EOT
    AWS resource ids the prod dashboard/functions still call while CLOUD_PROVIDER=aws
    (G2) or the resigner stays on AWS (until G4). Same values as aws-infra/apprunner.tf.
  EOT
  type        = map(string)
  default = {
    SFN_ARN_H264                      = "arn:aws:states:us-east-1:107647021172:stateMachine:Chai-Q-Orchestrator-H264"
    SFN_ARN_H265                      = "arn:aws:states:us-east-1:107647021172:stateMachine:Chai-Q-Orchestrator-H265"
    GCP_SFN_ARN                       = "arn:aws:states:us-east-1:107647021172:stateMachine:GCP-Orchestrator"
    AUDIO_SFN_ARN                     = "arn:aws:states:us-east-1:107647021172:stateMachine:Audio-Orchestrator"
    AUDIO_SHOW_BATCH_SFN_ARN          = "arn:aws:states:us-east-1:107647021172:stateMachine:Audio-Show-Batch"
    BATCH_JOB_QUEUE                   = "chai-q-queue"
    BATCH_JOB_DEFINITION              = "chai-q-worker"
    AUDIO_VISQOL_JOB_DEFINITION       = "audio-visqol"
    CREATE_COMBINED_MASTER_LAMBDA_ARN = "arn:aws:lambda:us-east-1:107647021172:function:chai-q-gcp-create-combined-master"
    QUALITY_CHECK_LAMBDA_ARN          = "arn:aws:lambda:us-east-1:107647021172:function:chai-q-quality-checker"
    RESYNC_SUBTITLES_LAMBDA_ARN       = "arn:aws:lambda:us-east-1:107647021172:function:chai-q-resync-subtitles"
    RESIGN_PLAYBACK_URLS_LAMBDA_ARN   = "arn:aws:lambda:us-east-1:107647021172:function:chai-q-resign-playback-urls"
  }
}

variable "vtt_worker_url" {
  description = "Cloud Run vtt-worker (stays on GCP). Secret is KV `vtt-worker-secret`."
  type        = string
  default     = "https://vtt-worker-7siifnon7a-el.a.run.app"
}

variable "prod_upload" {
  description = <<-EOT
    Prod upload target (UPLOAD_PROVIDER=azure). The account belongs to another team
    (rg-scrolls-dev): granting the prod dashboard identity Storage Blob Data
    Contributor there needs their approval, so it is opt-in.
  EOT
  type = object({
    account                      = string
    resource_group               = string
    container                    = string
    grant_role_to_prod_dashboard = bool
  })
  default = {
    account                      = "chaishotsblobstoredev"
    resource_group               = "rg-scrolls-dev"
    container                    = "sanity-dev-store"
    grant_role_to_prod_dashboard = false
  }
}

variable "images" {
  description = "Immutable ACR image references (repository@sha256:digest), populated after each image is pushed."
  type = object({
    dashboard = optional(string)
    jobs      = optional(string)
    lab       = optional(string)
    visqol    = optional(string)
  })
  default = {}

  validation {
    condition = alltrue([
      for image in [var.images.dashboard, var.images.jobs, var.images.lab, var.images.visqol] :
      image == null || can(regex("^[^:@]+@sha256:[0-9a-f]{64}$", image))
    ])
    error_message = "Every configured image must be immutable: repository@sha256:<64 lowercase hex characters>."
  }
}

variable "batch_image" {
  description = "Container-capable Batch VM image; confirm with `az batch pool supported-images list` (Phase A)."
  type = object({
    publisher         = string
    offer             = string
    sku               = string
    node_agent_sku_id = string
  })
  default = {
    publisher         = "microsoft-dsvm"
    offer             = "ubuntu-hpc"
    sku               = "2204"
    node_agent_sku_id = "batch.node.ubuntu 22.04"
  }
}

variable "batch_vm_size" {
  description = <<-EOT
    4 vCPU / 16 GiB (fits chai-q-worker 4/7 GB and ViSQOL 4/8 GB) WITH a local temp disk:
    workers write 11 GB+ sources + encodes to the Batch task dir (/mnt/batch, temp disk).
    BatchService mode: VMs come from Batch's own capacity, so what matters is
    `az batch location list-skus --location centralindia` (2026-09-26: D4a_v4, D4ds_v4,
    D4ads_v5, D4ds_v5 listed, low-priority capable). Several of these are
    NotAvailableForSubscription for *this* subscription, so a UserSubscription-mode
    fallback would need a different size.
  EOT
  type        = string
  default     = "Standard_D4a_v4"
}

variable "batch_image_version" {
  description = "Exact supported Azure Batch node image version. Resolve during A3; mutable `latest` is refused."
  type        = string

  validation {
    condition     = trimspace(var.batch_image_version) != "" && lower(var.batch_image_version) != "latest"
    error_message = "batch_image_version must be an exact supported version, never `latest`."
  }
}

variable "batch_max_spot_nodes" {
  description = "Autoscale ceiling (4 vCPU each). 128 = AWS max_vcpus 512; bounded by the Batch account low-priority core quota."
  type        = number
  default     = 16
}

variable "entra_client_id" {
  description = <<-EOT
    Entra app registration (client id) for dashboard login; created separately with
    approval. It needs ID-token issuance, a client secret stored as the Key Vault
    secret `entra-client-secret`, and redirect URI
    https://<dashboard fqdn>/.auth/login/aad/callback. A dashboard cannot be created
    while this is empty.
  EOT
  type        = string
  default     = ""
}

variable "alert_email" {
  description = "Required once a stamp's resigner writes (dry_run=false): playback depends on it."
  type        = string
  default     = ""
}

variable "cdn_base" {
  type    = string
  default = "https://cdn.chaishots.in"
}

variable "gcp" {
  type    = object({ project = string, location = string })
  default = { project = "media-cdn-poc-466009", location = "asia-south1" }
}
