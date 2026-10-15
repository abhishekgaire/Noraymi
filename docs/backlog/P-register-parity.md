# P · Everything Sing Sing's register does today

Oct 14, 2026 · the founder compared Sing Sing's current register (VenueTap, photos in [Sing Sing](../venues/sing-sing/venue.md) · Today's register) with ours and asked for everything it does that we don't, except Dine In tables and Quick Serve takeout, which Sing Sing doesn't use ([D131](../decisions.md)). Each new feature follows "Features are the owner's choice": a switch in Admin → Features and Set up your venue where it isn't core, refused on the server when off.

**Goal (usable when done):** a Sing Sing bartender can do on our app everything they do on the old register tonight.

**Done when:** every ticket below is done, and docs/manual-test.md has a section that walks through each one.

**Depends on:** F, W and O. **Size:** about 5 weeks (9 S, 9 M, 1 L).

**Left out on purpose:** Dine In and Quick Serve (the founder, Oct 14); a separate City tax line (New York City's 8.875% is one combined rate in the rule pack; a venue elsewhere gets its rates from its rule pack); a sale dated to a closed night (closed nights never reopen, D88; P-19 records a missed sale on tonight's date instead).

## Suggested order

1. **Every night at the bar:** P-01 to P-06.
2. **The manager's views:** P-07 to P-09, P-12, P-11.
3. **Settings:** P-10, P-13, P-14, P-15, P-19.
4. **Bigger features:** P-16, P-17, P-18.

Definition of done: see CLAUDE.md.

## Tickets

### P-01 · Print the bill before paying

- **Status:** done
- **Size:** S
- **Depends on:** M4 (Present the check), W-01
- **Spec:** [Payment flows](../spec/07-payment-flows.md) · Present the check; [Devices, printing, offline](../spec/09-devices-printing-offline.md)
- **Build:**
  - A **Print the bill** button on a room's close-out, Present the check and a bar tab, printing a new print kind `bill` on the station's receipt printer (ESC/POS and Star raster).
  - The slip: venue name, room or tab, guests, each line, room time, discounts and comps, tax, gratuity, total, deposits and payments so far, left to pay; with the cash discount on, the cash price under the total; "This is not a receipt".
  - Core (no switch). Reprinting is allowed and counted in the audit log.
- **Acceptance:**
  - [x] The bill's numbers match the check to the cent (Room 9's worked example), in English and Spanish.
  - [x] It prints on both command sets; a printer offline shows the usual print error.
  - [x] Principal and venue-wall tests for the route.
- **Notes:** `POST /v1/venues/{v}/checks/{c}/bill` (`{ locale? }`; core; `payments.take`; the bar's printer from a bar computer, the front desk's elsewhere, as receipts) writes a print job of kind `bill` (migration 0162) laid out like a receipt, so ESC/POS, Star raster, CloudPRNT and Epson Server Direct Print all print it through the receipt path. The amounts are the receipt model's (`apps/api/src/receipts/model.ts`, now with a locale and, for a check not yet presented, the totals `workOut` gets from packages/rules now); the slip is built in `apps/api/src/receipts/bill.ts`. Every print is a new `print_jobs` row, audited by its trigger with who printed it, numbered REPRINT 1, 2 and on. The button is `apps/staff/src/screens/PrintBill.tsx`, in the Present the check area of a room (before and after presenting, until paid) and on an open bar tab on the rail. Cautious defaults: the bill's language is the venue's first staff language (the route takes `locale` for either); the cash price also prints under Left to pay once part is paid (a deposit or a payment), since that's what cash would pay; for an open check with food at cash prices, room time so far counts with the non-food part. Tests: `routes/print-bill.int.test.ts` (Room 9 before and after presenting, in Spanish, both command sets, reprints and the audit log, the failed list, the cash price), `print/receipt.test.ts`, the principal and wall suites, and the e2e "Print the bill" in `e2e/staff.spec.ts`. Manual test 30.1.

### P-02 · A % or $ discount on a whole check

