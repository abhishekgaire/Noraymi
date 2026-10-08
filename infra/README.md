# Infrastructure

Staging runs on AWS in `us-east-1` (decision D85). `infra/staging` is one Terraform root module: a VPC across two zones, ECS Fargate services for the API, the worker and the guest web behind one load balancer, RDS Postgres 16, S3 buckets (files, audit with Object Lock, the unversioned ID-scan keys bucket of M8-14, and the two static apps), KMS keys, Secrets Manager, CloudWatch logs (30 days) with the targets dashboard and its metric filters (`observability.tf`, M8-16), four CloudFront hostnames and the GitHub OIDC deploy role.

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

## Stripe keys (M4-01)

The API and worker use four restricted keys, one per service, each with Connect access: **payments and Terminal**, **refunds**, **read-only reporting**, and **billing** (our own account only). Each webhook endpoint has its own signing secret. They go in the `stripe` secret as `payments_key`, `refunds_key`, `reporting_key`, `billing_key`, `publishable_key`, `webhook_secret_readers`, `webhook_secret_connect` and `webhook_secret_platform`, and reach the tasks as `STRIPE_KEY_PAYMENTS`, `STRIPE_KEY_REFUNDS`, `STRIPE_KEY_REPORTING`, `STRIPE_KEY_BILLING`, `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET_*`. Until they are set, staging refuses Stripe calls (or sends them to a fake Stripe when `STRIPE_API_BASE` names one); production refuses to start without them. Wire the task definitions to these JSON keys only after the secret holds them, or the tasks won't start.

Training mode (M7-04) uses its own sandbox, with test keys only: `sandbox_payments_key`, `sandbox_refunds_key`, `sandbox_reporting_key` and `sandbox_webhook_secret_training` in the same secret reach the tasks as `STRIPE_SANDBOX_KEY_PAYMENTS`, `STRIPE_SANDBOX_KEY_REFUNDS`, `STRIPE_SANDBOX_KEY_REPORTING` and `STRIPE_SANDBOX_WEBHOOK_SECRET_TRAINING`. A live key there is refused when the settings load. Without them, practice card payments are refused (staging sends them to a fake when `STRIPE_API_BASE` names one); they never fall back to the live keys. The training endpoint is `/v1/hooks/stripe/training`, registered in the sandbox as a Connect endpoint for the reader and payment events.

- **IP restriction.** Each key works only from our outbound addresses. Staging's tasks have public IPs that change, so this needs fixed egress first (see Not yet).
- **Rotation, at most 7 days of overlap.** In the Dashboard, roll the key with an expiry of 7 days or less on the old one; put the new key in the secret; force a new deployment of the API and the worker (`aws ecs update-service --force-new-deployment`); check the API's log for Stripe errors; then expire the old key at once rather than waiting. A webhook secret rolls the same way from the endpoint's page. Record each rotation in the ops log.

## Not yet

- A domain. Until one exists the hostnames are `*.cloudfront.net`, and CloudFront talks to the load balancer over HTTP inside AWS with a shared secret header. A domain adds ACM certificates and HTTPS to the origin.
- Fixed egress for Stripe's IP-restricted keys: a NAT gateway with an Elastic IP in front of the tasks (about $35 a month in us-east-1), or the tasks in private subnets behind one. It's a spending decision, so it waits for the founder.
- Production. It is this module with `db_multi_az = true`, bigger tasks, a second region for backups and `ALLOW_STAGING_FEATURES` off, which the task definitions already derive from the environment name.
