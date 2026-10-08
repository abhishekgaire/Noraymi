# Stripe webhooks waiting over a minute

**Rule:** `webhook-lag` · pages us · clears when nothing has waited a minute.

**What fired.** A Stripe webhook was received and stored (`webhook_events`) but not processed for over a minute.

**Why it matters.** Reader results, captures, refunds and payouts arrive this way. Staff screens can show "Checking with Stripe" longer than they should.

## First five minutes

1. Acknowledge the page.
2. Are the workers running? Is the `stripe.event` job for it queued, running or dead?
3. Is the database slow (CloudWatch, RDS Performance Insights)?

## Fix

- **Workers down**: restart the worker service.
- **Job dead**: see [money dead letters](money-dead-letters.md).
- **A backlog**: it drains on its own once the cause is gone; the reconciler covers any payment left unknown.

**Over when** no Stripe webhook has waited over a minute.
