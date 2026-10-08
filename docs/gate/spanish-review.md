# Spanish review of every staff screen (M9-12)

A fluent Spanish speaker checks every staff screen in Spanish before go-live ([Tenancy and access](../spec/02-tenancy-access.md) · Languages; [Testing and operations](../spec/13-testing-operations.md) · Language tests). Menu items keep their menu names; room and guest names are the venue's data.

## The pack

- **Screenshots:** the staff smoke test "the Spanish review" walks every staff route in Spanish at phone (390) and desktop (1440) sizes on the demo night and saves each screen with an `index.md` to fill in. Locally: `pnpm e2e --project staff -g "Spanish review"`, then open `spanish-review/index.md`. In CI it's the `spanish-review` artifact of the staff smoke job. The same run fails when any Spanish text is cut off or a page scrolls sideways.
- **Fixed sentences:** `packages/shared/src/i18n/fixed-sentences.ts` lists each of the glossary's fixed sentences with its one Spanish wording; a unit test holds every catalog string to it.
- **Missing strings:** `pnpm i18n:check` fails on any staff string without Spanish.

## What the first run found and fixed (Oct 8, 2026)

- The phone's tab bar broke Spanish words letter by letter on a manager's phone; words now stay whole and the bar scrolls sideways.
- A long Spanish option widened Admin → Cash drawers on the desktop and Admin → Card fee and tip on a phone; fields now shrink to fit.
- Two room orders didn't fit beside the sale in the bar POS at 1440 in Spanish; each order card is narrower.
- The clear-out check read two ways ("Recorre cada sala y la barra · que no quede ninguna bebida" and another); now one.
- "Cut off by Andy at 10:30 PM" read "Corte de …" on one screen and "Cortado por …" on others; now "Cortado por …" everywhere.

## For the reviewer

Write OK or the fix beside each screen in the index, and check the fixed-sentence list. Things worth a close look: the Room 9 running bill at phone size (the bill's columns are narrow in Spanish), and the action verb "Cortar" against the state "Cortado".

## Sign-off

| Reviewer | Date | Screens | Fixed sentences | Fixes merged |
| --- | --- | --- | --- | --- |
| | | | | |
