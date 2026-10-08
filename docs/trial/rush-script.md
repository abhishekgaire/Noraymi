# The timed staff trial: a scripted 20-minute rush (M9-11)

Before go-live, three bartenders new to the system and a front-desk person run this rush in the venue, music on and hands wet, in training mode. We count taps, errors and seconds per task against the targets ([Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · How we'll know it works; [Testing and operations](../spec/13-testing-operations.md) · Tests). The targets are hypotheses: a missed target changes the design (a new ticket), never the target, and the trial runs again. It repeats after the first real Friday.

## The targets

| Task | Taps on the prototype | Target |
| --- | --- | --- |
| A walk-up beer, paid in cash | 3: the beer, Pay, the bill handed over | Under 8 s |
| Open a tab for a tapped phone | 4: New tab, Read to guest ✓, a label, Open, while the guest taps | Under 20 s, reading the consent line included |
| Another round on a tab | 2: Repeat round, Send | Under 3 s |
| Close a tab with a tip | 2 on the open tab: Close tab, Close to the card, then the guest tips | Under 20 s with the guest |
| Take over the terminal | 1 badge tap | Under 2 s |
| Accept a room order | 1 | Every order accepted within 2 minutes |
| Void a drink rung by mistake | 4: the line, Not made, a reason, Void | Under 6 s |

The front desk has no targets in the spec. Its check-ins, walk-ins and room close-outs are timed as a baseline and not judged (the ticket's cautious default).

## Who

- Three bartenders who haven't used the system, and one front-desk person. Their names go in the results, from Admin → Team.
- A trainer who reads the cues below and plays the guests (taps the practice phone, hands over cash, tips on the reader).
- Each of them in training mode (Admin → Team), or the bar computer and the front desk in device training. The simulated readers take the practice cards.

## Before the day

1. The staging dry run (the ticket's test): on staging's test venue, run the rush driver and a few minutes of each task, then `trial:report` for the window. Check every task was found; the report lists each measured window's taps, so a rule that missed shows.
2. Decide how the room orders reach the practice rooms at West 4 (see "The room orders" below).

## The rush

Minute 0 is when the trainer says "go". The front desk seats three practice walk-ins first (IDs checked as usual), then the trainer starts the driver.

| When | Cue | Who |
| --- | --- | --- |
| 0:00 to 20:00 | Room orders arrive on the practice rooms: one every 90 seconds, three at once at minute 10 | The driver; any bartender accepts |
| 0:30, 6:00, 12:30, 18:00 | A walk-up beer, paid in cash | Each bartender in turn |
| 1:30, 8:00, 14:00 | Open a tab for a tapped phone (read the consent line aloud) | Each bartender |
| 3:00, 4:00, 9:30, 10:30, 15:30, 16:30 | Another round on a tab | Whoever opened it |
| 7:00, 13:00, 19:00 | Close a tab with a tip | Whoever opened it |
| 5:00, 11:00, 17:00 | Take over the terminal with a badge tap | The next bartender |
| 2:30, 9:00, 15:00 | Void a drink rung by mistake | Each bartender |
| Throughout | Check in, a walk-in, a room close-out | The front desk |

The driver's schedule is `RUSH_ORDERS` in `apps/api/src/ops/rush.ts`; it orders what's on the venue's own menu (one-tap items, nothing 86'd), alcohol or soft as the script says.

## The room orders

A practice room session can't be joined by a phone or a tablet at a real venue: practice never reaches a real guest (M7-03). Only a test venue lets the driver in. So until the founder decides, the room-order part of the rush runs one of two ways:

- **On staging's test venue** with West 4's menu, on the venue's own bar computer and readers, or
- **At West 4**, once a decision lets the trial's driver join practice rooms there (a `docs/decisions.md` row that changes M7-03's wall for the trial only).

The other tasks run at West 4 in training mode either way.

## Running it

```
# the room orders, on the open practice rooms (DATABASE_URL and AUTH_SECRET_KEY as the API's)
pnpm --filter @west4/api rush:drive -- --api <API url> --venue <slug> [--dry-run]

# the results, for the rush's window
pnpm --filter @west4/api trial:report -- --venue <slug> --from <ISO start> --to <ISO end> \
  --title "before go-live" --out docs/gate/staff-trial-<date>.md
```

The staff app captures taps, the errors it showed and a badge take-over's two moments only while the person or the screen is in training; the API refuses the capture outside training. `trial:report` exits non-zero when a target is missed.

## Results

Kept in `docs/gate/`: one file for the trial before go-live, one for each rerun after a design change, and one for the rerun after the first real Friday.
