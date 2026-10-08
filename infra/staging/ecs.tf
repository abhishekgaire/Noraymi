resource "aws_ecs_cluster" "main" {
  name = var.name
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker", "guest", "migrate"])
  name              = "/west4/${var.environment}/${each.key}"
  retention_in_days = 30
}

locals {
  db_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn
  # The staging-only switch. A production task definition never sets it.
  app_env = [
    { name = "WEST4_ENV", value = var.environment },
    { name = "ALLOW_STAGING_FEATURES", value = var.environment == "staging" ? "true" : "false" },
    { name = "RULE_PACK_APPROVERS", value = "Abhishek Gaire,Claude Code" },
    { name = "HOST", value = "0.0.0.0" },
    { name = "DB_HOST", value = aws_db_instance.main.address },
    { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
    { name = "DB_NAME", value = aws_db_instance.main.db_name },
    { name = "DB_USER", value = aws_db_instance.main.username },
    { name = "S3_BUCKET_FILES", value = aws_s3_bucket.files.bucket },
    { name = "S3_BUCKET_AUDIT", value = aws_s3_bucket.audit.bucket },
    { name = "S3_BUCKET_ID_KEYS", value = aws_s3_bucket.id_keys.bucket },
    # Email (M1-18). Staging sends only to the allow-list; empty sends nothing.
    { name = "EMAIL_FROM", value = var.email_from },
    { name = "EMAIL_ALLOW_LIST", value = var.email_allow_list },
    # Sign-in (M1-19). Passkeys are bound to the staff app's domain; the API is on another site, so the cookie is SameSite=None.
    { name = "WEBAUTHN_RP_ID", value = aws_cloudfront_distribution.static["staff"].domain_name },
    { name = "WEBAUTHN_ORIGINS", value = "https://${aws_cloudfront_distribution.static["staff"].domain_name}" },
    { name = "SESSION_COOKIE_SAME_SITE", value = "None" },
    # The Console (M1-35): our staff's tool on its own hostname; security keys bind to it. Single sign-on
    # (CONSOLE_OIDC_ISSUER, _CLIENT_ID, _CLIENT_SECRET) is added as secrets once the provider is chosen;
    # until then staging's Console says sign-on isn't configured.
    { name = "CONSOLE_URL", value = "https://${aws_cloudfront_distribution.static["console"].domain_name}" },
    # Paging (M8-17): the alarm hook believes only Amazon-signed messages from this topic.
    { name = "PAGES_TOPIC_ARN", value = aws_sns_topic.pages.arn },
  ]
  # The API and the worker connect as app_rw, behind the venue wall (M1-05).
  app_secrets = [
    { name = "APP_DB_PASSWORD", valueFrom = aws_secretsmanager_secret.app["app-db-password"].arn },
    { name = "PIN_PEPPER", valueFrom = aws_secretsmanager_secret.app["pin-pepper"].arn },
    { name = "BADGE_MASTER_KEY", valueFrom = aws_secretsmanager_secret.app["badge-master-key"].arn },
    { name = "RULE_PACK_SIGNING_KEY", valueFrom = aws_secretsmanager_secret.app["rule-pack-signing-key"].arn },
    { name = "SMTP_URL", valueFrom = aws_secretsmanager_secret.app["smtp-url"].arn },
    { name = "AUTH_SECRET_KEY", valueFrom = aws_secretsmanager_secret.app["auth-secret-key"].arn },
  ]
  # CI replaces the image on every deploy; Terraform's copy is the template.
  bootstrap_image = { api = "${aws_ecr_repository.images["api"].repository_url}:bootstrap", guest = "${aws_ecr_repository.images["guest"].repository_url}:bootstrap" }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name         = "api"
    image        = local.bootstrap_image.api
    essential    = true
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment  = concat(local.app_env, [{ name = "PORT", value = "3000" }])
    secrets      = local.app_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = aws_cloudwatch_log_group.app["api"].name, awslogs-region = var.region, awslogs-stream-prefix = "api" }
    }
  }])
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name        = "worker"
    image       = local.bootstrap_image.api
    command     = ["node", "dist/worker.js"]
    essential   = true
    environment = local.app_env
    # The synthetic check's device key and PIN (M8-18) reach the worker only.
    secrets = concat(local.app_secrets, [
      { name = "SYNTHETIC_CHECK", valueFrom = aws_secretsmanager_secret.app["synthetic-check"].arn },
    ])
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = aws_cloudwatch_log_group.app["worker"].name, awslogs-region = var.region, awslogs-stream-prefix = "worker" }
    }
  }])
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

# One-off task CI runs after every deploy: the migrations, as the table owner.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name        = "migrate"
    image       = local.bootstrap_image.api
    command     = ["node", "node_modules/@west4/db/dist/cli.js", "migrate"]
    essential   = true
    environment = local.app_env
    # Migrations run as the table owner (the RDS master user) and give app_rw its login.
    secrets = [
      { name = "DB_PASSWORD", valueFrom = "${local.db_secret_arn}:password::" },
      { name = "APP_DB_PASSWORD", valueFrom = aws_secretsmanager_secret.app["app-db-password"].arn },
      { name = "RULE_PACK_SIGNING_KEY", valueFrom = aws_secretsmanager_secret.app["rule-pack-signing-key"].arn },
      { name = "AUTH_SECRET_KEY", valueFrom = aws_secretsmanager_secret.app["auth-secret-key"].arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = aws_cloudwatch_log_group.app["migrate"].name, awslogs-region = var.region, awslogs-stream-prefix = "migrate" }
    }
  }])
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_task_definition" "guest" {
  family                   = "${var.name}-guest"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name         = "guest"
    image        = local.bootstrap_image.guest
    essential    = true
    portMappings = [{ containerPort = 3001, protocol = "tcp" }]
    environment  = [{ name = "WEST4_ENV", value = var.environment }, { name = "PORT", value = "3001" }, { name = "HOSTNAME", value = "0.0.0.0" }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = aws_cloudwatch_log_group.app["guest"].name, awslogs-region = var.region, awslogs-stream-prefix = "guest" }
    }
  }])
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

locals {
  services = {
    api    = { task = aws_ecs_task_definition.api.arn, tg = aws_lb_target_group.api.arn, container = "api", port = 3000 }
    worker = { task = aws_ecs_task_definition.worker.arn, tg = null, container = "worker", port = null }
    guest  = { task = aws_ecs_task_definition.guest.arn, tg = aws_lb_target_group.guest.arn, container = "guest", port = 3001 }
  }
}

resource "aws_ecs_service" "app" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = each.value.task
  desired_count   = 1
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  dynamic "load_balancer" {
    for_each = each.value.tg == null ? [] : [each.value]
    content {
      target_group_arn = load_balancer.value.tg
      container_name   = load_balancer.value.container
      container_port   = load_balancer.value.port
    }
  }

  depends_on = [aws_lb_listener_rule.app]

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
