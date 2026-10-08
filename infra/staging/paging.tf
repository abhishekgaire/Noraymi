# Paging (M8-17; spec 13 · Watching production, On call). Vendor-neutral: CloudWatch alarms and RDS
# failover events go to one SNS topic, which posts them to the API's alarm hook
# (POST /v1/hooks/alarms). The API opens the page, sends it to the first responder on the rota and,
# if nobody acknowledges it in the Console within 10 minutes, to the second (apps/api/src/ops).
# The money checks (payments, captures, dead letters, webhook lag, payouts, readers) run in the
# worker's alert sweep from the database, so they need nothing here.
#
# Every alarm's description names its rule and runbook ("rule:<id> runbook:docs/runbooks/<id>.md");
# a unit test checks each runbook exists. Not applied: `terraform plan` then `apply` from a laptop.

locals {
  # The availability target: 99.9% a month for ordering, payments and printing (spec 01 · Targets).
  paged_parts  = ["ordering", "payments", "printing"]
  error_budget = 0.001
  # The multi-window burn-rate alerts that page (packages/shared/src/telemetry/targets.ts · BURN_ALERTS):
  # both the long and the short window must burn faster than the rate.
  burn_windows = {
    fast = { long = 3600, short = 300, rate = 14.4 }
    slow = { long = 21600, short = 1800, rate = 6 }
  }
  burn_alarms = {
    for pair in setproduct(local.paged_parts, keys(local.burn_windows)) :
    "${pair[0]}-${pair[1]}" => { part = pair[0], window = local.burn_windows[pair[1]] }
  }
  burn_children = merge([
    for k, v in local.burn_alarms : {
      "${k}-long"  = { part = v.part, period = v.window.long, rate = v.window.rate }
      "${k}-short" = { part = v.part, period = v.window.short, rate = v.window.rate }
    }
  ]...)
}

# Alarm names and states only; no venue, guest or card data is ever in a message.
resource "aws_sns_topic" "pages" {
  name = "${var.name}-pages"
}

data "aws_iam_policy_document" "pages_topic" {
  statement {
    sid     = "CloudWatchAndRdsPublish"
    actions = ["sns:Publish"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.rds.amazonaws.com"]
    }
    resources = [aws_sns_topic.pages.arn]
  }
}

resource "aws_sns_topic_policy" "pages" {
  arn    = aws_sns_topic.pages.arn
  policy = data.aws_iam_policy_document.pages_topic.json
}

# The API confirms the subscription itself (a signed SubscriptionConfirmation, then a GET to
# Amazon's SubscribeURL), so no token sits in the Terraform state.
resource "aws_sns_topic_subscription" "pages_api" {
  topic_arn              = aws_sns_topic.pages.arn
  protocol               = "https"
  endpoint               = "https://${aws_cloudfront_distribution.app["api"].domain_name}/v1/hooks/alarms"
  endpoint_auto_confirms = false
  delivery_policy = jsonencode({
    healthyRetryPolicy = { numRetries = 10, minDelayTarget = 5, maxDelayTarget = 60, backoffFunction = "exponential" }
  })
}

# Each window of each burn alarm: the part's failed share of requests over the error budget.
resource "aws_cloudwatch_metric_alarm" "burn_window" {
  for_each            = local.burn_children
  alarm_name          = "${var.name}-burn-${each.key}"
  alarm_description   = "Child of a target-burn composite; no actions of its own."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = each.value.rate
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "burn"
    expression  = "IF(requests > 0, failed / requests / ${local.error_budget}, 0)"
    label       = "Burn rate"
    return_data = true
  }
  metric_query {
    id = "requests"
    metric {
      namespace   = local.telemetry_namespace
      metric_name = "${each.value.part}_requests"
      period      = each.value.period
      stat        = "Sum"
    }
  }
  metric_query {
    id = "failed"
    metric {
      namespace   = local.telemetry_namespace
      metric_name = "${each.value.part}_failed"
      period      = each.value.period
      stat        = "Sum"
    }
  }
}

# Pages when both windows burn: the API turns it into a ticket outside opening hours.
resource "aws_cloudwatch_composite_alarm" "target_burn" {
  for_each          = local.burn_alarms
  alarm_name        = "${var.name}-target-burn-${each.key}"
  alarm_description = "rule:target-burn runbook:docs/runbooks/target-burn.md · ${each.value.part} availability burning ${each.value.window.rate}x"
  alarm_rule        = "ALARM(${aws_cloudwatch_metric_alarm.burn_window["${each.key}-long"].alarm_name}) AND ALARM(${aws_cloudwatch_metric_alarm.burn_window["${each.key}-short"].alarm_name})"
  alarm_actions     = [aws_sns_topic.pages.arn]
  ok_actions        = [aws_sns_topic.pages.arn]
}

# A database failover (rule:db-failover runbook:docs/runbooks/db-failover.md).
resource "aws_db_event_subscription" "failover" {
  name             = "${var.name}-failover"
  sns_topic        = aws_sns_topic.pages.arn
  source_type      = "db-instance"
  source_ids       = [aws_db_instance.main.identifier]
  event_categories = ["failover"]
}
