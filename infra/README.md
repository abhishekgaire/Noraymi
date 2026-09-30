# Infrastructure

Staging runs on AWS in `us-east-1` (decision D85). `infra/staging` is one Terraform root module: a VPC across two zones, ECS Fargate services for the API, the worker and the guest web behind one load balancer, RDS Postgres 16, S3 buckets (files, audit with Object Lock, and the two static apps), KMS keys, Secrets Manager, CloudWatch logs, four CloudFront hostnames and the GitHub OIDC deploy role.

Infrastructure changes run from a laptop with an admin profile, never from CI. CI only deploys application code (`.github/workflows/deploy-staging.yml`).

## First time

```
export AWS_PROFILE=<admin profile> AWS_REGION=us-east-1
infra/scripts/bootstrap-state.sh                    # the state bucket; writes infra/staging/backend.hcl
cd infra/staging && terraform init -backend-config=backend.hcl
terraform apply -target=aws_ecr_repository.images   # the registries first, so a bootstrap image can be pushed
# push both images tagged :bootstrap (see the deploy workflow for the build commands)
terraform apply -target=aws_secretsmanager_secret.app
../scripts/seed-secrets.sh                          # random keys and placeholders; nothing lands in state
terraform apply
../scripts/publish-github-vars.sh                   # hostnames, ARNs and ids the deploy workflow reads
```

Then merge to `main`: the deploy workflow builds the images, runs the migrations as a one-off task, rolls the services, publishes the static apps and runs the smoke test.

## Every day

`terraform plan` before `terraform apply`, and read the plan. The database has deletion protection and a final snapshot; the audit bucket's Object Lock can't be turned off.

## Not yet

- A domain. Until one exists the hostnames are `*.cloudfront.net`, and CloudFront talks to the load balancer over HTTP inside AWS with a shared secret header. A domain adds ACM certificates and HTTPS to the origin.
- Production. It is this module with `db_multi_az = true`, bigger tasks, a second region for backups and `ALLOW_STAGING_FEATURES` off, which the task definitions already derive from the environment name.
