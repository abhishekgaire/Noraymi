# The database failed over

**Rule:** `db-failover` · pages us · one page per failover event; acknowledging ends it.

**What fired.** RDS sent a failover event (the Multi-AZ standby took over) through the pages topic (`infra/staging/paging.tf`).

**Why it matters.** Writes in flight at the switch may have failed; our targets allow 60 seconds of data in-region (RPO) and 5 minutes to recover a zone (RTO).

## First five minutes

1. Acknowledge the page.
2. RDS console: is the instance `available` again? How long did it take?
3. API health and error rate: are requests back? Are workers polling (the `jobs` table moving)?

## Fix

- Usually nothing: the app reconnects. If the API or workers kept dead connections, restart the ECS services.
- Payments in flight at the switch: the reconciler settles unknown results; watch for [money dead letters](money-dead-letters.md).
- Run the night's check: `pnpm --filter @west4/api reconcile -- --date <the night>`.
- Write down the time to recover against the 5-minute target.

**Over when** acknowledged and the service is back.
