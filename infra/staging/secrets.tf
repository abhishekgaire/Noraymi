# The secrets manager. Terraform creates the containers only; their values are
# put in by infra/scripts/seed-secrets.sh so no secret ever lands in the
# Terraform state or the repo. The database password is managed by RDS itself.
locals {
  secret_names = {
    "pin-pepper"            = "HMAC pepper for staff PIN hashes (M1-23)"
    "badge-master-key"      = "NTAG 424 DNA badge master key (M1-25)"
    "stripe"                = "Stripe test-mode keys: secret_key, publishable_key, webhook_secret (M4)"
    "twilio"                = "Twilio test credentials: account_sid, auth_token, from_number"
    "origin-verify"         = "Shared header CloudFront sends the load balancer"
    "app-db-password"       = "Login password of the app_rw database role (M1-05); db:migrate sets it"
    "rule-pack-signing-key" = "Ed25519 private key (PEM) that signs rule-pack versions (M1-10)"
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each    = local.secret_names
  name        = "west4/${var.environment}/${each.key}"
  description = each.value
  kms_key_id  = aws_kms_key.data.arn
}
