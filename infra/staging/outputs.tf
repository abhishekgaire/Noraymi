output "api_url" {
  value = "https://${aws_cloudfront_distribution.app["api"].domain_name}"
}

output "guest_url" {
  value = "https://${aws_cloudfront_distribution.app["guest"].domain_name}"
}

output "staff_url" {
  value = "https://${aws_cloudfront_distribution.static["staff"].domain_name}"
}

output "console_url" {
  value = "https://${aws_cloudfront_distribution.static["console"].domain_name}"
}

# Everything the deploy workflow needs, published to GitHub as variables by infra/scripts/publish-github-vars.sh.
output "github_variables" {
  value = {
    AWS_REGION            = var.region
    AWS_DEPLOY_ROLE_ARN   = aws_iam_role.github_deploy.arn
    ECR_API               = aws_ecr_repository.images["api"].repository_url
    ECR_GUEST             = aws_ecr_repository.images["guest"].repository_url
    ECS_CLUSTER           = aws_ecs_cluster.main.name
    ECS_SUBNETS           = join(",", aws_subnet.public[*].id)
    ECS_SECURITY_GROUP    = aws_security_group.tasks.id
    STATIC_BUCKET_STAFF   = aws_s3_bucket.staff.bucket
    STATIC_BUCKET_CONSOLE = aws_s3_bucket.console.bucket
    CLOUDFRONT_STAFF      = aws_cloudfront_distribution.static["staff"].id
    CLOUDFRONT_CONSOLE    = aws_cloudfront_distribution.static["console"].id
    STAGING_API_URL       = "https://${aws_cloudfront_distribution.app["api"].domain_name}"
    STAGING_GUEST_URL     = "https://${aws_cloudfront_distribution.app["guest"].domain_name}"
    STAGING_STAFF_URL     = "https://${aws_cloudfront_distribution.static["staff"].domain_name}"
    STAGING_CONSOLE_URL   = "https://${aws_cloudfront_distribution.static["console"].domain_name}"
  }
}
