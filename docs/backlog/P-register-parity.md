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

- **Status:** done
- **Size:** S
- **Depends on:** the board alerts, the desktop app's alarm
- **Spec:** [Devices, printing, offline](../spec/09-devices-printing-offline.md)
- **Build:**
  - The bar computer (desktop app and the staff app in a browser) plays a sound once when a room reaches Wrap up and again when its time passes, with the room's name on screen until someone taps it.
  - Setting **Sound when a room's time is up** (on by default) and its volume in Admin → Hours & prices or Devices; the guest is never sounded at.
- **Acceptance:**
  - [x] One sound per room per step, not repeated on reload; a tap silences it.
  - [x] The setting off plays nothing; EN and ES; tests.
- **Notes:**
  - The steps are the tile's colors from `GET /board`: amber (`tone: "amber"`, the `alerts.roomEndingMin` warning, which is Wrap up when someone is next) is "Wrap up", red (Staying or Needed now) is "its time is up". A room already red when first seen sounds once, not for both steps. One sound plays for however many rooms reach a step on the same read.
  - `apps/staff/src/room-sound.tsx` (`RoomSoundLoop`, mounted beside `ChimeLoop`) runs on a paired bar or front-desk computer in the desktop app **and** in a browser, signed in or locked, reading the board as the device every 15 seconds (`shared_device` was already allowed). What it played and what waits for a tap are kept in `localStorage` (`west4.roomSound`) per session id and step, so a reload neither replays nor loses the names; a closed-out session is forgotten. The names sit in a strip above the screen, in the page's flow: a floating box first tried covered Take cash in the front-desk e2e, so it never floats over a button. A tap on a room's name clears it and stops the sound. Room tablets, phones that aren't paired screens, and the guest web never run it.
  - Settings: `alerts.roomSound` (absent reads as on, `roomSoundOn`) and `alerts.roomSoundVolume` (0 to 100, absent reads as 50, `roomSoundVolume`), both optional so saved venues need no migration. The board carries them as `room_sound: { on, volume }`. Off: nothing plays or shows, and the steps reached meanwhile count as heard, so switching it back on plays no backlog.
  - Where the setting lives: Admin → **Alerts & rules**, beside "Warn this many minutes before a room's booked end", because the `alerts` key already holds the minute the tile turns amber (the ticket offered Hours & prices or Devices; neither holds that minute). A switch, a volume slider and **Play it**.
  - Cautious defaults: on, at volume 50 (no venue fact; the owner sets it). A browser may hold the sound until someone has touched the page since it loaded (autoplay rules); the names still show. The desktop app plays it as it plays the order chime (Web Audio, no window throttling); no change to `apps/desktop`.
  - Tests: `room-sound.test.ts` (steps, reload, tap, new session, off), `settings.test.ts` (schema and defaults), `board.int.test.ts` (`room_sound` follows the saved setting), `e2e/room-sound.staff.spec.ts` (a paired bar computer at 10:41 PM: one sound for Rooms 3, 7 and 10, a tap clears, a reload plays nothing, off shows nothing). Spec 09 and spec 03 updated; manual-test 19.9 walks it.

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
  - Screens: **Change tip** on each Closed tonight row in the bar POS and on a paid room check (`TipChangeSheet`); the approver sees **Tip change** with its reasons. EN and ES. Spec 07 (Outside card machine · Change tip), 04 (`tip_changes`), 08, the glossary and manual-test 30.6 updated.
  - Cautious defaults: "late" is measured from when the check was paid (payments keep no simulated time of their own), and 0 when the check isn't paid; the 25% limit is of the payment's amount; a cash tip, a payment with a refund, and an outside payment while the switch is off are refused; one pending change per payment; no new money-cases group (the tip limits are the seed's `tip_review` cases, reused).
  - Tests: `tip-change.int.test.ts` (5: list, change with ledger + X report + reconcile to the cent, unchanged / over $50 waits / waiting, captured card refused, after close posts to Sep 26 pointing back with the closed night still reconciling and the journal on the outside clearing account); rules journal unit test; e2e "P-06 · Change tip …" (isolated). The held-card path is covered by tab-slip's tests of `enterSlipTip`, not by its own test.

### P-07 · Monthly sales report

- **Status:** done
- **Size:** S
- **Depends on:** M7 reports
- **Spec:** [Money rules](../spec/05-money-rules.md) · Close the night and reports
- **Build:** Reports → **Month**: a month picker, the month's totals (sales by category, tax, gratuity, tips, discounts and comps, refunds, cash, card, outside card machine, room hours), each night in the month, and a CSV. From closed nights only; the month in progress says so.
- **Acceptance:**
  - [x] The month equals the sum of its nights' Z reports to the cent; EN and ES; tests.
- **Notes:**
  - `GET /reports/month?month=YYYY-MM` (`apps/api/src/routes/month-report.ts`, figures in `apps/api/src/nights/month.ts`) reads each closed night's Z report as stored at its close (`night_closes.totals.report`) and sums it figure by figure, so the month equals its Z reports by construction; no migration. Staff: a Month card on Reports (`ReportsMonth.tsx`) with ‹ › and a month picker. Tests: `month.test.ts`, `month-report.int.test.ts` (a real Friday close plus a stored Sep 4 Z report), the P-07 e2e in `staff.spec.ts`; manual test 30.7; spec 05 rule 16 and spec 08 · Reports and exports.
  - Cautious defaults: "tips" are the Z report's card, cash and outside-machine tips (the gratuity has its own line); "card" is tap, card on file and online amounts before tips; refunds show both the sales side (`refunds_cents`) and the money returned to guests; room hours aren't on the Z report, so they're each closed night's billed (unpaused) room-session segment minutes, practice left out, an open segment ending with its session; the month in progress is any month not yet over (this one and later); past nights with sales or payments that weren't closed are named under "Not closed, so not counted" and never counted; the CSV asks for the passkey again like every export; an older Z report without a figure counts it as zero.

### P-08 · Reservations by month

- **Status:** done
- **Size:** S
- **Depends on:** M5 (Calendar)
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md) · Calendar
- **Build:** The Calendar gets a **Month** view: a month grid with each day's booking count, arrows to move months, today marked; tapping a day shows its bookings, and New booking starts on that day.
- **Acceptance:**
  - [x] Counts match the day lists; past days can't take a new booking; EN and ES; tests.
