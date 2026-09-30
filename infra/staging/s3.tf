data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
}

# Files and PDFs (spec 01).
resource "aws_s3_bucket" "files" {
  bucket = "${var.name}-files-${local.account}"
}

# The daily write-once audit export (M1-07). Object Lock can only be turned on
# when the bucket is created; each export sets its own retention.
resource "aws_s3_bucket" "audit" {
  bucket              = "${var.name}-audit-${local.account}"
  object_lock_enabled = true
}

# The two static apps behind their own CloudFront distributions.
resource "aws_s3_bucket" "staff" {
  bucket = "${var.name}-staff-${local.account}"
}

resource "aws_s3_bucket" "console" {
  bucket = "${var.name}-console-${local.account}"
}

locals {
  all_buckets    = { files = aws_s3_bucket.files, audit = aws_s3_bucket.audit, staff = aws_s3_bucket.staff, console = aws_s3_bucket.console }
  data_buckets   = { files = aws_s3_bucket.files, audit = aws_s3_bucket.audit }
  static_buckets = { staff = aws_s3_bucket.staff, console = aws_s3_bucket.console }
}

resource "aws_s3_bucket_public_access_block" "all" {
  for_each                = local.all_buckets
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "all" {
  for_each = local.all_buckets
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  for_each = local.data_buckets
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "static" {
  for_each = local.static_buckets
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Only the matching CloudFront distribution may read a static bucket.
resource "aws_s3_bucket_policy" "static" {
  for_each = local.static_buckets
  bucket   = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${each.value.arn}/*"
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.static[each.key].arn }
      }
    }]
  })
}
