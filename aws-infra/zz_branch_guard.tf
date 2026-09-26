# Blocks `terraform plan/apply` of AWS prod from an azure-migration* branch.
# AWS prod stays on the pre-migration code as the revert path; branch Lambda
# zips would ship without the new modules. See scripts/guard_no_aws_deploy.sh.
# An output precondition adds no AWS resources.

locals {
  git_head = try(file("${path.module}/../.git/HEAD"), "")
}

output "azure_migration_branch_guard" {
  value = "ok"

  precondition {
    condition     = !can(regex("refs/heads/azure-migration", local.git_head))
    error_message = "Refusing to plan/apply AWS prod from an azure-migration branch. Deploy AWS changes from sync-bitrater-to-org."
  }
}
