# Card payments failing on our side

**Rule:** `payment-failures` · pages us · clears when the burn stops.

**What fired.** Card payment attempts at the venues open right now are failing on our side (a timeout, an unknown result, a 5xx, the reader unreachable) fast enough to spend the 99.5% target's budget: 14.4× over the last hour and the last 5 minutes, or 6× over the last 6 hours and 30 minutes. Declined cards never count.

**Why it matters.** Guests can't pay, or pay and don't see it land.

## First five minutes

1. Acknowledge the page in the Console.
2. Check Stripe's status page and the Console's venue list: is it Stripe, one venue's readers, or us?
3. CloudWatch dashboard (`infra/staging/observability.tf`): `card_our_side` against `card_ok`, and the API's 5xx on payments.
4. If it's Stripe or us and it's lasting, post it: `status:set -- --part payments --state degraded`.

## Fix

- **Unknown results** are settled by the reconciler, never by a retry. Staff see "Checking with Stripe · don't retry". If one is stuck, use the Console's emergency **Re-sync a payment**.
- **One reader stuck** in an action: emergency **Cancel a reader action**.
- **Our API failing**: check the ECS service, roll back the last deploy if it started then.
- **Everything down**: the venue's manager takes cards with the break-glass card (Tap to Pay in Stripe's Dashboard app) and matches them later under "Unmatched payments" (D54).

**Over when** the burn drops below the threshold; the page clears itself.
