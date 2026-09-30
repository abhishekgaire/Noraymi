# One load balancer in front of the API and the guest web. CloudFront tells it
# which app it wants with a header, plus a shared secret so nothing but the CDN
# gets an answer.
resource "aws_lb" "main" {
  name               = var.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  idle_timeout       = 120
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path                = "/v1/health"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 15
}

resource "aws_lb_target_group" "guest" {
  name        = "${var.name}-guest"
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path                = "/"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 15
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }
}

data "aws_secretsmanager_secret_version" "origin_verify" {
  secret_id  = aws_secretsmanager_secret.app["origin-verify"].id
  depends_on = [aws_secretsmanager_secret.app]
}

locals {
  origin_verify = data.aws_secretsmanager_secret_version.origin_verify.secret_string
}

resource "aws_lb_listener_rule" "app" {
  for_each     = { api = aws_lb_target_group.api.arn, guest = aws_lb_target_group.guest.arn }
  listener_arn = aws_lb_listener.http.arn
  priority     = each.key == "api" ? 10 : 20
  action {
    type             = "forward"
    target_group_arn = each.value
  }
  condition {
    http_header {
      http_header_name = "X-West4-App"
      values           = [each.key]
    }
  }
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [local.origin_verify]
    }
  }
}
