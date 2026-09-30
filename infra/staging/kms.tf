# The key service (spec 12). One symmetric key encrypts the database, the
# buckets and the secrets, among them the Ed25519 rule-pack signing key (M1-10).
resource "aws_kms_key" "data" {
  description             = "${var.name} data: RDS, S3 and Secrets Manager"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}
