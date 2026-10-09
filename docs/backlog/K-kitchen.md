# K · Kitchen

Oct 9, 2026 · the proposed backlog for the Kitchen & food module, for Sing Sing Karaoke, Astoria, the first venue to go live ([D98](../decisions.md)), with the founder's Send to kitchen answers of Oct 9 ([D99](../decisions.md)). One ticket per Claude Code session. The [draft spec](../spec/16-kitchen.md) says how each piece works. Tests use a test-only kitchen menu marked as such, laid over the demo seed in the test helpers; the demo seed stays West 4's and gains no food, and no Sing Sing fact is invented.

**Goal (usable when done):** at a venue with the Kitchen module on, guests and staff order food like drinks, the bar accepts it, a ticket prints on the kitchen printer, and a runner carries it to the room.

**Done when:**

- A food order from a guest's phone or a room tablet prints a kitchen ticket at Accept with the guest's notes, and a mixed basket prints drinks at the bar and food in the kitchen.
- Food rung on the bar POS, a bar tab, a quick sale or a room tab waits as Not sent until Send to kitchen prints it once, with its notes, and a reminder catches food left Not sent.
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

- **Status:** done
- **Size:** S
- **Depends on:** the M1 modules and settings tickets; M3-13 (printers)
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · The Kitchen module; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Modules
- **Build:**
  - `kitchen` in the module list, needing Bar screen & tickets, in the dependency table and What each module hides.
  - The `kitchen` settings key (`allergyNotice`, `lastOrder`, `unsentWarnMin` defaulting to 5), versioned and validated like the others, and Admin → Kitchen to edit it.
  - Turning the module on is refused until a kitchen printer is paired and the allergy notice is set ("Kitchen · needs a kitchen printer and the allergy notice"); turning it off is refused while a kitchen order is open.
- **Acceptance:**
  - [x] With no kitchen printer or no notice, Admin → Features keeps Kitchen off and says what's missing.
  - [x] Turning Bar screen & tickets off lists Kitchen among what turns off with it.
  - [x] Every kitchen route answers `404 module_off` while the module is off.
  - [x] Guest food ordering follows the Ordering from the room module: with it off, the room page and tablet offer no food, and there's no separate switch.
  - [x] `unsentWarnMin` defaults to 5 and refuses a value outside 1 to 60.
  - [x] Turning Kitchen off with a kitchen order being made is refused.
- **Tests:** unit tests for the dependency rules; integration tests for the settings key and the module routes; the principal and venue-wall suites over Admin → Kitchen.
- **Notes:** Built in `packages/shared/src/modules.ts` (Kitchen & food is phase 1, needs `bar_screen`, its hides row, `kitchenMissing`), `packages/shared/src/settings.ts` (`kitchen` key, `KITCHEN_DEFAULTS`, `settingsDefaults`), `apps/api/src/kitchen/module.ts` (settings in force, kitchen printer, open kitchen orders), `apps/api/src/routes/modules.ts` (on refused with "Kitchen · needs …", `still_needs` on GET, off refused while kitchen orders are open), `apps/api/src/routes/kitchen.ts` (`GET /v1/venues/{v}/kitchen`, the first kitchen route, module-gated) and Admin → Kitchen (`apps/staff/src/screens/admin/Kitchen.tsx`, screens.md N40). Tests: `modules.test.ts`, `settings.test.ts`, `sections.test.ts`, `kitchen-module.int.test.ts`, e2e "Admin → Kitchen" and the updated Features and Console tests.
  - A venue that never saved `kitchen` reads its defaults (the settings GET answers version 0); the seed loader writes the defaults for West 4, whose numbers are unchanged. The Console still allows the module per venue: the seed keeps it not allowed at West 4 (no kitchen in its plan), and Features shows "Not in your plan" there (13 on · 3 off).
  - Admin → Kitchen lists only where the Console allows Kitchen & food (`/me` now carries `modules_allowed`), on or off, since the notice must be set before the switch turns on; the settings key saves through the core settings routes, which stay open while the module is off.
  - Cautious defaults: a kitchen printer counts only on a network protocol (CloudPRNT or Server Direct Print), not revoked or switched off; "open kitchen work" counts orders with a kitchen line that are ringing, held, accepted or ready (ready is still in the kitchen until Picked up). K-02 can switch the check to `orders.station`.
  - When turning off Bar screen & tickets takes Kitchen & food with Ordering from the room, the room-orders question is followed by "These turn off with it: …" so Kitchen is named (spec 03 updated).

