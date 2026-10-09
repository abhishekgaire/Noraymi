# K · Kitchen

**Awaiting approval of [docs/spec/16-kitchen.md](../spec/16-kitchen.md).** Don't start any ticket here until the founder approves that draft; then remove this line.

Oct 9, 2026 · the proposed backlog for the Kitchen & food module, for Sing Sing Karaoke, Astoria, the first venue to go live ([D98](../decisions.md)). One ticket per Claude Code session. The [draft spec](../spec/16-kitchen.md) says how each piece works. Tests use a test-only kitchen menu marked as such, laid over the demo seed in the test helpers; the demo seed stays West 4's and gains no food, and no Sing Sing fact is invented.

**Goal (usable when done):** at a venue with the Kitchen module on, guests and staff order food like drinks, the bar accepts it, a ticket prints on the kitchen printer, and a runner carries it to the room.

**Done when:**

- A food order from a guest's phone, a room tablet, the bar POS, a bar tab and a room tab each prints a kitchen ticket at Accept, and a mixed basket prints drinks at the bar and food in the kitchen.
- A kitchen ticket that doesn't print shows on the bar screens, tells the manager on duty, and can be reprinted at the kitchen or at the bar.
- A runner's Picked up and Delivered close a food run, and Delivered never charges.
- 86 and Close the kitchen grey food out on every menu, and the allergy notice shows on every menu.
- A package with food prints its food when staff add it, and its price divides across its lines to the cent.

**Depends on:** M3 (room orders, tickets, runs and 86), M6 (the bar POS and tabs) and M7 (reports and the journal). **Size:** about 3 weeks (5 S, 6 M).

## Suggested order

1. **Foundations:** K-01, then K-02.
2. **Tickets and orders:** K-03, then K-04 and K-05 in parallel, then K-06.
3. **Menu and money:** K-07, K-08, K-09 and K-10, in any order once K-02 is done.
4. **Proof:** K-11.

Definition of done: see CLAUDE.md.

## Tickets

### K-01 · Add the Kitchen module switch and the `kitchen` settings

- **Status:** todo
- **Size:** S
- **Depends on:** the M1 modules and settings tickets; M3-13 (printers)
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · The Kitchen module; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Modules
- **Build:**
  - `kitchen` in the module list, needing Bar screen & tickets, in the dependency table and What each module hides.
  - The `kitchen` settings key (`allergyNotice`, `lastOrder`), versioned and validated like the others, and Admin → Kitchen to edit it.
  - Turning the module on is refused until a kitchen printer is paired and the allergy notice is set ("Kitchen · needs a kitchen printer and the allergy notice"); turning it off is refused while a kitchen order is open.
- **Acceptance:**
  - [ ] With no kitchen printer or no notice, Admin → Features keeps Kitchen off and says what's missing.
  - [ ] Turning Bar screen & tickets off lists Kitchen among what turns off with it.
  - [ ] Every kitchen route answers `404 module_off` while the module is off.
  - [ ] Turning Kitchen off with a kitchen order being made is refused.
- **Tests:** unit tests for the dependency rules; integration tests for the settings key and the module routes; the principal and venue-wall suites over Admin → Kitchen.
- **Notes:**

### K-02 · Route items to a station, and split a basket into one order per station

- **Status:** todo
- **Size:** M
- **Depends on:** K-01; M3-03, M3-04, M3-06
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Stations; [Data model](../spec/04-data-model.md) · Room orders
- **Build:**
  - Migration: `menu_items.station` limited to `bar` and `kitchen`; `orders.station`, `orders.basket_id` and `orders.allergy_note` (up to 200 characters); `order_items.package_id`; row-level security unchanged and a venue-wall test.
  - Admin → Menu shows Station on each item only while the module is on.
  - The order pipeline splits a basket or round with lines for both stations into one order per station sharing `basket_id`; options and variants follow their item.
- **Acceptance:**
  - [ ] A basket of one food item and two drinks becomes two orders, one per station, with one `basket_id`.
  - [ ] An option on a food item stays on the kitchen order.
  - [ ] With the module off, a `kitchen` item can't be saved or ordered.
- **Tests:** unit tests for the split; integration tests against Postgres with row-level security on; the migration linter.
- **Notes:**

