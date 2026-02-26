output "batch_job_queue_arn" {
  value = aws_batch_job_queue.chai_q_queue.arn
}

output "step_function_arn" {
  value = aws_sfn_state_machine.research_orchestrator.arn
}

output "amplify_app_id" {
  value = aws_amplify_app.dashboard.id
}

output "amplify_app_url" {
  value       = "https://main.${aws_amplify_app.dashboard.default_domain}"
  description = "Dashboard URL after first successful deploy"
}