- **Notes:**
  - `GET /bookings/days` takes `from=YYYY-MM-DD` (default tonight; a bad date answers 400) so the Month view asks for a whole month, past or ahead; `tonight` still answers the venue's business date. Same counting as before (pending, confirmed, checked in, completed), the same statuses the day list shows. No migration, no new route. Spec 08 · Bookings names it.
  - Staff (`Calendar.tsx`, `desk.css`): a Days · Month switch in the Calendar's header; Month is a Sunday-first grid of 44 px+ day buttons with the count (nothing on an empty day, the striped look on a closed one), ‹ › for the months, tonight outlined with `aria-current="date"`. Tapping a day opens its list beside the grid, and New booking there books that business date. A past day hides New booking and Block this date and says why; the API already refuses a past time (`reason: "past"`).
  - Cautious defaults: weeks start on Sunday (US venues); the Days view stays the default each time the Calendar opens.
  - Tests: `calendar.int.test.ts` (September's counts equal each day's list, a past day refused, bad `from` refused), the P-08 e2e in `staff.spec.ts` (phone size, EN and ES); manual test 30.8.

### P-09 · Staff actions (voids, comps, discounts, no-sales by person)

- **Status:** done
- **Size:** S
- **Depends on:** `/reports/staff-actions`
- **Spec:** [Money rules](../spec/05-money-rules.md) · Close the night and reports
- **Build:** Reports → **Staff actions** for the owner and managers: a date range, and per person the count and dollars of voids, comps, discounts (P-02), refunds, no-sales, paid-outs, over/short and punch edits, each opening its list with who approved it.
- **Acceptance:**
  - [x] The dollars match the audit rows; staff without the permission are refused; EN and ES; tests.
- **Notes:**
  - `GET /reports/staff-actions` now takes `?from=&to=` (or `?date=`, tonight when left out) and answers per person (by user, so two people with one name stay apart) each kind's count and cents and `entries`, one per action with when, its business date, where, what, why, the amount and who approved it. The rows come from `apps/api/src/nights/staff-actions.ts` (`staffActionRows`, grouped by `groupStaffActions`); each person's dollars are the sum of their rows, which are the actions' own rows as the audit log recorded them. No migration. Staff: a **Staff actions** card on Reports (`ReportsStaffActions.tsx`) with From and To, a 44 px button per kind opening its rows. Tests: `staff-actions.test.ts` (unit), `staff-actions-report.int.test.ts` (each kind, the audit log compared person by person, the same rows as app_rw, ranges, a bartender refused), the P-09 e2e in `staff.spec.ts`; manual test 30.9; spec 05 rule 16 and spec 08 · Reports and exports.
  - Cautious defaults: a range is 93 days at most (the reports' 5-second limit), and backwards is refused; amounts are signed as stored (comps, voids and discounts negative; the screen shows them as positive dollars, over/short with its sign); discounts count only when still standing on the check, at what came off it (its discount lines, or what it counted when given before any); refunds go to who asked for them (not failed or canceled; an automatic refund has nobody and isn't listed) and replace the old `refund_asked` and `refund_approved` pair; over/short lists only drawers counted over or short, not exactly, by who counted them; a punch edit belongs to who edited it, on the punch's own business date (no longer matched through a shift, so a clock-in moved earlier still counts), naming whose punch it was; no-sales and paid-outs from a staff bank count too (before only drawers'); cut-offs stay in the report (the old route had them) without dollars; "who approved it" is the row's own approver, or "no approval" when it was within the person's reason-only limit; no CSV (the ticket asks for none). Permission is the reports' own: owners and managers (`admin.access`); per-person access is P-10's.

### P-10 · Access person by person, and which actions ask for a PIN

- **Status:** done
- **Size:** M
- **Depends on:** M1 roles, permissions
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md)
- **Build:**
  - Admin → Team → a person: **Can also open** the Admin sections their role can't, chosen by the owner only, never Payments, Team or Console, and Admin still needs a passkey. Audited.
  - Admin → Features → **Ask for the PIN again for**: no sale, void, comp, discount, refund, reprint a receipt, open a tab, change a tip; staff type their own PIN again before the action even when signed in. Defaults keep today's behaviour.
