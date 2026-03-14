# ============================================================
# CloudWatch Alarms + SNS Notifications
# ============================================================

resource "aws_sns_topic" "alerts" {
  name = "chai-q-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---- Lambda error alarms ----

locals {
  lambda_functions = {
    aggregator       = aws_lambda_function.aggregator.function_name
    mark_lab_failed  = aws_lambda_function.mark_lab_failed.function_name
    gcp_copy         = aws_lambda_function.gcp_copy.function_name
    gcp_transcoder   = aws_lambda_function.gcp_transcoder.function_name
    gcp_check_status = aws_lambda_function.gcp_check_status.function_name
    gcp_finalize     = aws_lambda_function.gcp_finalize.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.lambda_functions

  alarm_name          = "chai-q-lambda-errors-${each.key}"
  alarm_description   = "Lambda ${each.value} has errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ---- Step Function execution failure alarms ----

resource "aws_cloudwatch_metric_alarm" "lab_sfn_failures" {
  alarm_name          = "chai-q-lab-sfn-failures"
  alarm_description   = "Chai-Q-Orchestrator (lab) Step Function executions are failing"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.research_orchestrator.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "gcp_sfn_failures" {
  alarm_name          = "chai-q-gcp-sfn-failures"
  alarm_description   = "GCP-Orchestrator Step Function executions are failing"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.gcp_orchestrator.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ---- AWS Batch job failure alarm via EventBridge ----

resource "aws_cloudwatch_event_rule" "batch_job_failed" {
  name        = "chai-q-batch-job-failed"
  description = "Capture AWS Batch FAILED job state changes in chai-q-queue"
  event_pattern = jsonencode({
    source      = ["aws.batch"]
    detail-type = ["Batch Job State Change"]
    detail = {
      status    = ["FAILED"]
      jobQueue  = [aws_batch_job_queue.chai_q_queue.arn]
    }
  })
}

resource "aws_cloudwatch_event_target" "batch_failed_to_sns" {
  rule      = aws_cloudwatch_event_rule.batch_job_failed.name
  target_id = "SendToSNS"
  arn       = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_policy" "allow_eventbridge" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowEventBridgePublish"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "SNS:Publish"
      Resource  = aws_sns_topic.alerts.arn
    }]
  })
}
