# A spike of refunds

**Rule:** `refund-spike` · pages us · clears when the hour calms down.

**What fired.** At least 5 refunds (pending or done, practice aside) at one venue within 60 minutes (`REFUND_SPIKE` in `apps/api/src/ops/alert-sweep.ts`). The venue's owner is told of each refund on their own phone as it happens.

**Why it matters.** A burst of refunds is how a stolen manager session or an insider moves money out; refunds over the reason-only limit already need an approval, so a spike usually means several approvals in a row.

## First five minutes

1. Acknowledge the page.
2. With a support grant, look at the night's refunds (the exceptions report): who asked, who approved, which payments, cash or card.
3. Call the venue's owner: expected (a broken tap, a disputed bill) or not?

## Fix

- **Expected**: note it on the page.
- **Not**: the owner deactivates the people involved in Admin → Team (offboarding revokes their sessions and devices); cancel pending refunds; then [the breach runbook](breach.md) if a sign-in was misused, and [a sign-in from a new country](signin-new-country.md) may already be open.

**Over when** fewer than 5 refunds in the last 60 minutes.
