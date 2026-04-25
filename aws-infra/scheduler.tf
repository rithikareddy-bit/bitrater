# EventBridge rule that invokes the resigner Lambda on a schedule.
# The rule ships disabled (resign_schedule_enabled = false); Phase 1 flips it on.

resource "aws_cloudwatch_event_rule" "resign_playback_urls" {
  name                = "chai-q-resign-playback-urls"
  description         = "Re-sign every Media CDN combined-master URL in master.showcache."
  schedule_expression = var.resign_schedule_expression
  state               = var.resign_schedule_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "resign_playback_urls" {
  rule      = aws_cloudwatch_event_rule.resign_playback_urls.name
  target_id = "invoke-resign-playback-urls"
  arn       = aws_lambda_function.resign_playback_urls.arn
  input     = "{}"
}

resource "aws_lambda_permission" "eventbridge_invoke_resign_playback_urls" {
  statement_id  = "AllowEventBridgeInvokeResignPlaybackUrls"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.resign_playback_urls.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.resign_playback_urls.arn
}