- **Acceptance:**
  - [x] A granted section opens; an ungranted one is refused on the server; a manager can't grant.
  - [x] Each ticked action asks for the PIN on the server; EN and ES; principal tests.
- **Notes:**
  - Can also open: migration 0165 (`admin_section_grants`: one row per grant, taken back by stamping `revoked_at`/`revoked_by`, app_rw never deletes; RLS forced, venue wall, audited). `GET /admin-sections` and `PUT /team/{m}/admin-sections` (`apps/api/src/routes/admin-sections.ts`), owner only, the passkey again (step-up). Each Admin route names its section (`section` in the route registry); `apps/api/src/http/conventions.ts` lets a passkey session with a live grant for that section pass where the route says owner or manager, and its `admin.access` role check; a settings key opens only for the section that saves it (`settingsKeySections`); the rule-pack notice reads for any grant. `/auth/me` lists `admin_sections`; the staff menu, phone tabs and the Admin list show the granted sections. Team: a **Can also open** column (`CanAlsoOpen.tsx`). The P-09 staff-actions report, P-12's glance, Reports and Close the night still follow the role only (tested).
  - A grant lets its person sign in by email with a passkey or an authenticator app: `auth_user_by_email` now also finds an active membership with a live grant, and a trigger turns `mfa_required` on at the first grant (as for managers). Without this a bartender could never reach Admin, which needs a passkey (D132).
  - Ask for the PIN again: the `pinAgain` settings key (`{ actions }`, owner only like `approvals`; a manager reads it), unsaved = `["no_sale"]`, which is what asked before. Routes name their action (`pinAgain` in the registry): comp and void on a sent line, comp minutes on a room, the check discount, refunds, a receipt printed again for a check that printed one or a receipt job reprinted, opening a tab, changing a tip (P-06), no-sale. In a PIN or badge session a ticked action answers `403 pin_again_required` (`details.action`) before any work or Idempotency-Key, until the person's own PIN comes as `X-PIN-Again` (no-sale also takes its old body `pin`), checked by `checkPinAgain` with the PIN lockouts. The staff app asks in one **Your PIN again** dialog (`layout/PinAgainDialog.tsx`) and sends the same call again; a wrong PIN asks again, Cancel leaves it undone. Admin → Features → Choices: **Ask for the PIN again for** (`PinAgainChoices.tsx`). The drawer panel shows no-sale's PIN field only while no-sale is ticked (`me.no_sale_pin`).
  - Cautious defaults: grantable sections are Menu, Hours & prices, Rooms, Cash drawers, Alerts & rules, Licenses and Bar mode only; sections whose pages hold more than their name (Venue, Features, Bar POS's limits, Texts' guest erasure, Safety's incident log, Devices' pairing, Card fee, Disputes, Deposits, Phone, Website, Connections, Spam protection, Kitchen, Set up your venue) can't be given; owners and managers get no grants (their role already opens them all). Passkey and authenticator sessions aren't asked for the PIN again (stronger already); cash counts and tip-outs still always ask in PIN and badge sessions (not on the list). The list is the owner's alone. A quick sale's "back to the sale" (an unpaid sale undone) isn't a void here. The PIN gate's cache is 3 seconds per API container, like the role table's. The sign-in screen's hint "Refunds, cash counts and no-sale ask for the PIN again; Admin needs a passkey" is a fixed glossary sentence and doesn't follow the owner's list (left as is).
  - Tests: `admin-sections.int.test.ts` (real passkey sign-ins: a grant opens Licenses read and write, the login works, other sections, Team, settings, reports and the glance refused, a manager can't grant, never Payments/Team/Console, venue B's person not found, audit rows, app_rw adds and stamps but can't delete, venue B can't see it), `pin-again.int.test.ts` (defaults, owner-only list, wrong PIN writes nothing, same key then succeeds, badge asked, passkey not, every route that names an action as PIN, badge and passkey sessions from the registry, receipt reprints, unticked, a grant never opens Admin to a PIN or badge session), unit tests in shared and the staff navigation and sections, the drawer no-sale test now expects `pin_again_required`, two P-10 e2e tests in `staff.spec.ts`; manual test 30.10. Spec 02 (Roles, Can also open, Ask for the PIN again, Badges), spec 03 (`pinAgain`), spec 08 (routes, error), glossary, screens.md (AdminDesk 8a), D132.

### P-11 · One bell for everything waiting

- **Status:** done
- **Size:** S
- **Depends on:** alerts, approvals, messages, bar orders
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md)
- **Build:** A bell in the top bar with a count, listing what's waiting for this person (approvals, room alerts, bar orders, guest texts, printer errors), each opening its screen; marking read is per person. The menu badges stay.
- **Acceptance:**
  - [x] The count matches the list and clears on read; works offline from the cache; EN and ES; tests.
