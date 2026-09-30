# The key service (spec 12). One symmetric key encrypts the database, the
# buckets and the secrets; one asymmetric key signs rule-pack versions (M1-10).
resource "aws_kms_key" "data" {
  description             = "${var.name} data: RDS, S3 and Secrets Manager"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "rule_pack_signing" {
  description              = "${var.name} rule-pack signing"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = 30
}

resource "aws_kms_alias" "rule_pack_signing" {
  name          = "alias/${var.name}-rule-pack-signing"
  target_key_id = aws_kms_key.rule_pack_signing.key_id
}
