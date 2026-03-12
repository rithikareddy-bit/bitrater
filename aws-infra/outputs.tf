output "batch_job_queue_arn" {
  value = aws_batch_job_queue.chai_q_queue.arn
}

output "step_function_arn" {
  value = aws_sfn_state_machine.research_orchestrator.arn
}

output "dashboard_ecr_url" {
  value = aws_ecr_repository.dashboard.repository_url
}

output "dashboard_url" {
  value       = "https://${aws_apprunner_service.dashboard.service_url}"
  description = "Live dashboard URL"
}

output "gcp_step_function_arn" {
  value = aws_sfn_state_machine.gcp_orchestrator.arn
}