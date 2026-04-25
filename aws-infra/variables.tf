variable "mongo_uri" {
  description = "MongoDB Atlas connection string for the chai_q_lab database"
  type        = string
  sensitive   = true
}

variable "gcp_project" {
  description = "GCP project ID for the Transcoder API"
  type        = string
}

variable "gcp_location" {
  description = "GCP region for the Transcoder API"
  type        = string
  default     = "us-central1"
}

variable "gcs_input_bucket" {
  description = "GCS bucket for Transcoder input (source videos copied from S3)"
  type        = string
}

variable "gcs_output_bucket" {
  description = "GCS bucket for Transcoder output (HLS playlists and segments)"
  type        = string
}

variable "gcp_credentials_secret_arn" {
  description = "Secrets Manager secret ARN (plain string). If you paste full describe-secret JSON by mistake, Terraform will extract .ARN."
  type        = string
  sensitive   = true
}

variable "subtitle_mongo_uri" {
  description = "MongoDB URI for subtitle VTT lookup (gld2sqs database)"
  type        = string
  sensitive   = true
}

variable "cdn_base" {
  description = "CDN base URL for GCS manifests — no trailing slash (e.g. https://cdn.chaishots.in). Must exactly match the prefix written into h264/h265_master_m3u8_url in MongoDB."
  type        = string
}

variable "vtt_worker_url" {
  description = "Base URL of the VTT worker Cloud Run service (no trailing slash)"
  type        = string
  default     = ""
}

variable "vtt_worker_secret" {
  description = "Shared secret for VTT worker authentication (X-VTT-Worker-Secret header)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "media_cdn_signing_key_secret_id" {
  description = "Secrets Manager secret name (or ARN) holding the Ed25519 private key for Media CDN URL signing. JSON body: {\"key_name\":\"...\",\"private_key_b64url\":\"...\"}."
  type        = string
  default     = "chai-q/media-cdn-signing-key"
}

variable "signed_url_ttl_seconds" {
  description = "TTL for generated signed URLs in seconds. Production: 36000 (10 h) — gives 8 h guaranteed mid-playback margin against the 2 h rotation."
  type        = number
  default     = 36000
}

variable "resign_schedule_expression" {
  description = "EventBridge schedule for the full-sweep resigner. Production: rate(2 hours) — paired with 10 h TTL for 8 h mid-playback safety."
  type        = string
  default     = "rate(2 hours)"
}

variable "resign_schedule_enabled" {
  description = "Whether the resigner EventBridge rule is enabled. Default true (production state). Set false only for emergency disable."
  type        = bool
  default     = true
}

variable "signing_enabled" {
  description = "Master kill switch for the resigner Lambda. When false, sync-route invocations write canonical URLs as-is (no signing, no GCS rewrite) and clear any stale signed_playback_expires_at. Default true (production state). Set false only for emergency disable."
  type        = bool
  default     = true
}
