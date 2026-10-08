# Watching production (M8-16; spec 13 · Watching production, spec 01 · Targets).
#
# With no OTEL_EXPORTER_OTLP_ENDPOINT, the API and the worker write their telemetry as one JSON
# line per record ({"telemetry":"metric",...}) into their log groups, which keep 30 days
# (ecs.tf). These metric filters turn the lines into CloudWatch metrics, and the dashboard shows
# the published targets and the burn rates M8-17's alerts read. Nothing here names a vendor: an
# OpenTelemetry collector or vendor can be added later by setting the endpoint (see Notes in
# docs/backlog M8-16), and these filters keep working from the logs either way.

locals {
  telemetry_namespace = "West4/${var.environment}"
  status_parts        = ["ordering", "payments", "printing", "texts"]
  card_outcomes       = ["ok", "declined", "our_side"]
}

# Requests per part, and the ones we failed (5xx): availability is 1 - failed / requests.
resource "aws_cloudwatch_log_metric_filter" "part_requests" {
  for_each       = toset(local.status_parts)
  name           = "${var.name}-${each.key}-requests"
  log_group_name = aws_cloudwatch_log_group.app["api"].name
  pattern        = "{ $.telemetry = \"metric\" && $.name = \"http.server.requests\" && $.attributes.part = \"${each.key}\" }"
  metric_transformation {
    name          = "${each.key}_requests"
    namespace     = local.telemetry_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "part_failed" {
  for_each       = toset(local.status_parts)
  name           = "${var.name}-${each.key}-failed"
  log_group_name = aws_cloudwatch_log_group.app["api"].name
  pattern        = "{ $.telemetry = \"metric\" && $.name = \"http.server.requests\" && $.attributes.part = \"${each.key}\" && $.attributes.failed IS TRUE }"
  metric_transformation {
    name          = "${each.key}_failed"
    namespace     = local.telemetry_namespace
    value         = "1"
    default_value = "0"
  }
}

# Order to bar alarm: each order's milliseconds, and the ones at 3 seconds or more.
resource "aws_cloudwatch_log_metric_filter" "order_to_alarm" {
  name           = "${var.name}-order-to-alarm"
  log_group_name = aws_cloudwatch_log_group.app["api"].name
  pattern        = "{ $.telemetry = \"metric\" && $.name = \"order_to_alarm_ms\" }"
  metric_transformation {
    name      = "order_to_alarm_ms"
    namespace = local.telemetry_namespace
    value     = "$.value"
    unit      = "Milliseconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "order_to_alarm_slow" {
  name           = "${var.name}-order-to-alarm-slow"
  log_group_name = aws_cloudwatch_log_group.app["api"].name
  pattern        = "{ $.telemetry = \"metric\" && $.name = \"order_to_alarm_ms\" && $.attributes.slow IS TRUE }"
  metric_transformation {
    name          = "order_to_alarm_slow"
    namespace     = local.telemetry_namespace
    value         = "1"
    default_value = "0"
  }
}

# Card payment attempts by outcome; the target counts our_side against ok + our_side (declines don't count).
resource "aws_cloudwatch_log_metric_filter" "card_attempts" {
  for_each       = { for pair in setproduct(["api", "worker"], local.card_outcomes) : "${pair[0]}-${pair[1]}" => pair }
  name           = "${var.name}-card-${each.key}"
  log_group_name = aws_cloudwatch_log_group.app[each.value[0]].name
  pattern        = "{ $.telemetry = \"metric\" && $.name = \"payments.card.attempts\" && $.attributes.outcome = \"${each.value[1]}\" }"
  metric_transformation {
    name          = "card_${each.value[1]}"
    namespace     = local.telemetry_namespace
    value         = "1"
    default_value = "0"
  }
}

# Error reports (scrubbed) from the API, the worker and the screens, and jobs that threw.
resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each       = toset(["api", "worker", "guest"])
  name           = "${var.name}-${each.key}-errors"
  log_group_name = aws_cloudwatch_log_group.app[each.key].name
  pattern        = "{ $.telemetry = \"log\" && $.severity = \"error\" }"
  metric_transformation {
    name          = "error_reports"
    namespace     = local.telemetry_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "job_failures" {
  name           = "${var.name}-job-failures"
  log_group_name = aws_cloudwatch_log_group.app["worker"].name
  pattern        = "{ $.telemetry = \"metric\" && $.name = \"jobs.runs\" && $.attributes.failed IS TRUE }"
  metric_transformation {
    name          = "job_failures"
    namespace     = local.telemetry_namespace
    value         = "1"
    default_value = "0"
  }
}

locals {
  ns = local.telemetry_namespace
  # Availability per part: 99.9% a month (the dashboard shows it live; M8-17 limits it to opening hours).
  availability_metrics = flatten([
    for i, part in ["ordering", "payments", "printing"] : [
      [local.ns, "${part}_requests", { id = "r${i}", visible = false, stat = "Sum" }],
      [local.ns, "${part}_failed", { id = "f${i}", visible = false, stat = "Sum" }],
      [{ expression = "100 * (1 - f${i} / MAX([r${i}, 1]))", label = "${part} available %", id = "a${i}" }],
    ]
  ])
  # Burn rate: the failed fraction over what 99.9% allows (0.1%). 14.4 over an hour pages (M8-17).
  burn_metrics = flatten([
    for i, part in ["ordering", "payments", "printing"] : [
      [local.ns, "${part}_requests", { id = "br${i}", visible = false, stat = "Sum" }],
      [local.ns, "${part}_failed", { id = "bf${i}", visible = false, stat = "Sum" }],
      [{ expression = "(bf${i} / MAX([br${i}, 1])) / 0.001", label = "${part} burn rate", id = "b${i}" }],
    ]
  ])
}

resource "aws_cloudwatch_dashboard" "targets" {
  dashboard_name = "${var.name}-targets"
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "text", x = 0, y = 0, width = 24, height = 3
        properties = {
          markdown = join("\n", [
            "## West 4 · published targets (spec 01 · Targets)",
            "Ordering, payments and printing **99.9% a month** during opening hours · order to bar alarm **under 3 s for 95%** · card payments not failing on our side **99.5%** (declines don't count) · RPO **1 min** in region, **15 min** across · RTO **5 min** for a zone, **2 h** for a region (RDS backups and the restore drill, not these graphs).",
            "Burn rate 1 spends the month's budget in a month; **14.4 for 1 h (and 5 min)** or **6 for 6 h (and 30 min)** pages; **1 for 3 days** opens a ticket (`@west4/shared` BURN_ALERTS, M8-17).",
          ])
        }
      },
      {
        type = "metric", x = 0, y = 3, width = 12, height = 6
        properties = {
          title       = "Available (%), ordering · payments · printing"
          region      = var.region
          period      = 300
          view        = "timeSeries"
          metrics     = local.availability_metrics
          yAxis       = { left = { min = 99, max = 100 } }
          annotations = { horizontal = [{ value = 99.9, label = "target 99.9%" }] }
        }
      },
      {
        type = "metric", x = 12, y = 3, width = 12, height = 6
        properties = {
          title       = "Burn rate (1 h windows)"
          region      = var.region
          period      = 3600
          view        = "timeSeries"
          metrics     = local.burn_metrics
          annotations = { horizontal = [{ value = 14.4, label = "page" }, { value = 6, label = "page (6 h)" }] }
        }
      },
      {
        type = "metric", x = 0, y = 9, width = 12, height = 6
        properties = {
          title  = "Order to bar alarm (ms), p95"
          region = var.region
          period = 300
          view   = "timeSeries"
          metrics = [
            [local.ns, "order_to_alarm_ms", { stat = "p95", label = "p95" }],
            [local.ns, "order_to_alarm_ms", { stat = "p50", label = "p50" }],
          ]
          annotations = { horizontal = [{ value = 3000, label = "target: 95% under 3 s" }] }
        }
      },
      {
        type = "metric", x = 12, y = 9, width = 12, height = 6
        properties = {
          title  = "Card payments failing on our side (%)"
          region = var.region
          period = 3600
          view   = "timeSeries"
          metrics = [
            [local.ns, "card_ok", { id = "ok", visible = false, stat = "Sum" }],
            [local.ns, "card_our_side", { id = "ours", visible = false, stat = "Sum" }],
            [{ expression = "100 * ours / MAX([ok + ours, 1])", label = "our side %", id = "pct" }],
          ]
          annotations = { horizontal = [{ value = 0.5, label = "target: under 0.5%" }] }
        }
      },
      {
        type = "metric", x = 0, y = 15, width = 24, height = 6
        properties = {
          title  = "Error reports and failed jobs"
          region = var.region
          period = 300
          view   = "timeSeries"
          stat   = "Sum"
          metrics = [
            [local.ns, "error_reports"],
            [local.ns, "job_failures"],
            [local.ns, "texts_failed"],
          ]
        }
      },
    ]
  })
}

output "targets_dashboard" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.targets.dashboard_name}"
}