### K-02 · Route items to a station, and split a basket into one order per station

- **Status:** done
- **Size:** M
- **Depends on:** K-01; M3-03, M3-04, M3-06
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Stations; [Data model](../spec/04-data-model.md) · Room orders
- **Build:**
  - Migration: `menu_items.station` limited to `bar` and `kitchen`; `orders.station` and `orders.basket_id`; `order_items.kitchen_note` (up to 200 characters), `kitchen_note_allergy`, `kitchen_sent_at`, `kitchen_sent_by` and `package_id`; row-level security unchanged and a venue-wall test.
  - Admin → Menu shows Station on each item only while the module is on, and lets a manager rename and reorder the food categories (`menu_categories` name and sort), which the bar POS's food row and the guest menu's food sections follow (D100).
  - The order pipeline splits a basket or round with lines for both stations into one order per station sharing `basket_id`; options and variants follow their item.
- **Acceptance:**
  - [x] A basket of one food item and two drinks becomes two orders, one per station, with one `basket_id`.
  - [x] An option on a food item stays on the kitchen order.
  - [x] With the module off, a `kitchen` item can't be saved or ordered.
  - [x] Renaming a food category or moving it up in Admin → Menu changes its name and place on the bar POS's food row and the room page's food sections.
- **Tests:** unit tests for the split; integration tests against Postgres with row-level security on; the migration linter.
- **Notes:** Migration `0135_kitchen_stations.sql` (stations limited to bar and kitchen; `orders.station`, `orders.basket_id`; the `order_items` kitchen columns and `package_id`). The split is `splitByStation` in `packages/shared/src/stations.ts` (with `foodCategories` and `moveCategory`), used by `insertBasket` in `packages/db/src/orders.ts` for guest orders, staff rounds and offline replays: bar order first, the round's `client_order_id` on it, one `basket_id` for all (single-station orders get a basket of their own too). Tests: `stations.test.ts`, `import.test.ts` (Sing Sing's import files: every line bar or kitchen), `kitchen-stations.int.test.ts` (split, option, module off, rename and reorder, venue B can't see a basket), e2e "Admin → Menu with Kitchen on".
  - The guest order routes now also answer `orders` (the whole basket, bar first) beside `order`; the guest menu marks each category `food`. The two cards ("Drinks", "Food") are K-04's, the bar POS food row K-05's; both read the menu order this ticket saves.
  - With the module off, kitchen items are hidden from the staff menu, the room page and the website (Admin → Menu still lists them), refused on order (`kitchen_off`) and can't be saved to the kitchen. The menu importer still loads kitchen lines while the module is off (a venue imports before it pairs the printer), refusing any station but bar or kitchen.
  - Left for later: a staff round's kitchen order is accepted and prints at once on a room check, as drinks do (the M6-29 rule applies on a bar tab); K-05 makes staff food wait for Send to kitchen. `devices.station` limits are K-03's. The open-kitchen-work check from K-01 still reads `order_items.station`.

### K-03 · Print kitchen tickets, with failures, reprints at the bar and AFTER OUTAGE

- **Status:** done
- **Size:** M
- **Depends on:** K-02; M3-13 (network printers), M8 (offline replay)
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Kitchen tickets; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Tickets and Outages
- **Build:**
  - Accept on a guest's kitchen order, and Send to kitchen (K-05), create a print job for the kitchen printer; the kitchen ticket layout ("KITCHEN", the room or tab, the time, who accepted or sent it, lines with options and notes, a note marked as an allergy boxed and bold under its line, no prices).
  - Pairing refuses a USB printer for the kitchen station.
  - A failed kitchen job shows "Kitchen ticket didn't print · Reprint" on the bar screens and pushes to the manager on duty; Reprint offers the kitchen printer or Print at the bar instead, numbering REPRINT 2, 3 and so on.
  - Accepting a replayed food order prints "AFTER OUTAGE · check with the kitchen before making".
- **Acceptance:**
  - [x] Accepting a mixed basket prints one bar ticket and one kitchen ticket on the fake printers, and the kitchen ticket shows each line's note, an allergy note boxed and bold, and no prices.
  - [x] A kitchen job unconfirmed after three polls raises `print_job.failed`, shows on the bar POS and bar orders screen, and reaches the manager's phone.
  - [x] Print at the bar instead prints the same ticket on the bar printer as REPRINT 2.
  - [x] Reprint prints a copy stamped REPRINT with its count, and adds nothing to the check and marks nothing sent again.
  - [x] A replayed food order prints with AFTER OUTAGE.
- **Tests:** integration tests with the fake CloudPRNT printer; an end-to-end test of the failure and reprint; English and Spanish strings.
- **Notes:** The printer model is an open question; built against the fake CloudPRNT printer.
  - Accept on a kitchen order prints a kitchen job (`kitchenPayload` in `apps/api/src/orders/pipeline.ts`): food always prints in the kitchen, whatever `pos.printBarDrinkTickets` says (K-05 makes staff food wait for Send to kitchen instead). Lines carry `kitchen_note` and `kitchen_note_allergy` (`packages/db/src/orders.ts` now reads and writes them; K-04 fills them from the guest). The layout is `kitchenLines` in `apps/api/src/print/ticket.ts`: KITCHEN, the room or "Bar · tab", the time, Accepted by (or Sent by, for K-05's `sent_by`/`sent_at`), lines with options and notes, the allergy note in capitals inside a `*` box, no prices and no ID line. Bold: Star Document Markup for CloudPRNT (offered first, plain text still served when a printer asks for it), `em` on Epson, ESC E on USB; `[` in a note is escaped so it can't become a markup command.
  - Migration `0136_kitchen_printers.sql`: a device with station kitchen must be CloudPRNT or Server Direct Print; `POST /printers` refuses a kitchen USB printer with its own message. K-01's test that inserted a USB kitchen printer now expects the refusal.
  - Failure: the print watch and a printer's error report (out of paper, cover open) both push "Room 3 · Kitchen ticket didn't print · Reprint" to the manager on duty (`kitchen.push.ticketFailed`, once per job). The failed list and the board alert carry `kitchen`. Reprint takes `{ at: "bar" }` for Print at the bar instead; without it a kitchen ticket goes back to the kitchen even after a bar copy. The bar POS (`/bar`) gained a strip of tickets that didn't print (it had none before), shared with the bar orders screen and the board (`apps/staff/src/screens/FailedTicket.tsx`).
  - AFTER OUTAGE prints on a replayed (source offline) food order's kitchen ticket. Cautious default as a setting: `kitchen.afterOutage` (optional, absent reads as on; checkbox in Admin → Kitchen); spec 16 and open questions updated.
  - Allergy notes live only on the order line and the print job's payload, which the retention sweep blanks on its own schedule, so the note is never kept longer than the order; no receipt, text or guest record reads them.
  - Tests: `print/kitchen-ticket.test.ts`, `routes/kitchen-tickets.int.test.ts`, e2e "Kitchen ticket didn't print" (isolated stack).

### K-04 · Order food from the room page and the room tablet, with the allergy note

- **Status:** done
- **Size:** M
- **Depends on:** K-02, K-03; M3-09, M3-11, M3-12
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Ordering food
- **Build:**
  - Food on the room page and tablet under a "Food" heading, each of the menu's food categories (Admin → Menu's names and order) its own section, only while Ordering from the room is on; an optional note on each food line ("Allergies or notes for the kitchen", draft wording flagged for the lawyer) with "This is an allergy"; two order cards, "Drinks" and "Food", in the existing guest words.
  - Same again includes food.
  - After 4 AM, a food order keeps ringing while unaccepted alcohol is cancelled.
- **Acceptance:**
  - [x] A guest's mixed basket shows as two cards that each move through the guest words.
  - [x] The room page and the room tablet show a "Food" heading with each food category as its own section, in Admin → Menu's order; renaming or reordering a category there changes them.
  - [x] Accept prints the food in the kitchen at once with each line's note, an allergy note boxed, and no Send to kitchen step.
  - [x] The guest can cancel the food card while it's ringing, and nothing is charged.
  - [x] At 4:00 AM on the simulated clock, the drinks card is cancelled as `alcohol_closed` and the food card keeps ringing.
  - [x] A food-only order shows no ID status.
- **Tests:** end-to-end tests from a fresh seed with the test kitchen menu; the accessibility checks on the room page and tablet.
- **Notes:** The allergy field's wording and the note's retention are open with the lawyer: built with the draft words ("Allergies or notes for the kitchen", "This is an allergy") and the note kept with the order (order_items), never on a check line, a text or the guest's record (tested).
  - API: the guest order line takes `kitchen_note` (up to 200 characters) and `kitchen_note_allergy`; a note on a drink is refused (`kitchen_note_not_food`), and "This is an allergy" counts only with a note. The guest order view now carries `station`. Same again copies food without its notes. The 4 AM stop already cancelled only alcohol orders, so the split food order keeps ringing (tested).
  - Room page and tablet (`apps/guest/app/room/room.tsx`, which the tablet shares): drink categories stay under Menu; food categories go under a Food heading in the menu's order; each food line in the basket has the note field and the allergy checkbox; each order card is titled Drinks or Food while the menu has food (West 4's page is unchanged). Spanish strings are in the catalog, as for the rest of the room page, which still renders English.
  - Bar orders: a food order shows no ID status, and its card shows each line's note ("ALLERGY: …" for an allergy).
  - Left for later: the "Kitchen" chip on the bar's ringing cards (spec 16 · At the bar) isn't in any K ticket's Build; the allergy notice on the menus is K-08.
  - Tests: `routes/kitchen-guest.int.test.ts`; e2e "food on the room page and tablet" (guest.spec.ts) and the food accessibility check (a11y-guest.spec.ts), both with the test kitchen menu in `e2e/kitchen.ts`, which puts the module back after.