- **Status:** done
- **Size:** M
- **Depends on:** M4, F-03
- **Spec:** [Money rules](../spec/05-money-rules.md) · rule 9 (comps) and rule 10
- **Build:**
  - **Discount** on a check (room or tab): a percent or an amount, with a reason. Module `check_discount` (on by default, every plan).
  - Money: the discount comes off the pre-tax subtotal (room time and items), split across the lines by largest remainder so tax per category stays exact; percent rounds half up; gratuity is figured on the discounted subtotal; a cash discount applies after it. Tests first: a new `check_discount` group in `seed/money-cases.json`.
  - It counts toward the same reason-only limits as comps ($25 each, $75 a shift) and needs approval above them per the venue's approval setting. Removing it is allowed before payment. Audited.
  - It shows on the check, the bill (P-01), the receipt, the Z report, reports and the money audit.
- **Acceptance:**
  - [x] The `check_discount` cases pass and the money audit recomputes them.
  - [x] Over the limit asks for approval per the setting; the module off refuses the route.
  - [x] EN and ES; principal and venue-wall tests.
- **Notes:**
  - Tests first: six `check_discount` cases in `seed/money-cases.json` (Room 9 at 10%, $10.00 split across drinks and food, 15% half up, an amount capped beside a damage fee, after a comp, then a 4% cash discount), derived with exact fractions, run against `checkDiscount` and `checkTotals` (`packages/rules/src/check-totals.test.ts`) and through the money audit (`money-audit.test.ts`: clean as stored, a cent off caught, discount lines with no discount caught).
  - Built: `checkDiscount`/`discountLines` (`packages/rules/src/check-totals.ts`); migration 0160 adds `check_discounts` (one standing per check, forced RLS, restore wall, audited, closed-night guard) and the `discount` approval kind. `POST /checks/{c}/discount` (`{ mode: "pct", pct }` or `{ mode: "amount", amount_cents }`, a reason; module `check_discount`, action `comps.reasonOnly`) and `POST /checks/{c}/discount/remove` (`apps/api/src/rooms/discount.ts`). Each finalize writes the discount as computed `discount` lines, one per tax category, reversed and rewritten like tax and gratuity; tax bases subtract it; the gratuity is on what's left; a cash discount comes after it. The check view shows `discount`, `pending_discount` and `totals.discount_cents`; the receipt prints one "Discount · 10%" line; the guest bill a Discount row; the Z report (printed and on screen) Discounts; both exceptions lists name it with who gave and approved it; the money audit works it out again from the standing percent or amount, in total and by category. Refunds count discount lines in the gratuity base.
  - Module `check_discount`: every plan (`allowedOff`) and on by default (`inherits: "payments"`, so a venue with no row reads on); Admin → Features lists it (17 on · 4 off at West 4) and Set up your venue step 7 has its switch. Off refuses a new discount (404 `module_off`); removing one stays allowed.
  - Screens: `DiscountPanel.tsx` beside the fix panel on DeskRoom/Room phone and the bar POS (Percent or Amount, a reason with chips, "Waiting for Andy", Remove), EN and ES.
  - Cautious defaults: a discount comes off room time, drinks, food and songs only (never damage, fees, a minimum-spend top-up or a card fee), and doesn't lower the spend counted toward a minimum spend. One discount per check; a second is refused until the first is removed. It changes only while the check is open (like comps); after Present or Close it needs Reopen, after payment a refund. It counts toward the reason-only limit at what it came to when given (a percent on a running room can grow after); a removed one gives the limit back. A split by item shares it evenly like room time. The spec's rule for it is under Money rules 7 (comps and voids), the ticket's "rule 9".
  - The bill (P-01) isn't built yet; it will read the same `discount` lines.
  - Checks: `pnpm check` lint, i18n, typecheck, unit (1256) and the migration linter pass; integration 1330 passed with 4 suite files failing to start on the shared Postgres (a different four each run; each passes alone). Browser (isolated stack): the new P-02 test, the fix panel and Admin → Features (17 on · 4 off) pass; setup.staff and onboard pass (one setup test passed on its rerun alone).

### P-03 · A named bar tab without a card

