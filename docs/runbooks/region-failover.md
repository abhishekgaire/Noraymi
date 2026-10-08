# Losing a region, and the yearly failover drill (M8-20)

Targets ([Scope and architecture](../spec/01-scope-architecture.md) · Targets): across regions we may lose at most **15 minutes** of data (RPO) and must be back within **2 hours** (RTO). Venues keep selling meanwhile on the outage plan: Tap to Pay on a manager's phone and cash, matched afterwards ([When our cloud is down](../spec/01-scope-architecture.md)).

**What's ready in the second region** (`infra/staging/rds.tf`, provider `aws.dr`, `var.dr_region`, default `us-west-2`): the database's automated backups, copied continuously with 35 days of point-in-time restore, encrypted with the second region's own key (`alias/<name>-data-dr`). The ID-scan key bucket is never copied (M8-14). The container images are rebuilt from `main`.

## The warm standby, scripted

1. **Declare it.** Post on the status page (M8-16) that we're restoring service; tell each venue's manager to switch to the break-glass card.
2. **Restore the database in the second region** from the replicated backups, to the latest restorable time:
   ```
   aws rds restore-db-instance-to-point-in-time --region us-west-2 \
     --source-db-instance-automated-backups-arn <the replicated backups' ARN> \
     --target-db-instance-identifier west4-<env>-dr --use-latest-restorable-time \
     --db-subnet-group-name <the dr subnet group> --vpc-security-group-ids <the dr db security group>
   ```
   Write the latest restorable time: the gap to the outage is the data we lost (target ≤ 15 minutes).
3. **Bring up the services** in the second region: `terraform apply` in `infra/<env>` with `-var region=us-west-2 -var dr_region=us-east-1` against a separate state key, pointing `DATABASE_URL` and `APP_DATABASE_URL` at the restored instance. Push the current images to the second region's ECR, or let the deploy workflow do it.
4. **Cut DNS over**: point the API, guest, staff and console hostnames at the second region's load balancer and CloudFront origins; check the records' TTLs beforehand, since the cutover waits that long.
5. **Catch up with Stripe and Twilio.** Webhooks reach the new region once DNS moves, and Stripe retries the ones that failed meanwhile. The reconciler (every 5 minutes) settles payments left unknown, and payments taken on the break-glass card land in **Unmatched payments**. Check each night the outage touched: `pnpm --filter @west4/api reconcile -- --date <the night> --venue <id>`.
6. **Stop the clock.** Write the time from the outage to the first order through the second region: target ≤ 2 hours.
7. **Back home** when the first region returns: the same steps the other way, during closed hours.

## The yearly drill

Once a year on staging, in daytime: run steps 2 to 4 for real against staging's replicated backups, time them, place an order and a simulated reader payment through the second region (the synthetic check, M8-18), then tear the second region's services and instance down. Record it as `docs/drills/<date>-region.md` with the times against the targets.
