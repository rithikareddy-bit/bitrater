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
  description = "ARN of the AWS Secrets Manager secret containing the GCP service account JSON key"
  type        = string
  sensitive   = true
}

variable "alert_email" {
  description = "Email address to receive CloudWatch alarm notifications (optional)"
  type        = string
  default     = ""
}

variable "vmaf_threshold_1080p" {
  description = "Minimum acceptable VMAF score for 1080p (default 88)"
  type        = number
  default     = 88
}

variable "vmaf_threshold_720p" {
  description = "Minimum acceptable VMAF score for 720p (default 75)"
  type        = number
  default     = 75
}

variable "vmaf_threshold_480p" {
  description = "Minimum acceptable VMAF score for 480p (default 48)"
  type        = number
  default     = 48
}
