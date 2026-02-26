output "batch_job_queue_arn" {
  value = aws_batch_job_queue.chai_q_queue.arn
}

output "step_function_arn" {
  value = aws_sfn_state_machine.research_orchestrator.arn
}