- **Notes:** Module `bell` (every plan, on by default: `inherits: "admin"`, `allowedOff`; Admin → Features lists it, 18 on · 4 off at West 4, and Set up your venue's step 9 has its switch). The bell sits in the top bar (`apps/staff/src/layout/Bell.tsx`, the list in `layout/bell-items.ts`); it builds the list from the reads the screens already make, each only where the menu and badges show it (approvals routed to the person with `approvals.decide`; the board's alerts with Rooms on and `guests.checkin`; ringing and held orders where Bar orders shows; unread texts with Guest texts on and `texts.send`; failed tickets with `pos.use`), so each source keeps its own module and role checks on the server. What the API keeps is only which keys each person read: `bell_reads` (migration 0164; RLS forced, app_rw select and insert only), `GET` and `POST /v1/venues/{v}/bell/reads`, refused with `404 module_off` while the bell is off. The count is the list's unread lines; tapping a line reads it and opens its screen, **Mark all read** reads the rest. Refetches follow events, settled 1.5 s, and every 30 s. Cautious defaults: the bell is "Bell" / "Campana", not "Waiting for you" (that's the bar orders column, spec 10's one word, one meaning); the board's near-end, 21+ and clear-out lines are notices and stay off the bell, and its order and ticket lines come in as bar orders and printer errors instead; a new text in a thread already read counts again (the key carries the last inbound time); the offline copy is per venue and per person in the browser's storage and holds no guest's name or words (the lines say "A guest's text · 2 unread", "Room 9's order is ringing"), reads made offline are sent when the API answers; reads are kept insert-only (app_rw has no delete) and read back for 72 hours. Spec 10 rule 14, spec 03, 04 and 08, the glossary (Bell) and manual-test 30.11 updated. Tests: `apps/staff/src/layout/bell-items.test.ts` (order, paths, count and read, a new text rings again, EN and ES, the offline copy per person), `apps/api/src/routes/bell.int.test.ts` (per person, once per key, 72 hours, module off, app_rw behind the venue wall), the principal and wall suites, and the e2e "P-11 · one bell" at the end of `e2e/staff.spec.ts` (count = list, 44 px, opening a line, Mark all read, kept after a reload, offline from the cache in Spanish, off hides it).

### P-12 · Today at a glance, and who's on shift on the PIN screen