### K-03 · Print kitchen tickets, with failures, reprints at the bar and AFTER OUTAGE

- **Status:** todo
- **Size:** M
- **Depends on:** K-02; M3-13 (network printers), M8 (offline replay)
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Kitchen tickets; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Tickets and Outages
- **Build:**
  - Accept on a kitchen order creates a print job for the kitchen printer; the kitchen ticket layout ("KITCHEN", the room or tab, time, who accepted, lines with options and notes, the boxed allergy note, no prices).
  - Pairing refuses a USB printer for the kitchen station.
  - A failed kitchen job shows "Kitchen ticket didn't print · Reprint" on the bar screens and pushes to the manager on duty; Reprint offers the kitchen printer or Print at the bar instead, numbering REPRINT 2, 3 and so on.
  - Accepting a replayed food order prints "AFTER OUTAGE · check with the kitchen before making".
- **Acceptance:**
  - [ ] Accepting a mixed basket prints one bar ticket and one kitchen ticket on the fake printers, and the kitchen ticket shows the allergy note boxed and no prices.
  - [ ] A kitchen job unconfirmed after three polls raises `print_job.failed`, shows on the bar POS and bar orders screen, and reaches the manager's phone.
  - [ ] Print at the bar instead prints the same ticket on the bar printer as REPRINT 2.
  - [ ] A replayed food order prints with AFTER OUTAGE.
- **Tests:** integration tests with the fake CloudPRNT printer; an end-to-end test of the failure and reprint; English and Spanish strings.
- **Notes:** The printer model is an open question; build against the fake printer.

### K-04 · Order food from the room page and the room tablet, with the allergy note

- **Status:** todo
- **Size:** M
- **Depends on:** K-02, K-03; M3-09, M3-11, M3-12
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Ordering food
- **Build:**
  - Food sections on the room page and tablet; the basket's optional allergy field (draft wording, flagged for the lawyer); two order cards, "Drinks" and "Food", in the existing guest words.
  - Same again includes food.
  - After 4 AM, a food order keeps ringing while unaccepted alcohol is cancelled.
- **Acceptance:**
  - [ ] A guest's mixed basket shows as two cards that each move through the guest words.
  - [ ] The guest can cancel the food card while it's ringing, and nothing is charged.
  - [ ] At 4:00 AM on the simulated clock, the drinks card is cancelled as `alcohol_closed` and the food card keeps ringing.
  - [ ] A food-only order shows no ID status.
- **Tests:** end-to-end tests from a fresh seed with the test kitchen menu; the accessibility checks on the room page and tablet.
- **Notes:** The allergy field's wording and the note's retention are open with the lawyer.

### K-05 · Add food from the bar POS, bar tabs, quick sale and room tabs

- **Status:** todo
- **Size:** M
- **Depends on:** K-03; M3-07, M6-02, M6-03, M6-05
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Ordering food; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · rule 2
- **Build:**
  - A Food section after the ten fixed sections, only while the module is on, so no drink moves.
  - Send and a room tab's add split drinks and food and print each at its station; the kitchen ticket names the tab, or for a quick sale the person who rang it and the time.
- **Acceptance:**
  - [ ] Turning the module on adds the Food section and leaves every drink in its slot.
  - [ ] A round with food on Jess P.'s tab prints "Bar · Jess P." on the kitchen ticket and puts the food on the tab.
  - [ ] Adding food from Room 9's tab on a phone puts it on the check at once and prints in the kitchen.
- **Tests:** end-to-end tests on the bar POS and the staff phone; English and Spanish strings.
- **Notes:** How bar food reaches the guest is open with the founder; the cautious default is no run.

### K-06 · Run food: In the kitchen and Picked up on the runners' phones

- **Status:** todo
- **Size:** M
- **Depends on:** K-03; M3-15, M3-18
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Runners and delivery
- **Build:**
  - Accepted kitchen orders show "In the kitchen · ticket printed · age" on the bar orders screen and on Runs, with no Ready button at the bar.
  - `POST /orders/{o}/pick-up` records Ready and the claim in one transaction, writing both events.
  - Returns and Remake as for drinks; a remake prints a kitchen ticket marked REMAKE.
- **Acceptance:**
  - [ ] Picked up moves an accepted food order to "On its way · Andy", and Delivered charges nothing.
  - [ ] Picked up on an order that isn't accepted is refused.
  - [ ] A remake prints REMAKE in the kitchen and charges nothing again.
