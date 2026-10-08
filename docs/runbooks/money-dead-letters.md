# Money jobs in the dead-letter queue

**Rule:** `money-dead-letters` · pages us · clears when the venue has no dead money job.

**What fired.** A job that moves money (the critical pool, or a `payment.*`, `refund.*`, `tab.*` or `stripe.*` job) ran out of attempts and is `dead` in the `jobs` table, with its last error.

**Why it matters.** A payment, refund, capture or Stripe event wasn't finished. Money may be out of step with Stripe.

## First five minutes

1. Acknowledge the page.
2. Read the job's kind, `last_error` and payload ids (no personal data is in them) with a support grant.
3. Check whether Stripe already did the thing (the payment, refund or capture by its idempotency key).

## Fix

- **Stripe did it**: emergency **Re-sync a payment** brings our row in line.
- **Stripe didn't, and the cause is fixed** (a deploy, a timeout): requeue the job under the same dedupe and idempotency keys so Stripe can't do it twice.
- **A bug**: leave it dead, fix the code, then requeue.
- Afterwards, `pnpm --filter @west4/api reconcile -- --date <the night> --venue <id>` checks the night to the cent.

**Over when** no money job is dead at that venue.