- **Status:** done
- **Size:** S
- **Depends on:** reports (X), punches
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md)
- **Build:** For owners and managers, the top of Tonight shows **sales so far** (the X report's net), **open checks**, **rooms in use** and **on the clock**. The PIN screen shows "N on shift".
- **Acceptance:**
  - [x] The numbers match the X report and the punches; staff without reports don't see sales; EN and ES; tests.
- **Notes:**
  - `GET /v1/venues/{v}/glance` (`apps/api/src/routes/glance.ts`): for tonight's posting date, `sales_cents` (the running X report's `sales.net_cents`, from the same `nightReport`), `open_checks`, `rooms_in_use` and `on_the_clock`. Owners and managers only (any session); bartenders, the front desk and runners get 403. `GET /team/tiles` gains `on_shift` for the sign-in screen's "N on shift". No migration. Spec 10 · Today at a glance, spec 08 · Board and sessions.
  - Staff: `Glance.tsx` at the top of Rooms (`Tonight.tsx`) for owners and managers, desktop and phone (two by two at phone size), with loading and error states; refreshes every minute and 3 s after a room, check, tab, payment, shift or accepted-order event. "N on shift" / "N en turno" beside the venue's name on a shared computer's sign-in screen.
  - Cautious defaults: Sales so far shows only to someone who could open the X report itself, a role with `reports.view` in a passkey or authenticator session, so a manager signed in by PIN or badge on a shared screen sees the other three boxes but no sales; open checks are rooms in use plus open bar tabs (open or tipping), the same two Close the night lists, quick sales being paid at once; practice (training) rooms and tabs aren't counted, as the X report leaves them out; On the clock and "N on shift" drop out while Team, time clock & tips is off, and count every open shift (on break included).
  - Tests: `glance.int.test.ts` (equals the X report's net and the database's counts, the board's in-use and the tiles' `on_shift`; the same read as app_rw; a clock-out moves both; no sales in a PIN session or with Reports off for the role; bartender and front desk refused; Team off), the two P-12 e2e tests in `staff.spec.ts` (1280, 390, ES; the bar computer's "3 on shift", Andy by PIN without sales, Diego without a glance); manual test 30.12.

### P-13 · The order of the menu

- **Status:** done
- **Size:** S
- **Depends on:** F-03
- **Spec:** [Settings and modules](../spec/03-settings-rule-packs-modules.md)
- **Build:** Admin → Features → **Menu order**: move the staff app's main menu entries up and down for the venue; each role still sees only what it may open.
- **Acceptance:**
  - [x] The order shows for everyone at the venue and doesn't cross venues; EN and ES; tests.
- **Notes:**
  - "Menu" here is the staff app's side menu (spec 10 rule 1), not the drinks and food menu: the item menu already has its own order (the `sort` on each section and item, set in Admin → Menu). No migration: a new settings key `menuOrder` (`{ order: StaffMenuId[] }`, `packages/shared/src/settings.ts`, default `{ order: [] }` = the app's order), saved with the existing `PUT /v1/venues/{v}/settings/menuOrder` (owners and managers, `admin.access`; unknown ids, Lock or an id twice are 400). `GET /v1/auth/me` hands each membership its venue's `menu_order` (read as app_rw inside that venue's wall), so everyone at the venue gets it, the front desk and bartenders by PIN too; `settings.changed` refreshes the session, so open screens follow at once. `inMenuOrder` places the entries the person already has (`visibleMenu`), so the order never shows an entry a role or a switched-off module hides.
  - Staff: `apps/staff/src/screens/admin/MenuOrder.tsx` below Choices in Admin → Features: the twelve entries with ↑ and ↓ (44 px), **Save order**, **Use the app's order**, "Not saved yet" and "Saved · everyone's menu follows it now", loading and can't-load (with Try again) states; an entry hidden by a switched-off feature is listed and marked so its place is kept. The shell (`layout/Shell.tsx`) orders the side menu by it.
  - Cautious defaults: Lock isn't movable and stays last; the phone's bottom tabs keep each role's own order (Pin note 4: each role's portal), only the side menu (desktop and the phone's drawer) follows; Set up your venue doesn't show it (the app's order until the owner moves something); managers can save it like the other Features choices (P-10 can narrow that); the app's own order saves as an empty list so an entry added to the app later takes its own place.
  - Tests: `apps/staff/src/navigation.test.ts` (the shared ids are the menu's, listed first then the rest, Lock last, a role's hidden entries stay hidden, the schema refuses Lock, repeats and unknown ids), `packages/shared/src/settings.test.ts` and `packages/db/src/seed.test.ts` (22 keys), `apps/api/src/routes/menu-order.int.test.ts` (default, saved by the owner and seen by the front desk by PIN, not by venue B, bad values 400, front desk 403 and venue B's owner refused, app_rw reads it behind the wall), and the e2e "P-13 · menu order" at the end of `e2e/staff.spec.ts` (Andy saves, his menu and Maya's at the bar computer follow, Lock last, 44 px, Spanish). Spec 03 (key table and Menu order), spec 10 rule 1, the glossary (Menu order) and manual-test 30.13 updated.

### P-14 · Activity log and About

- **Status:** done
- **Size:** S
- **Depends on:** the audit log
- **Spec:** [Security and retention](../spec/12-security-retention.md)
- **Build:** Admin → **Activity log** for the owner (managers by P-10): the venue's audit rows, newest first, filtered by person, kind and date, with personal data masked as in the exports. Admin → **About**: app and desktop versions, the venue's id, the support contact.
- **Acceptance:**
  - [x] Only the venue's own rows; masked fields stay masked; EN and ES; venue-wall test.
- **Notes:**
  - No migration: `audit_log` is read as app_rw behind its venue wall. `apps/api/src/routes/activity.ts`: `GET /v1/venues/{v}/activity` (the owner in a passkey session; managers, bartenders, PIN sessions and other venues' owners are refused) returns 50 rows newest first with `next_before`, filtered by `person` (a user id or `system`), `kind` (the record's table) and `from`/`to` (business dates, the venue's zone and cutover), plus the venue's people and the kinds written in the last 90 days for the filters. `GET /v1/venues/{v}/about` (owners and managers, `admin.access`): the venue's id and name, the server's version and our support contact.
  - Masking is on the server, so nothing sensitive reaches the browser: fields the trigger already writes without values (guest contact details, `pin_verifier`, held cards' name and last 4, outside-card notes) read "hidden"; any field whose name says secret (pin, verifier, token, secret, hash, key, credential, signature, fingerprint, last4, ip, ua, scanned, dob, body …) is hidden too, inside settings objects as well; phone numbers show their last two digits and emails their first letter and domain (as the masked views and invites do), also inside free text; guests' names (guests, room guests, tabs, singers, bookings, waitlist; `guest_name`, `card_name`, `tab_name` …) show as initials. Staff and menu names stay.
  - Staff: Admin → **Activity log** (`ActivityLog.tsx`, owner-only section) with Person, Kind, From, To and **Clear filters** (44 px), loading, empty and can't-load (Try again) states, **Show older**, and a row's extra changes behind "+N more"; Admin → **About** (`About.tsx`, last section, managers too): staff app version (`VITE_APP_VERSION` at build, else "dev"), the desktop app's (`window.west4.version()`) or "Not in the desktop app", the server's, the venue and its id, Support · Email and Phone.
  - Cautious defaults: the log is the owner's alone until P-10 (the ticket's "managers by P-10"; the API's `ownerOnly` check and the section's `ownerOnly` are the two places to widen); it's part of Admin, not a switchable feature (the audit log is core security, like Close the night); the support contact and versions come from the environment (`APP_VERSION`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`, in `.env.example`) and an unset contact reads "Not set yet", never invented; a record's kind shows as its table name (`guests`, `checks`), not a translated word, since there are about 100; times show in the venue's zone, dates as business dates.
  - Tests: `apps/api/src/routes/activity.test.ts` (the masking, hidden fields, actor, About from the environment), `apps/api/src/routes/activity.int.test.ts` (as app_rw: only venue A's rows and people, venue B's owner sees only B's; no contact detail, guest name or PIN verifier in the answer; person, system, kind, date and paging filters, bad values 400; manager, bartender, PIN session and venue B's owner refused; About for a manager, not a bartender or venue B), the principal and wall suites, `apps/staff/src/admin/sections.test.ts`, and the e2e "P-14 · Activity log" at the end of `e2e/staff.spec.ts` (Andy's guest masked, filters, 44 px, Spanish, Andy has About without the log). Spec 12 · 4, spec 08, the glossary (Activity log, About) and manual-test 30.14 updated.

### P-15 · Tax-exempt checks

- **Status:** done
- **Size:** M
- **Depends on:** P-02
- **Spec:** [Money rules](../spec/05-money-rules.md) · rule 8 (tax)
- **Build:**
  - Module **Tax-exempt sales** (off by default). **Tax exempt** on a check needs the organization's name and its exemption certificate number (New York's form ST-119.1 for exempt organizations), and a manager's approval per the setting; sales tax is then zero on that check.
  - The Z report, reports, exports and the money audit show exempt sales and the certificate numbers. Audited.
  - Which sales may be exempt stays the accountant's question (a row in spec 14); the cautious default: the module off, and alcohol stays taxed (a setting the accountant can change).
- **Acceptance:**
  - [x] An exempt check pays no sales tax and the Z report lists it; without a certificate number it's refused; EN and ES; tests.
- **Notes:**
  - Tests first: four `tax_exempt` cases in `seed/money-cases.json` (Room 9 with drinks still taxed: tax $14.02, total $590.02; nothing kept taxed: no tax; a bar tab whose damage fee goes untaxed; after 10% off the whole check), run against `exemptTax` + `checkTotals` (`check-totals.test.ts`) and through the money audit (`money-audit.test.ts`: clean as stored, the full tax on an exempt check caught).
  - Built: `exemptTax` (`packages/rules/src/check-totals.ts`); migration 0168 adds `check_tax_exemptions` (organization and certificate number required, the `still_taxed` list snapshotted, one standing per check, forced RLS, restore wall, audited, closed-night guard) and the `tax_exempt` approval kind. `POST /checks/{c}/tax-exempt` (`{ organization, certificate_no }`; module `tax_exempt`, action `comps.reasonOnly`) always asks for approval per the venue's setting (phone, PIN or none) and writes the row once approved; `POST /checks/{c}/tax-exempt/remove` while the check is open (`apps/api/src/rooms/tax-exempt.ts`). Finalize and splits tax through `checkTax` (only the kept categories); the surcharge carries no tax on an exempt check unless `surcharge` is kept. The check view has `tax_exempt` / `pending_tax_exempt`; the Z report (screen and print) has Tax-exempt sales with each check, its organization and certificate; the tax quarter and its CSV list each exempt check with its certificate; the money audit works its tax out from the kept categories and names each certificate in `covered`.
  - Module `tax_exempt` (Tax-exempt sales): every plan (`allowedOff`), off by default; Admin → Features lists it (18 on · 5 off at West 4) and Set up your venue step 7 has its switch. Off refuses a new exemption (404 `module_off`); removing one stays allowed. Setting `taxExempt.stillTaxed` (Admin → Features → Choices → Taxed even on a tax-exempt check, shown while the module is on).
  - Screens: `TaxExemptPanel.tsx` beside the discount on DeskRoom/Room phone and the bar POS; `TaxExemptChoices.tsx`; the Z report panel. EN and ES.
  - Cautious defaults (spec 14 row and docs/todo.md for the accountant): the module off; drinks stay taxed on an exempt check (the whole `drink` category, since check lines carry no alcohol flag: a soft drink in that category stays taxed too, the cautious side); a cash discount on an exempt check takes no tax back; the venue's approval setting decides who approves (a manager's own ask goes to an owner); "exempt sales" on the reports are the lines in categories the rule pack taxes that the exemption left untaxed. No certificate copy is stored (not asked by the ticket).
  - Spec: Money rules 8 (a tax-exempt check), spec 03 (`taxExempt` key, the module), spec 14 (the accountant's question). No decision changed.
  - Checks: `pnpm check` lint, i18n, typecheck, unit (1371), integration (1480, with `tax-exempt.int.test.ts`) and the migration linter pass (the two settings-key lists fixed and rerun). Browser (isolated stack): the new P-15 test, P-02, Admin → Features (18 on · 5 off), setup.staff and onboard pass.

### P-16 · Inventory

- **Status:** done
- **Size:** L
- **Depends on:** menu, 86
- **Spec:** [Data model](../spec/04-data-model.md)
- **Build:**
  - Module **Inventory** (off by default). A stock count per menu item (or per variant), taken down when a line is sent, put back on a void, with **Receive**, **Count** and **Adjust** (with a reason).
  - A low-stock level per item alerts the manager; at zero the item is 86'd automatically (a setting).
  - Reports → Stock: on hand, used, received and adjusted by date. Audited.
- **Acceptance:**
  - [x] Counts stay right through send, void and offline replay; auto-86 at zero; EN and ES; tests.
- **Notes:**
  - Built: migration 0169 adds `stock_levels` (one per item, or per variant when sizes are counted apart; a variant's own level wins) and `stock_moves` (the ledger: sale, void, receive, count, adjust; one move per check line, unique), both with forced RLS, the restore wall, the closed-night guard on moves, and audited. `packages/db/src/stock.ts`: `addCheckLine` calls `stockForLine` for every line, so every selling path (Accept, the bar POS, a quick sale, a replayed offline round at its Accept) takes the count down once and a void not made puts it back (following a line moved between checks); `moveStock` writes the ledger, 86's at zero, lifts that 86 when the count comes back above zero, and pushes "Low stock" once per crossing of `low_at`; `holdStockOuts` keeps an item 86'd at zero out through the next night after the close lifts every 86 (`nights/close.ts`).
  - Routes (`apps/api/src/routes/stock.ts`, module `inventory`, owners and managers, action `reports.view`): `GET /stock`, `PUT /stock/{item}` (start or stop counting, the low level), `POST /stock/{item}/receive|count|adjust` (adjust needs a reason), `GET /stock/report?from=&to=` (on hand, used, received, adjusted; 93 days at most). Screen: Reports → Stock (`ReportsStock.tsx`), Admin → Features → Choices → Inventory (`InventoryChoices.tsx`), and the switch in Set up your venue's menu step. EN and ES.
  - Module `inventory` (Inventory): every plan, off by default, needs Reports & accounting (its screen lives there); off answers `404 module_off` and no sale, void or close moves a count. Setting `inventory.autoEightySix` (default on, as the ticket asks).
  - Cautious defaults: a **made** void (waste) doesn't put stock back (the drink was poured) and a comp moves nothing; practice (training) checks never move stock; counts are whole units and may go below zero (showing what was sold past it); the auto-86 fires only when a sale takes the count from above zero to zero, so staff can still put it back on by hand; the low-stock push goes to every manager and owner; only owners and managers change counts. Not built (not asked): low stock in the bell (P-11), pour cost and recipes (blueprint K7).
  - Spec: spec 04 (Inventory paragraph; the `made` flag), spec 03 (the module, its need, what off hides, the `inventory` key, the Bar group), glossary (Stock; Made), blueprint (counts and the auto-86 now phase 1). No decision changed.
  - Tests: `stock.int.test.ts` (off and refused; Receive/Count/Adjust and validation; sale, void not made, made void; off moves nothing; replayed round counts once at Accept; auto-86, low push, close hold, back on at Receive; the setting off; the report; the audit log; stopping), the venue-wall and principal suites (new route bodies), settings and seed key counts, and the P-16 browser test.
  - Checks: `pnpm check` lint, i18n, typecheck, unit (1371), integration (1489, with `stock.int.test.ts`) and the migration linter pass (the module dependency table fixed and rerun). Browser (isolated stack): the new P-16 test, Admin → Features (18 on · 6 off), P-09, setup.staff and onboard pass.

### P-17 · Kitchen screen

- **Status:** done
- **Size:** M
- **Depends on:** K (kitchen tickets)
- **Spec:** [Kitchen and food](../spec/16-kitchen.md)
- **Build:** Module **Kitchen screen** (off by default): a paired device (kind `kitchen_display`) or a bar computer's second window shows open kitchen tickets oldest first with their times; **Done** bumps a ticket and tells the bar. Printing stays as it is and can be turned off when the screen is on.
- **Acceptance:**
  - [x] Tickets appear within 3 seconds of being sent and clear on Done; works offline from the cache; EN and ES; tests.
- **Notes:**
  - Built: module `kitchen_screen` (off by default, needs Kitchen & food, every plan with the kitchen allows it) and settings key `kitchenScreen.print` (on by default). Migration 0170 adds device kind `kitchen_display` and `kitchen_tickets` (forced RLS, audited, venue-wall case). Every kitchen ticket now goes through `apps/api/src/kitchen/screen.ts` (`queueKitchenTicket`): a guest's food at Accept, staff food at Send to kitchen and a remake; with the module on it also writes a ticket row, and with `print` off it skips the print job (then Send to kitchen answers `job_id: null`, which the staff app already handles). With the module off the kitchen always prints.
  - Routes `GET /v1/venues/:venueId/kitchen/tickets` (open, oldest first; `?view=done` is tonight's bumped ones) and `POST …/kitchen/tickets/:ticketId/done` (idempotent: a second Done answers the first and emits nothing), for a new principal `kitchen_display`, a bar computer, staff and managers.
  - Staff app: `/kitchen-screen` (no shell, no PIN); a paired kitchen display opens it straight from sign-in and sends heartbeats (no print host). The bar orders screen gets **Open the kitchen screen** (the bar computer's second window) and the **Food up** strip (15 minutes, or until Got it, remembered per browser). Admin → Features → Choices → Kitchen screen holds the print box. EN and ES, with an English/Español toggle on the screen itself because nobody signs in there.
  - "Within 3 seconds": shared screens have no event socket yet (M6-28), so the kitchen screen polls every 2 seconds and the Food up strip every 3. "Offline from the cache": the screen keeps its last answer in the window's session storage (and a held Done list, sent when the connection is back); the desktop app's encrypted offline cache isn't used for it.
  - Cautious defaults: Done does not mark a room's food ready or change runs (Picked up still records Ready, spec 16), and turning the screen off with open tickets is allowed (the printer prints regardless). Tests: `kitchen-screen.int.test.ts`, the event-filter unit test, the e2e "the kitchen screen: sent food shows within 3 seconds, Done tells the bar". Hand test: manual-test 30.17.

### P-18 · A screen for the guest at the bar

- **Status:** done
- **Size:** M
- **Depends on:** W-01
- **Spec:** [Devices, printing, offline](../spec/09-devices-printing-offline.md)
- **Build:** Module **Guest-facing screen** (off by default): a second monitor on a bar computer (a desktop-app window) or a paired device shows the check being rung up (lines, tax, gratuity, total, the cash price) and, when idle, the venue's name.
- **Acceptance:**
  - [x] It follows the register within a second and never shows another check; EN and ES; tests.
- **Notes:**
  - Built: module `guest_screen` ("Guest screen", off by default, every plan, needs nothing, Admin → Features under Bar). Migration 0171 adds device kind `guest_display` (its own principal, hears no events), `devices.follows_device_id` and `guest_screens` (one row per register: the check open there, whether the person's unsent drinks show, a version; forced RLS, restore wall, not audited because it's screen state like heartbeats).
  - Routes (`apps/api/src/routes/guest-screen.ts`, logic in `apps/api/src/receipts/guest-screen.ts`): `POST /v1/venues/:venueId/guest-screen/showing` from the bar POS (staff on a bar or front-desk computer; a locked computer may only clear it; a phone or unpaired browser answers `following: false`) and `GET …/guest-screen?lang=&since=` for a paired guest display (follows the computer Admin picked, else the venue's only bar computer), a bar computer's own window, or staff on it. The amounts are the printed bill's: `bill.ts` now shares `billParts` (receipt model worked out by packages/rules, cash price with the cash discount on); unsent drinks are priced through `orderItemsFor`, as a round would be.
  - Staff app: `/guest-screen` (no shell, no PIN; a paired guest display opens it from sign-in and sends heartbeats), **Open the guest screen** on the bar POS, the bar POS tells the screen which check is open (tab, room, quick sale once Pay made it) and again on every reload, Admin → Printers & devices → **Shows the check from** on a guest screen's row. EN and ES with a toggle on the screen itself (kept per browser, separate from the staff language). The desktop app now opens `/guest-screen` (full screen on the second monitor when there is one) and `/kitchen-screen` in windows of their own; before, it refused every new window, so P-17's "Open the kitchen screen" only worked in a browser.
  - "Within a second": shared screens have no event socket yet (M6-28), so the screen asks twice a second with the last answer's fingerprint (register version + unsent-drinks version) and gets `unchanged` unless something moved, and in full every 5 seconds (room time and the like). "Never another check": a screen reads only its register's row, each answer carries one check whole, and offline or on an error it drops back to the venue's name instead of keeping a check.
  - Cautious defaults: a register silent for 3 minutes (closed, crashed) reads as idle; leaving the bar POS inside the app clears the screen at once, a closed or reloaded browser only through that 3-minute rule or the next bar POS load. The tab's name and the card's brand and last four show (as on the receipt); no phone numbers. Spec 09, 03, 04 and the glossary updated (the spec had no section for this screen). Tests: `guest-screen.int.test.ts` (off, follow, unsent, switch, second register and Admin's choice, phone and locked computer, 3-minute idle, EN/ES, venue wall), the event-filter and desktop window unit tests, the e2e "the guest screen: follows the register within a second…". Hand test: manual-test 30.18.
  - Found by the full `pnpm check --e2e` and fixed here: two e2e counts out of date since P-16/P-17 (Admin → Features now "18 on · 8 off", the Bar group's 8 modules), and the principal suite tripping Twilio's check route's own 20-a-minute limit (429) once the cast grew; the security suites now pass `rateLimitFloor` so a route's own limit can't answer before the principal check. Full run: lint, i18n, typecheck, unit 1374, integration 1503 and db-lint pass; e2e 265 passed, the 3 failures above fixed and rerun green.

### P-19 · A missed sale on tonight's date

- **Status:** done
- **Size:** S
- **Depends on:** M7 (closed nights)
- **Spec:** [Money rules](../spec/05-money-rules.md) · rule 16
- **Build:** **Add a missed sale** for managers: a sale rung up tonight with "From the night of <date>" and a reason; it counts on tonight's date (closed nights never reopen, D88), and reports show which night it came from. Approval per the setting; audited. Replaces the old register's past-dated Manual Ticket.
- **Acceptance:**
  - [x] It lands on tonight's Z with its earlier date shown; a closed night's totals don't change; EN and ES; tests.
- **Notes:** Module **Missed sales** (`missed_sale`, in the Team group since Money already holds eight switches, every plan, off by default; Admin → Features and Set up your venue's step 7). `POST /v1/venues/{v}/checks/{c}/missed-sale` (`{ from_date, reason }`; `refunds.request`, so owners and managers) marks a bar tab opened tonight "From the night of <date>"; it waits for approval per the venue's setting (approval kind `missed_sale`), then writes `check_missed_sales` (migration 0172: forced RLS, restore wall, audited, closed-night guard on its own business date, `from_date < business_date`, one standing per check). `.../missed-sale/remove` takes it off while the tab is open, even with the switch off. The tab's lines are ordinary lines of tonight's date, so it counts tonight and an earlier (closed) night never changes; the X/Z report (`missed_sales`, `apps/api/src/tabs/missed-sale.ts`) and its printout list each with the night it came from, the reason and its sales before tax and gratuity. Staff: `MissedSalePanel.tsx` on the rail's tab, the report in Close the night. Cautious defaults: bar tabs only (not room checks or quick sales, which finalize at Pay); any earlier date is accepted (no limit on how far back, which no venue fact sets); the request is refused for tonight or a later date. Tests: `tabs/missed-sale.int.test.ts` (off refused, bartender refused, validation, approval, audit log, tonight's Z and print lines, the earlier night unchanged, a closed night refusing a row, remove), the principal suite, and the e2e "P-19 · Missed sale" (EN and ES). Manual test 30.19.