- **Tests:** unit tests for the step checks; integration tests for the route as every principal; an end-to-end run on a staff phone.
- **Notes:**

### K-07 · 86 food, close the kitchen, and the last-order time

- **Status:** todo
- **Size:** S
- **Depends on:** K-02; M3-03
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · 86 and closing the kitchen
- **Build:** 86 for food items, variants and options through the existing routes; Close the kitchen and Reopen the kitchen for managers; `kitchen.lastOrder` refusing new food orders after it, enforced on the server.
- **Acceptance:**
  - [ ] An 86'd food option greys out on the bar POS and the room page, and an order for it is refused by the server.
  - [ ] Close the kitchen greys every food item and shows "Kitchen closed" on the guest menu; accepted orders still print.
  - [ ] With `lastOrder` empty, food can be ordered whenever room ordering is open.
- **Tests:** integration tests for every route that creates a food line; an end-to-end test of Close the kitchen.
- **Notes:** The kitchen's hours are open with the founder.

### K-08 · Show the allergy notice on every menu

- **Status:** todo
- **Size:** S
- **Depends on:** K-01; M3-05, M3-09, M5-01
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · The allergy notice
- **Build:** the notice from `kitchen.allergyNotice` on the room page, the room tablet, the website menu page and the menu PDF, in the guest's language.
- **Acceptance:**
  - [ ] With the module on, the notice appears on all four menus within a minute of a save.
  - [ ] The notice text is never written in the code or the seed.
- **Tests:** end-to-end tests of the four menus; a unit test that the PDF includes it.
- **Notes:** The wording, and whether PHL §1356 applies, are with the lawyer.

### K-09 · Sell a package with food: tickets at once, the price divided across its lines

- **Status:** todo
- **Size:** M
- **Depends on:** K-03, K-05; M3-02
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Food in packages; [Money rules](../spec/05-money-rules.md) rule 1
- **Build:**
  - Add a package to a room from the room tab, choosing any picks; a staff order accepted at once, drinks at the bar and food in the kitchen.
  - The package price divided across its contents by their regular prices, largest remainder, each line with its own tax category and `package_id`, grouped under the package's name on the bill.
  - The promotion checks refuse an hourly package with food.
- **Acceptance:**
  - [ ] A package's lines add up to its price to the cent, written test-first as new money cases.
  - [ ] Adding the package prints its food in the kitchen and its drinks at the bar at once.
  - [ ] An hourly package with food can't be saved.
- **Tests:** unit tests first from new `seed/money-cases.json` groups for packages with food (test prices, marked as test data); integration and end-to-end tests.
- **Notes:** When package food fires, and how a package is split for tax, are open with the founder and the accountant.

### K-10 · Tax food and report it

- **Status:** todo
- **Size:** S
- **Depends on:** K-02; M4 (check revisions), M7-13, M7-15, M7-17
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Tax; [Money rules](../spec/05-money-rules.md) rules 8 and 9
- **Build:** a `food` rate in the rule pack at the drinks rate as the cautious default; food in the Z report, the journal and the tax-quarter report by category; food in the gratuity base like any item.
- **Acceptance:**
  - [ ] A check with food taxes it once per rate and shares tax by largest remainder, written test-first as new money cases.
  - [ ] The Z report and the journal show food sales on their own line, and the reconcile script still balances to the cent.
- **Tests:** unit tests first from new money cases; the reconcile script over a night with food.
- **Notes:** The food rate is open with the accountant.

### K-11 · Prove a food night end to end

- **Status:** todo
- **Size:** S
- **Depends on:** K-01 to K-10
- **Spec:** [Kitchen and food](../spec/16-kitchen.md)
- **Build:** a Playwright run on the test kitchen menu: a guest's mixed basket, a bar tab with food, a package, a failed kitchen ticket printed at the bar, a run with Picked up, 86 and Close the kitchen, and Close the night reconciling to the cent.
- **Acceptance:**
  - [ ] The run passes from a fresh seed with the test kitchen menu.
  - [ ] Every new staff string exists in English and Spanish (`pnpm i18n:check`).
- **Tests:** the end-to-end run; `pnpm check --e2e`.
- **Notes:**
