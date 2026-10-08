# The money-error log (M9-15)

Every money error found on a live night ([the go-live gate](../milestones.md#the-go-live-gate) · a money error): the night, what differed and by how much, the cause, the fix and who signed it off. The morning audit (`money.audit`, 8:00 AM on the venue's clock) finds them, pages us ([runbook](../runbooks/money-error.md)) and emails the summary to the venue's owner and our founder; `pnpm --filter @west4/api money-audit -- --date <date> --venue <id> --log docs/gate/money-errors.md` adds its rows here, and a person fills in the last three columns. A money error during the gate restarts its 4 weeks (M9-17).

What the audit covers, every night: each check's tax and gratuity worked out again through `packages/rules` and compared with its stored lines and revision; every paid check's payments against what it comes to (a double or missed charge); every captured payment on a check or a booking; every refund against its cap; the card fee (off at West 4, so any surcharge is an error); and, from the reconcile script (M7-19), the Z report against the checks, each drawer's count against its moves, the tip ledger and the pool's shares, each payout's lines and the journals, with practice kept out.

**Live nights so far:** none. No live night has run yet (M9-16).

| Night | Venue | Kind | Check or payment | What differed | By (cents) | Cause | Fix | Signed off by |
| ----- | ----- | ---- | ---------------- | ------------- | ---------- | ----- | --- | ------------- |
