# A money error

**Rule:** `money-error` · pages us · clears when acknowledged.

**What fired.** The morning money audit (`money.audit`, 8:00 AM on the venue's clock; `apps/api/src/reconcile/audit.ts`) worked last night out again through the money rules and found an amount charged, refunded, tipped, taxed, paid out or reported that differs, by any amount, from what the rules give: a check's tax or gratuity, a check's stored totals against its lines, a double or missed charge, a captured payment on no check, a refund over its cap, a surcharge with the card fee off, the Z report, a drawer, the tip ledger or pool, a payout or a journal. The page names the venue and the night; the venue's owner and our founder got the morning summary by email.

**Why it matters.** It's a money error as [the go-live gate](../milestones.md#the-go-live-gate) defines it. During the gate, it's fixed first, and the 4 weeks of live nights start again.

## First fifteen minutes

1. Acknowledge the page.
2. Read the night's audit: `select errors from money_audits where night = '<date>' order by ran_at desc limit 1` (as the venue), or run it again: `pnpm --filter @west4/api money-audit -- --date <date> --venue <id>`.
3. Add its rows to [the money-error log](../gate/money-errors.md): `pnpm --filter @west4/api money-audit -- --date <date> --venue <id> --log docs/gate/money-errors.md`.
4. Call the venue's owner if a guest was charged wrongly (a double charge, a refund over its cap): the refund or the extra charge is theirs to approve on their own phone.

## Fix

- Find the cause: the check's revisions and lines, its payments and allocations, the refunds, the drawer's moves (with a support grant).
- Fix the money (a refund, a corrected count on the next night, a payout query with Stripe) and the code or setting that caused it, with a test that reproduces it.
- Fill in the cause, the fix and who signed it off in the log, and restart the gate's count in `docs/gate/` (M9-17).

**Over when** acknowledged, the log row is complete, and the next morning's audit is clean.
