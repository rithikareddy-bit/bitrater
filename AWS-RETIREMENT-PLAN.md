# AWS retirement plan (only after Azure production is proven)

This is deliberately separate from the Azure migration. Deploying, testing, or cutting over Azure does **not** authorize deletion in AWS.

## Preconditions

All conditions must be recorded before any destructive action:

1. Azure has served production cleanly for at least 30 days.
2. Both AWS revert drills completed successfully after the Azure backend cutover.
3. The owner explicitly approves the exact resources in the retirement change.
4. AWS Terraform state, configuration, Lambda packages, container-image digests, and relevant logs are backed up outside the workstation.
5. App Runner is paused, EventBridge rules are disabled, Batch has no jobs, every Step Function has zero running executions, and `scripts/cutover/audit_legacy_s3_trigger.sh` passes for the agreed observation window.
6. Azure alerts, on-call routing, quota, backups, and operational access have been exercised in production.

## Retirement order

Retire small, reversible groups in separate changes; never use one unreviewed account-wide destroy:

1. Temporary AWS bridge access key and migration-only IAM user permissions.
2. App Runner and its dashboard ECR repository, after exporting the final image digest.
3. EventBridge targets/rules, then the corresponding scheduled Lambdas.
4. Step Functions and their Lambdas/layers, after confirming no stored AWS execution IDs remain active.
5. AWS Batch queues, job definitions, compute environment, worker ECR repositories, and Batch IAM/network resources.
6. Remaining compute-only IAM roles and log groups after retention/export checks.

For every group: create and save a Terraform plan, verify the resource addresses manually, obtain approval, apply only that reviewed group, and run Azure smoke tests before continuing.

## S3 is a separate migration

Do not delete S3 buckets, S3 IAM access, or close the AWS account with the compute retirement. The application still has Mongo records whose `s3_url` points to AWS.

Storage retirement requires its own project:

1. Inventory every S3 URL and bucket/region.
2. Copy every object to Azure Blob with size/checksum verification and an exception report.
3. Update Mongo URLs in a reversible, audited batch.
4. Run playback, ffprobe, lab, transcode, upload, and rollback tests against Blob URLs.
5. Observe zero S3 reads for the agreed period.
6. Back up/export the buckets, then request separate approval for bucket and IAM deletion.

Until those steps pass, AWS S3 is a live production dependency even when all AWS compute is dormant.
