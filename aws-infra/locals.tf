locals {
  _gcp_secret_input = trimspace(var.gcp_credentials_secret_arn)
  # IAM requires a single ARN string. Common mistake: pasting full
  # `aws secretsmanager describe-secret --output json` into tfvars.
  gcp_credentials_secret_arn_effective = coalesce(
    try(jsondecode(local._gcp_secret_input).ARN, null),
    try(regex("arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[^\"\\s,}]+", local._gcp_secret_input), null),
    length(local._gcp_secret_input) > 0 ? local._gcp_secret_input : null,
  )
}
