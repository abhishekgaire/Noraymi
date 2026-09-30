terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  backend "s3" {
    # bucket and key come from infra/staging/backend.hcl (terraform init -backend-config=backend.hcl)
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project     = "west4-karaoke"
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}
