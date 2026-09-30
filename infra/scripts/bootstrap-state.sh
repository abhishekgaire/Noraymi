#!/usr/bin/env bash
# Creates the Terraform state bucket once, outside Terraform. Idempotent.
set -euo pipefail
region="${AWS_REGION:-us-east-1}"
account="$(aws sts get-caller-identity --query Account --output text)"
bucket="west4-terraform-state-${account}"
if ! aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
  aws s3api create-bucket --bucket "$bucket" --region "$region"
  aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket "$bucket" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi
dir="$(cd "$(dirname "$0")/../staging" && pwd)"
printf 'bucket = "%s"\nkey    = "staging/terraform.tfstate"\n' "$bucket" > "$dir/backend.hcl"
echo "state bucket: $bucket (written to infra/staging/backend.hcl)"
