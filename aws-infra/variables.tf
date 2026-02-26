variable "mongo_uri" {
  description = "MongoDB Atlas connection string for the chai_q_lab database"
  type        = string
  sensitive   = true
}

variable "github_repository" {
  description = "Full GitHub repository URL (e.g. https://github.com/org/video-q-lab)"
  type        = string
}

variable "github_token" {
  description = "GitHub OAuth token or fine-grained PAT with repo + webhooks scope"
  type        = string
  sensitive   = true
}