### K-05 · Add food from the bar POS, bar tabs, quick sale and room tabs, and Send to kitchen

- **Status:** todo
- **Size:** M
- **Depends on:** K-03; M3-07, M6-02, M6-03, M6-05, M6-15
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Ordering food; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · rule 2 and Changing a sent drink
- **Build:**
  - A Food section after the ten fixed sections, only while the module is on, so no drink moves. Tapping Food opens a second row of the menu's own food categories (Admin → Menu's names and order); a category shows only its items; search covers the whole menu. An item with choices opens them on tap (D100).
  - Food goes on the tab or check exactly when a drink would (a room tab's staff order at once; a bar tab's or quick sale's round at Send, or at Send to kitchen if that comes first, through the hold-raise check), and reads "Not sent".
  - "Send to kitchen (N)" at the bottom of the bar POS and the room tab on desktop and phone, active while unsent food exists; its confirmation lists only the unsent food lines, each with a note (up to 200 characters) and "This is an allergy"; a quick sale's confirmation asks for a name or label first.
  - `POST /checks/{c}/kitchen-sends` (idempotency key) marks the lines `kitchen_sent_at` and `kitchen_sent_by` and creates one kitchen print job in one transaction, refusing lines already sent; the lines then read "Sent · 11:42".
  - Unsent food removed with no reason or approval (logged); sent food only through the fix panel's void.
  - The Not sent reminder: "N food items not sent to the kitchen" on the tab, sale or check after `kitchen.unsentWarnMin`, and the same warning before Close, Send & close or payment, with Send to kitchen beside it.
  - English and Spanish strings for every new word.
- **Acceptance:**
  - [ ] Turning the module on adds the Food section and leaves every drink in its slot.
  - [ ] Tapping Food shows a row of the food categories from the test kitchen menu, in Admin → Menu's order; tapping one shows only its items; renaming or moving a category in Admin → Menu changes the row.
  - [ ] Searching "fries" from any section finds French Fries.
  - [ ] Tapping an item with a required choice (a sauce) opens its choices, and it can't go on the tab until one is picked; an optional choice (Make it a meal +$5.00) can be skipped.
  - [ ] Food added to Jess P.'s tab reads "Not sent", is on the tab, and prints nothing until Send to kitchen.
  - [ ] "Send to kitchen (N)" is active only while unsent food exists, and N counts the unsent food items.
  - [ ] The confirmation lists only the unsent food lines; a note on each prints under its line, and a note marked as an allergy prints boxed and bold.
  - [ ] Send prints one kitchen ticket reading "Bar · Jess P." with the items, options and notes, and the lines then read "Sent · 11:42" (simulated clock).
  - [ ] A second Send to kitchen lists only food added since, and sending the same lines twice (two screens at once, or a retried request) prints one ticket.
  - [ ] A quick sale's Send to kitchen asks for a name, and the ticket reads "Bar · Seat 3".
  - [ ] Unsent food is removed with no reason or approval; sent food can't be removed except by a void, which follows the reason-only limit and asks a manager above it.
  - [ ] Reprint on a sent ticket prints a copy stamped "REPRINT 2" and changes nothing on the check.
  - [ ] Food left Not sent for 5 minutes on the simulated clock shows "1 food item not sent to the kitchen" on the tab, and closing or paying the tab shows the same warning first; with `unsentWarnMin` set to 10 it shows at 10.
  - [ ] Adding food from Room 9's tab on a phone puts it on the check at once as Not sent, and Send to kitchen prints "Room 9" in the kitchen.
  - [ ] Drinks rung with the food on a bar tab print no bar ticket while "Print tickets for drinks rung at the bar" is off (M6-29).
- **Tests:** unit tests for the unsent count and the reminder's timing on the simulated clock; integration tests for the send route (no double send, idempotency, every principal, the venue wall); end-to-end tests on the bar POS and the staff phone; English and Spanish strings.
- **Notes:** Bar food delivery was answered by the founder on Oct 9: a server takes the food to the guest by the name on the ticket, with no run in the app. Paying with food still Not sent is allowed after the warning; the warning only reminds.

### K-06 · Run food: In the kitchen and Picked up on the runners' phones

- **Status:** todo
- **Size:** M
- **Depends on:** K-03; M3-15, M3-18
- **Spec:** [Kitchen and food](../spec/16-kitchen.md) · Runners and delivery
- **Build:**
  - Kitchen orders for rooms show "In the kitchen · ticket printed · age" on the bar orders screen and on Runs once their ticket prints (at Accept for a guest's order, at Send to kitchen for staff-rung food), with no Ready button at the bar; bar-tab and quick-sale food has no run.
  - `POST /orders/{o}/pick-up` records Ready and the claim in one transaction, writing both events.
  - Returns and Remake as for drinks; a remake prints a kitchen ticket marked REMAKE.
- **Acceptance:**
  - [ ] Picked up moves an accepted food order to "On its way · Andy", and Delivered charges nothing.
  - [ ] Picked up on an order that isn't accepted, or on staff-rung food that's still Not sent, is refused.
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
  - Add a package to a room from the room tab, choosing any picks; a staff order accepted at once, its drinks printed at the bar at once and its food Not sent until Send to kitchen (K-05).
  - The package price divided across its contents by their regular prices, largest remainder, each line with its own tax category and `package_id`, grouped under the package's name on the bill.
  - The promotion checks refuse an hourly package with food.
- **Acceptance:**
  - [ ] A package's lines add up to its price to the cent, written test-first as new money cases.
  - [ ] Adding the package prints its drinks at the bar at once, and its food reads Not sent until Send to kitchen prints it in the kitchen.
  - [ ] An hourly package with food can't be saved.
- **Tests:** unit tests first from new `seed/money-cases.json` groups for packages with food (test prices, marked as test data); integration and end-to-end tests.
- **Notes:** When package food fires, and how a package is split for tax, are open with the founder and the accountant; until then package food follows Send to kitchen (D99).

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
- **Build:** a Playwright run on the test kitchen menu: a guest's mixed basket, a bar tab with food sent with Send to kitchen (an allergy note, a second send of new food only, the Not sent reminder), a package, a failed kitchen ticket printed at the bar, a run with Picked up, 86 and Close the kitchen, and Close the night reconciling to the cent.
- **Acceptance:**
  - [ ] The run passes from a fresh seed with the test kitchen menu.
  - [ ] Every new staff string exists in English and Spanish (`pnpm i18n:check`).
- **Tests:** the end-to-end run; `pnpm check --e2e`.
- **Notes:**
