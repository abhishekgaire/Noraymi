# A payout doesn't reconcile

**Rule:** `payout-unreconciled` · pages us · one page per payout; acknowledging ends it.

**What fired.** Stripe's payout was matched line by line (M7-14) and the lines don't add up to the payout. The venue's owner was also told.

**Why it matters.** Money reached the bank that our records don't explain, or the other way round. Spec 12 · 4: payouts are matched every night.

## First five minutes

1. Acknowledge the page.
2. With a support grant, open the payout's lines: which are `unmatched` or `other`?
3. Compare with Stripe's payout reconciliation report for the same payout.

## Fix

- **A payment with no row** (taken outside us, such as break-glass Tap to Pay): match it under "Unmatched payments".
- **A fee, refund or dispute** we don't model: note it for the owner; nothing to change.
- **Our bug**: fix it, then `pnpm --filter @west4/api reconcile -- --date <the night> --venue <id>` and keep the evidence.

**Over when** acknowledged and the owner has the explanation.
