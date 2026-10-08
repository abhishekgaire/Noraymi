# The go-live gate (M9-17)

Phase 1 is done when all five items of [the go-live gate](../milestones.md#the-go-live-gate) are true. This page tracks them, counts the live nights, and holds the final gate report.

## The five items

| #   | Item                                                                   | Evidence                                    | Status  |
| --- | ---------------------------------------------------------------------- | ------------------------------------------- | ------- |
| 1   | Every must-fix item is closed (M9-14)                                  | [must-fix.md](must-fix.md)                  | not met |
| 2   | The sign-offs marked "gate" are in (M9-13)                             | [sign-offs.md](sign-offs.md)                | not met |
| 3   | West 4's future bookings, deposits and guests imported, nothing lost (M9-06) | [import-dry-run.md](import-dry-run.md) | not met |
| 4   | The outage drill has passed (M8-07)                                    | [must-fix.md](must-fix.md)                  | not met |
| 5   | 4 weeks of live nights without a money error                           | the count below, [money-errors.md](money-errors.md) | not met |

## Live nights since the last money error

**Live nights so far:** none. The first live night isn't set (M9-16).

How it counts: each night's morning money audit (M9-15) says clean or not. A night that any audit found a money error in is an error night, even after the fix and a clean rerun. A money error is fixed first, written in [the money-error log](money-errors.md) and signed off, and the 4 weeks start again from the next night. The 4 weeks are 28 calendar days from the first clean night of the run; the nights the venue is shut don't break it. `pnpm --filter @west4/api gate:status -- --venue west4karaoke` prints the count; every Monday at 8:30 AM the weekly summary emails it to West 4's owner and our founder (`gate.weekly`).

| Week ending | Clean live nights in the run | Run started | Last money error | Days to go |
| ----------- | ---------------------------- | ----------- | ---------------- | ---------- |

## The final gate report

Not written. Once items 1 to 5 all read met: the date; each item's evidence linked; the run's first and last nights with the count from `gate:status`; every money error of the gate from the log, each with its fix and sign-off; and the founder's and West 4's owner's sign-off that phase 1 is done.
