variable "mongo_uri" {
  description = "MongoDB Atlas connection string for the chai_q_lab database"
  type        = string
  sensitive   = true
}