- **Status:** done
- **Size:** S
- **Depends on:** M6 (New tab)
- **Spec:** [Bar POS](../spec/10-staff-screens-bar-pos.md) · New tab
- **Build:**
  - A venue setting **Open a tab without a card** (`tabs.cardRequired`, default true, so nothing changes at West 4; Sing Sing false), in Admin → Bar POS and step 7.
  - With it off, New tab takes a name alone; the tab closes with cash, the outside card machine or a reader like any tab. Close the night lists open cardless tabs first ("No card on this tab").
- **Acceptance:**
  - [x] With the setting on, a tab without a card is refused on the server.
  - [x] With it off, a named tab opens, takes orders and closes in cash.
  - [x] EN and ES; tests.
- **Notes:**
  - `tabs.cardRequired` is optional in the schema; absent reads as true (`tabCardRequired`), so West 4 and every saved venue stay card first. No migration: a cardless tab is a `tabs` row with no `payment_id`, no card and no consent (the columns were already nullable); the tab list's `cardless` is `payment_id is null and card_last4 is null`.
  - `POST /tabs { card: "none", name, label?, party_size? }` opens it at once (no reader, no hold, no consent line), or 400 `invalid_request` with reason `card_required`. `GET /tabs/consent` returns `card_required`. The opener's Quick sale drinks move onto it, as with a card. Party size is still asked in Parties mode.
  - New tab shows "Or open it without a card" (name + Open without a card) beside Read to guest ✓; the card path stays available. The rail shows "No card on this tab"; Close tab offers cash, another card and the outside card machine (the existing no-hold path, M6-12), never Close to the card.
  - Close the night lists cardless tabs first ("No card on this tab"); Charge the remaining tabs already skipped tabs with no card. The tab cut-off job now treats `no_card` as nothing to charge (before, it would have kept the night's cut-off run unfinished).
  - Step 7: once `tabs` is saved, the one switch; the first time, the switch plus the opening hold, flag amount and cut-off (the key is saved whole, every answer empty until chosen, as `pay` and `drawer` are). "Finish the payments, drawer and tab answers" replaces the old wording.
  - Sing Sing: on in `scripts/demo-sing-sing.mjs`, `docs/venues/sing-sing/venue.md` and manual-test 29 step 7 (with example tab settings) and 8.4 step 4.
  - Not done (cautious): a cardless tab with nothing on it has no Close button (as a reopened no-hold tab today); Split stays hidden on no-hold tabs.

### P-04 · Starting a room: a note, a prepaid block, a package

- **Status:** done
- **Size:** M
- **Depends on:** M2 (walk-in), D128, package sales
- **Spec:** [Money rules](../spec/05-money-rules.md) · rule 3 (room time)
- **Build:**
  - A **Note** (up to 200 characters) on the walk-in dialog and on a booking's check-in, shown on the room's tile and close-out.
  - **Time:** "Pay as you go" (today's billing, the default) or **Prepaid block**: the guests are billed at least the block (the block's minutes at the room's rate, or a package's price) even if they leave early; staying past it bills the extra minutes as today. Tests first: `prepaid_block` cases in `seed/money-cases.json`.
  - **Package** at start (when Packages & specials is on): picking one with a length sets the room's time and puts the package on the tab.
- **Acceptance:**
  - [x] The `prepaid_block` cases pass through daylight saving.
  - [x] The note shows on the board and close-out; the dialog still fits a laptop screen (D128).
  - [x] EN and ES; tests.
- **Notes:**
  - Migration 0162: `room_sessions.note` (1 to 200 characters), `prepaid_minutes` and `prepaid_cents` (both or neither), `package_id`; `packages.minutes` (15 to 720, never on an hourly package). Admin → Menu's Add a package gets **Room time included** (None, 60 to 240 min); the list says "120 min of room time".
  - Rules: `roomTime(..., { prepaid })`, `prepaidBlockCents`, `prepaidBlockBetween` in `packages/rules/src/room-time.ts`; `sessionClock` passes the block through, so the board, the room's check and close-out all bill it. 14 `prepaid_block` cases (`packages/rules/src/prepaid-block.test.ts`), including both daylight-saving nights; the audit lists the group as a stored input.
  - API: `POST /rooms/{r}/sessions` takes `note`, `time` (`pay_as_you_go` default, `prepaid`) and `package_id`; `POST /bookings/{b}/check-in` takes `note`. `GET /package-menu?at_start=1` lists the packages a room can start with; the plain list leaves them out, and `POST /checks/{c}/packages` refuses one with a length (`starts_room`). A package at the start with Packages & specials off answers 404 `module_off`; one without a length 400 `no_length`. The board's session carries `note` and `prepaid {minutes, package_name}`.
  - Screens: the note under Room (both kinds); Time chips (Pay as you go / Prepaid block) inside How long; a Package select only when a package with a length is on offer. The tile shows the note; the room panel and DeskRoom show the note and "Prepaid block · 2 h" or "{package} · prepaid 2 h". The D128 fit holds at 1366 × 768 with the package select showing (e2e "P-04 · …").
  - Cautious defaults (spec 05 rule 3 says each): the block is fixed, so a party-size change inside it bills at the new rate only from the block's end; a package's price is divided across the block (its minutes at the room's rate) and its lines by largest remainder, the block's share billing as room time; a package with a length and no lines is room time alone; at the start only packages whose lines need no choice are offered (the dialog asks none); a booking's check-in gets the note only, its length and billing unchanged; an alcohol refusal while selling the package seats nobody and is logged.

### P-05 · A sound when a room's time is up

- **Status:** todo
- **Size:** S
- **Depends on:** the board alerts, the desktop app's alarm
- **Spec:** [Devices, printing, offline](../spec/09-devices-printing-offline.md)
- **Build:**
  - The bar computer (desktop app and the staff app in a browser) plays a sound once when a room reaches Wrap up and again when its time passes, with the room's name on screen until someone taps it.
  - Setting **Sound when a room's time is up** (on by default) and its volume in Admin → Hours & prices or Devices; the guest is never sounded at.
- **Acceptance:**
  - [ ] One sound per room per step, not repeated on reload; a tap silences it.
  - [ ] The setting off plays nothing; EN and ES; tests.

### P-06 · Change a tip after paying

- **Status:** done
- **Size:** M
- **Depends on:** F-10, M4 (tips)
- **Spec:** [Payment flows](../spec/07-payment-flows.md) · Tips
- **Build:**
  - **Change tip** on a paid check for payments on the outside card machine (Sing Sing's PAX tips are adjusted on the machine; this fixes the record to match) and on a held card before it's captured.
  - A Stripe card payment already captured: refused with the reason (a captured charge can't be raised).
  - The usual tip checks ask for the manager (over 25%, over $50, over 2 hours late); after the night is closed the change posts to tonight pointing back, as late tips do. Tip ledger, Z, reports and the money audit follow. Audited.
- **Acceptance:**
  - [x] An outside-machine tip changes and the tip ledger and close-out totals match to the cent.
  - [x] A captured Stripe payment is refused with the reason; EN and ES; tests.
- **Notes:**
  - Migration 0163: `tip_changes` (from, to, posting date, `adjusts_business_date`, `credited_to`, who, when, approval; insert-only, audited, RLS forced, restore wall, closed-night guard); approval kind `tip_change`; `tip_ledger_from_payment` re-created so a change with a `tip_changes` row writes the difference on the change's date, pointing back, credited to whoever the tip was. The tip itself changes through `set_tip()` (app_rw never updates `payments.tip_cents`).
  - API (`apps/api/src/payments/tip-change.ts`): `POST /payments/{p}/tip { tip_cents }` and `GET /checks/{c}/tips`. Outside machine: the record changes; refused while `outside_card` is off (`404 module_off`). Held card waiting on its slip: typed again through Tips to enter's path (`enterSlipTip`), a pending tip review expired and replaced. Captured Stripe card: `400 captured_card`. The tip checks (`pay.tipReview`) answer `202` per the approval setting.
  - Follow-through: the reconcile (and so the money audit) takes changes posted to a later night out of the closed night's tips; tonight's Z lists the late difference under adjustments as `outside_card_tip`, and the night journal clears it through `outside_card_clearing` (rules `nightJournal`). The closed night's stored Z never changes (D88).
  - Screens: **Change tip** on each Closed tonight row in the bar POS and on a paid room check (`TipChangeSheet`); the approver sees **Tip change** with its reasons. EN and ES. Spec 07 (Outside card machine · Change tip), 04 (`tip_changes`), 08, the glossary and manual-test 30.2 updated.
  - Cautious defaults: "late" is measured from when the check was paid (payments keep no simulated time of their own), and 0 when the check isn't paid; the 25% limit is of the payment's amount; a cash tip, a payment with a refund, and an outside payment while the switch is off are refused; one pending change per payment; no new money-cases group (the tip limits are the seed's `tip_review` cases, reused).
  - Tests: `tip-change.int.test.ts` (5: list, change with ledger + X report + reconcile to the cent, unchanged / over $50 waits / waiting, captured card refused, after close posts to Sep 26 pointing back with the closed night still reconciling and the journal on the outside clearing account); rules journal unit test; e2e "P-06 · Change tip …" (isolated). The held-card path is covered by tab-slip's tests of `enterSlipTip`, not by its own test.

### P-07 · Monthly sales report

- **Status:** todo
- **Size:** S
- **Depends on:** M7 reports
- **Spec:** [Money rules](../spec/05-money-rules.md) · Close the night and reports
- **Build:** Reports → **Month**: a month picker, the month's totals (sales by category, tax, gratuity, tips, discounts and comps, refunds, cash, card, outside card machine, room hours), each night in the month, and a CSV. From closed nights only; the month in progress says so.
- **Acceptance:**
  - [ ] The month equals the sum of its nights' Z reports to the cent; EN and ES; tests.

### P-08 · Reservations by month

- **Status:** todo
- **Size:** S
- **Depends on:** M5 (Calendar)
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md) · Calendar
- **Build:** The Calendar gets a **Month** view: a month grid with each day's booking count, arrows to move months, today marked; tapping a day shows its bookings, and New booking starts on that day.
- **Acceptance:**
  - [ ] Counts match the day lists; past days can't take a new booking; EN and ES; tests.

### P-09 · Staff actions (voids, comps, discounts, no-sales by person)

- **Status:** todo
- **Size:** S
- **Depends on:** `/reports/staff-actions`
- **Spec:** [Money rules](../spec/05-money-rules.md) · Close the night and reports
- **Build:** Reports → **Staff actions** for the owner and managers: a date range, and per person the count and dollars of voids, comps, discounts (P-02), refunds, no-sales, paid-outs, over/short and punch edits, each opening its list with who approved it.
- **Acceptance:**
  - [ ] The dollars match the audit rows; staff without the permission are refused; EN and ES; tests.

### P-10 · Access person by person, and which actions ask for a PIN

- **Status:** todo
- **Size:** M
- **Depends on:** M1 roles, permissions
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md)
- **Build:**
  - Admin → Team → a person: **Can also open** the Admin sections their role can't, chosen by the owner only, never Payments, Team or Console, and Admin still needs a passkey. Audited.
  - Admin → Features → **Ask for the PIN again for**: no sale, void, comp, discount, refund, reprint a receipt, open a tab, change a tip; staff type their own PIN again before the action even when signed in. Defaults keep today's behaviour.
- **Acceptance:**
  - [ ] A granted section opens; an ungranted one is refused on the server; a manager can't grant.
  - [ ] Each ticked action asks for the PIN on the server; EN and ES; principal tests.

### P-11 · One bell for everything waiting

- **Status:** todo
- **Size:** S
- **Depends on:** alerts, approvals, messages, bar orders
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md)
- **Build:** A bell in the top bar with a count, listing what's waiting for this person (approvals, room alerts, bar orders, guest texts, printer errors), each opening its screen; marking read is per person. The menu badges stay.
- **Acceptance:**
  - [ ] The count matches the list and clears on read; works offline from the cache; EN and ES; tests.

### P-12 · Today at a glance, and who's on shift on the PIN screen

- **Status:** todo
- **Size:** S
- **Depends on:** reports (X), punches
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md)
- **Build:** For owners and managers, the top of Tonight shows **sales so far** (the X report's net), **open checks**, **rooms in use** and **on the clock**. The PIN screen shows "N on shift".
- **Acceptance:**
  - [ ] The numbers match the X report and the punches; staff without reports don't see sales; EN and ES; tests.

### P-13 · The order of the menu

- **Status:** todo
- **Size:** S
- **Depends on:** F-03
- **Spec:** [Settings and modules](../spec/03-settings-rule-packs-modules.md)
- **Build:** Admin → Features → **Menu order**: move the staff app's main menu entries up and down for the venue; each role still sees only what it may open.
- **Acceptance:**
  - [ ] The order shows for everyone at the venue and doesn't cross venues; EN and ES; tests.

### P-14 · Activity log and About

- **Status:** todo
- **Size:** S
- **Depends on:** the audit log
- **Spec:** [Security and retention](../spec/12-security-retention.md)
- **Build:** Admin → **Activity log** for the owner (managers by P-10): the venue's audit rows, newest first, filtered by person, kind and date, with personal data masked as in the exports. Admin → **About**: app and desktop versions, the venue's id, the support contact.
- **Acceptance:**
  - [ ] Only the venue's own rows; masked fields stay masked; EN and ES; venue-wall test.

### P-15 · Tax-exempt checks

- **Status:** todo
- **Size:** M
- **Depends on:** P-02
- **Spec:** [Money rules](../spec/05-money-rules.md) · rule 8 (tax)
- **Build:**
  - Module **Tax-exempt sales** (off by default). **Tax exempt** on a check needs the organization's name and its exemption certificate number (New York's form ST-119.1 for exempt organizations), and a manager's approval per the setting; sales tax is then zero on that check.
  - The Z report, reports, exports and the money audit show exempt sales and the certificate numbers. Audited.
  - Which sales may be exempt stays the accountant's question (a row in spec 14); the cautious default: the module off, and alcohol stays taxed (a setting the accountant can change).
- **Acceptance:**
  - [ ] An exempt check pays no sales tax and the Z report lists it; without a certificate number it's refused; EN and ES; tests.

### P-16 · Inventory

- **Status:** todo
- **Size:** L
- **Depends on:** menu, 86
- **Spec:** [Data model](../spec/04-data-model.md)
- **Build:**
  - Module **Inventory** (off by default). A stock count per menu item (or per variant), taken down when a line is sent, put back on a void, with **Receive**, **Count** and **Adjust** (with a reason).
  - A low-stock level per item alerts the manager; at zero the item is 86'd automatically (a setting).
  - Reports → Stock: on hand, used, received and adjusted by date. Audited.
- **Acceptance:**
  - [ ] Counts stay right through send, void and offline replay; auto-86 at zero; EN and ES; tests.

### P-17 · Kitchen screen

- **Status:** todo
- **Size:** M
- **Depends on:** K (kitchen tickets)
- **Spec:** [Kitchen and food](../spec/16-kitchen.md)
- **Build:** Module **Kitchen screen** (off by default): a paired device (kind `kitchen_display`) or a bar computer's second window shows open kitchen tickets oldest first with their times; **Done** bumps a ticket and tells the bar. Printing stays as it is and can be turned off when the screen is on.
- **Acceptance:**
  - [ ] Tickets appear within 3 seconds of being sent and clear on Done; works offline from the cache; EN and ES; tests.

### P-18 · A screen for the guest at the bar

- **Status:** todo
- **Size:** M
- **Depends on:** W-01
- **Spec:** [Devices, printing, offline](../spec/09-devices-printing-offline.md)
- **Build:** Module **Guest-facing screen** (off by default): a second monitor on a bar computer (a desktop-app window) or a paired device shows the check being rung up (lines, tax, gratuity, total, the cash price) and, when idle, the venue's name.
- **Acceptance:**
  - [ ] It follows the register within a second and never shows another check; EN and ES; tests.

### P-19 · A missed sale on tonight's date

- **Status:** todo
- **Size:** S
- **Depends on:** M7 (closed nights)
- **Spec:** [Money rules](../spec/05-money-rules.md) · rule 16
- **Build:** **Add a missed sale** for managers: a sale rung up tonight with "From the night of <date>" and a reason; it counts on tonight's date (closed nights never reopen, D88), and reports show which night it came from. Approval per the setting; audited. Replaces the old register's past-dated Manual Ticket.
- **Acceptance:**
  - [ ] It lands on tonight's Z with its earlier date shown; a closed night's totals don't change; EN and ES; tests.
