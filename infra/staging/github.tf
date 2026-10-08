# GitHub Actions deploys through OIDC: no AWS keys are stored in GitHub. The
# role can push images, roll the services, run the migration task, publish the
# static apps and invalidate the CDN. It cannot change infrastructure.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"] # unused by AWS for GitHub since 2023, but required
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${var.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrPush"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages"]
    resources = [for r in aws_ecr_repository.images : r.arn]
  }
  statement {
    sid       = "EcsDeploy"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:DescribeServices", "ecs:UpdateService", "ecs:RunTask", "ecs:DescribeTasks", "ecs:ListTasks"]
    resources = ["*"]
  }
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task_execution.arn, aws_iam_role.task.arn]
  }
  statement {
    sid       = "StaticSites"
    actions   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = flatten([for b in local.static_buckets : [b.arn, "${b.arn}/*"]])
  }
  statement {
    sid       = "Cdn"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [for d in aws_cloudfront_distribution.static : d.arn]
  }
  statement {
    sid       = "MigrationLogs"
    actions   = ["logs:GetLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.app["migrate"].arn}:*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

# M8-19: the payment page check (.github/workflows/pay-page-check.yml) pages us
# when a weekly or post-deploy run fails, and clears the page when one passes,
# by publishing an alarm-shaped message to the pages topic (paging.tf). Its own
# role can do nothing else.
resource "aws_iam_role" "github_checks" {
  name               = "${var.name}-github-checks"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "github_checks" {
  statement {
    sid       = "PublishPages"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.pages.arn]
  }
}

resource "aws_iam_role_policy" "github_checks" {
  name   = "checks"
  role   = aws_iam_role.github_checks.id
  policy = data.aws_iam_policy_document.github_checks.json
}
