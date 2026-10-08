# Training checklists (M9-10)

Everyone learns on the real screens in training mode before the first live night ([Testing and operations](../spec/13-testing-operations.md) · Training mode). In training every screen shows "TRAINING · not real money"; practice checks are numbered T-…, pay only through Stripe's sandbox with the simulated readers, and stay out of Z reports, tax, exports, tip pools and the reason-only totals.

## Before training

1. Each person has their own PIN and badge (M9-08; [PINs and badges](../runbooks/pins-and-badges.md)).
2. A manager turns on **Training mode** for the person in Admin → Team. For a new hire's first shifts, turn on **Training mode on a device** for their phone instead.
3. The person works through their role's list below on the real screens, with a manager or the trainer beside them. A task is ticked when they do it alone, without help.
4. When the list is done, the trainer writes the date and their initials in the sign-off table, and a manager turns training off for that person.

## Bartenders

These are the timed tasks of the staff trial ([Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · How we'll know it works; [rush script](rush-script.md)). In training, practise until each feels easy; the clock comes in the trial.

- [ ] A walk-up beer, paid in cash: the beer, Pay, the bill handed over.
- [ ] A tab for a tapped phone: New tab, Read to guest (read the consent line aloud), a label, Open, while the guest taps.
- [ ] Another round on a tab: Repeat round, Send.
- [ ] Close a tab with a tip: Close tab, close to the card, the guest tips.
- [ ] Take over the terminal with a badge tap.
- [ ] Accept a room order from the bar orders screen.
- [ ] Void a drink rung by mistake: the line, Not made, a reason, Void.

## Front desk

- [ ] Check in a booking.
- [ ] Seat a walk-in.
- [ ] Offer a room to the next party on the waitlist.
- [ ] Close out a room: the bill, the payment, the room free.

## Managers

Managers also do the bartender and front desk lists.

- [ ] Decide an approval on their own phone (an approval is never decided by the person asking).
- [ ] Count a drawer.
- [ ] Charge the remaining tabs.
- [ ] Close the night.

## Sign-off

One row per person, filled in by the trainer. Names come from Admin → Team; don't add anyone who isn't on the team.

| Person | Role | List done (date) | Trainer | Training turned off (date) |
| --- | --- | --- | --- | --- |
| | | | | |

## Before the first live night

1. Run the training check. It names everyone and every device still in training mode and exits non-zero while any is:

   ```
   pnpm --filter @west4/api training:check -- --venue west4karaoke
   ```

   A new hire's phone left in device training on purpose is named with `--allow-device "<device name>"`, and is the only exception.
2. After the first live night closes, run `pnpm --filter @west4/api reconcile -- --date <YYYY-MM-DD>`: it checks that the night's Z report holds no practice check. Keep its evidence in `docs/gate/`.
