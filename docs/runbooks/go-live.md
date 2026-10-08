# Go live at West 4 (M9-16)

The day before the first live night: every line below passes, or the first night moves. Then the cutover, the first night with the founder at the venue and on-call on the phone, and the rollback plan for the first nights ([milestones](../milestones.md#m9--cutover-and-going-live) · M9 Ships, Live nights; [Testing and operations](../spec/13-testing-operations.md) · On call; [Scope and architecture](../spec/01-scope-architecture.md) · When our cloud is down; [Stripe setup](../spec/06-stripe-setup.md) 3 and 11).

**Status:** not run. The first live night isn't set. Nothing below is ticked until it's checked on the day, by name.

## Go or no-go, the day before

Run each on production unless it says otherwise. Write who checked it and when beside it. One "no" is a no-go.

- [ ] **Stripe go-live checklist (M4-29):** Admin → Payments (or the Console's venue page) reads "passes": the merchant category on West 4's account matches, and each owner and manager has a Stripe Dashboard login and a Tap to Pay phone, confirmed by the owner.
- [ ] **Hardware (M9-07):** `pnpm --filter @west4/api devices:check -- --venue west4karaoke` passes: both S710s, the bar computer, the printers and the router paired and seen, and the cellular signal check passed at both pay points ([hardware install](hardware-install.md), [cellular check](cellular-check.md)).
- [ ] **Everyone signed in (M9-08):** `pnpm --filter @west4/api pins:check -- --venue west4karaoke` passes: Admin → Team shows nobody waiting, every person set their own PIN on their own phone and paired a badge, and no imported PIN exists ([PINs and badges](pins-and-badges.md)).
- [ ] **Texts live (M8-22):** West 4's 10DLC campaign is approved and [the runbook's go-live checks](texts-10dlc.md#go-live-checks-production) pass.
- [ ] **The import dry run signed (M9-06):** [gate item 3](../gate/import-dry-run.md) holds West 4's owner's signed report: bookings, deposits and consents match the old system in count and to the cent.
- [ ] **The staff trial passed (M9-11):** `pnpm --filter @west4/api trial:report -- --from <start> --to <end>` met its targets, or the design changed and the trial ran again.
- [ ] **The Spanish review (M9-12):** the fluent reviewer signed [the Spanish review](../gate/spanish-review.md).
- [ ] **The sign-offs (M9-13):** [gate item 2](../gate/sign-offs.md) is met: all ten answers applied.
- [ ] **The outage drill (M8-07):** [gate item 4](../gate/must-fix.md) is met: the four drills passed at West 4, with the report linked.
- [ ] **On call (this ticket):** `pnpm --filter @west4/api oncall:coverage -- --rota docs/gate/oncall-rota.json` passes: every opening hour of the 4 weeks, through each night's close, has a first and a second responder, two different people. Then the test pages below have been acknowledged.
- [ ] **The money audit (M9-15):** `MONEY_AUDIT_TO` holds the founder's address on production, and West 4's owner is an active owner in Admin → Team with an email, so the morning summary reaches both.
- [ ] **Training mode is off on every device** that will take money on the night (`pnpm --filter @west4/api training:check -- --venue west4karaoke`).

## Test pages at the start of the rota

The first time each pair is on call (and for the first shift, the day before): `pnpm --filter @west4/api oncall:coverage -- --rota docs/gate/oncall-rota.json --apply --by "<your name>"` puts that shift into the pager's slots, then `pnpm --filter @west4/api oncall:set -- --test-page --by "<your name>"`. The first responder acknowledges it in the Console; the next pair's test, the second responder waits the 10 minutes and acknowledges the escalation. Every responder named in the rota has acknowledged a test page before the gate starts. At every handover, the incoming first responder runs `--apply`, then `oncall:set -- --show`.

## The cutover (the day of the first live night)

1. **The old booking form off:** West 4 turns off the old site's booking form (Wix) the morning of the move, so no booking lands there that the import won't see.
2. **The final delta import:** with the old system's newest export and its own totals, `pnpm db:import` without `--dry-run` ([import runbook](import.md), the dry run's step 5): it adds only the bookings made since the dry run, and its report says "already" for the rest and "changed" 0. Keep the report beside the signed dry run.
3. **The domain move (M9-09):** [the domain move runbook](domain-move.md) · The move, including the check that every old page redirects and that bookings made on the old site are on the board.
4. **West 4's old point-of-sale system takes no new sales** from the first live night. Cautious default (the spec doesn't say what happens to it): it stays read-only, for looking things up, through the gate, and nobody rings a sale on it. Its last night's Z report is kept with the import evidence.

## The first live night

- The founder is at the venue from opening through the close; the on-call first responder is on the phone the whole night, the second reachable.
- Before opening: every device signed in, both readers online, the board shows the night's bookings, a practice sale is off (training mode off).
- At the close: the night closes in the app, the Z report prints, and the next morning's money audit (8:00 AM) reports no money error. The first live night counts only when that audit is clean.

## Rollback for the first nights

Roll back only when the venue can't take money or seat guests and the [outage runbooks](outage-drill.md) don't get it working within 15 minutes. The founder and West 4's owner decide together.

1. **Keep taking money:** queue mode and break-glass card taps carry the night as the outage drill practiced; nobody re-rings a sale on the old system while queued orders are waiting.
2. **If the night can't go on in the app:** the old point-of-sale system takes the rest of that night's sales (it's read-only until then), and every sale on it is written down for the next day.
3. **The site:** the domain move's own rollback ([domain move](domain-move.md#rollback)) points west4karaoke.com back to the old site; the new booking page stays off until the next attempt.
4. **Afterwards:** the money taken on the old system is entered the next day as late money (it posts to the current business date and names the night), the morning audit runs, and the gate's 4 weeks don't start until a full night runs clean in the app.

## Record

| Date | Who | What | Result |
| ---- | --- | ---- | ------ |
