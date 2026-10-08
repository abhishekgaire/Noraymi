# M9 · Cutover and going live

Sep 29, 2026 · the backlog for [M9 · Cutover and going live](../milestones.md#m9--cutover-and-going-live) and [the go-live gate](../milestones.md#the-go-live-gate), one ticket per Claude Code session. The [spec](../spec/README.md) says how each piece works, [screens](../screens.md) says where to build differently from the frozen canvas, and rehearsals use the [demo seed](../demo-seed.md). Paths follow the repo layout M1's first ticket creates (`apps/api`, `apps/staff`, `apps/desktop`, `apps/guest`, `packages/db`, `packages/rules`). Runbooks go in `docs/runbooks/`, and gate evidence in `docs/gate/`.

**Goal (usable when done):** West 4 runs live nights, and the gate's 4 weeks begin.

**Done when** (from [milestones](../milestones.md#m9--cutover-and-going-live)):

- An import dry run loses nothing: bookings, deposits and consents match West 4's old system in count and to the cent.
- Before the first live night, everyone on West 4's team has set a new PIN on their own phone and paired a badge (Admin → Team shows nobody waiting), and no imported PIN exists anywhere.
- The cellular signal check passes at both pay points.
- The staff trial meets its targets, or the design changed and the trial ran again.
- Every old west4karaoke.com page redirects, and bookings made on the old site before the move are on the board.
- The go-live gate below is met.

**The go-live gate** (from [milestones](../milestones.md#the-go-live-gate)). Phase 1 is done when all of these are true:

1. Every must-fix item in [the table below](../milestones.md#must-fix-items-and-where-they-close) is closed: the milestone in its "Closed by" column has passed its "Done when".
2. The sign-offs marked "gate" in [Open technical questions](../spec/14-open-questions.md) are in, from the lawyer, the accountant and the PCI assessor.
3. West 4's future bookings, deposits and guests are imported with nothing lost (M9).
4. The outage drill has passed (M8).
5. Then West 4 runs **4 weeks of live nights without a money error**.

A **money error** is any amount charged, refunded, tipped, taxed, paid out or reported that differs by any amount from what the [money rules](../spec/05-money-rules.md) give: a double or missed charge; a wrong line, tax, gratuity or tip; a refund over its cap; or a Z report, drawer count or payout that doesn't reconcile to the cent. When one happens, it's fixed and the 4 weeks start again.

**Depends on:** M8 and everything before it. **Size in milestones.md:** 2 weeks, then the 4-week gate. The tickets below add up to more; see the size line at the end.

## Suggested order

1. **Day one, outside waits:** send the sign-off requests (M9-13), ask West 4 for its old system's exports (M9-01), and book the hardware install (M9-07) and the staff trial (M9-11).
2. **Imports:** M9-01, then M9-02, M9-03, M9-04 and M9-05, then the dry run M9-06.
3. **People and hardware, in parallel:** M9-07, then M9-08 (badges pair on the installed readers), M9-10 and M9-11. M9-12 whenever the screens are final.
4. **Proof and cutover:** M9-14 and M9-15, then M9-16, which runs M9-09's domain move and the final import at cutover.
5. **The gate:** M9-17 runs the 4 weeks.

Definition of done: see CLAUDE.md.

## Tickets

### M9-01 · Build the import tool for West 4's export files

- **Status:** blocked
- **Size:** M
- **Depends on:** M1-05 (the audited migration role), M1-07 (audit triggers), M2-04 (rooms), M2-06 (guests and bookings), M3-03 (the menu's save path), M5-06 (policy versions), M5-11 (manage links)
- **Spec:** [Data model](../spec/04-data-model.md) · `bookings` (source `import`, `legacy_ref`, `deposit_legacy_cents`), `guests`, `consents`, the menu tables, `memberships`, `legacy_nightly_totals`; [Testing and operations](../spec/13-testing-operations.md) · Releases (batches as the audited migration role); [milestones](../milestones.md#m9--cutover-and-going-live) · M9 Ships (Imports); [blueprint](../blueprint.md) · Proposed plans (Setup: menu import)
- **Build:**
  - `pnpm import` in `packages/db`: reads the files West 4 produces with its old system's own export tools (CSV or JSON), through a mapping file per source.
  - Validation of every row, with a report that names the file and line of each problem.
  - `--dry-run` loads into a scratch venue on a staging copy and writes a reconciliation report: counts and cents by kind (bookings, deposits, guests, consents by kind, menu lines, people).
  - A live run is idempotent on `legacy_ref`, so the cutover delta can run again safely, and it runs in batches as the audited migration role, each row audited with the import run.
  - It refuses any column that looks like a PIN or a card number, and stores neither.
  - It loads `legacy_nightly_totals` from the old system's nightly totals when West 4 has them.
- **Acceptance:**
  - [x] A rehearsal export made from the demo seed's 11 bookings, 17 guests, 127-line menu and team imports, and the report reads 11 bookings with $990.00 of deposits.
  - [x] A file with a PIN or card-number column is refused before anything loads.
  - [x] Running the same file twice changes nothing the second time.
  - [x] Every loaded row has an audit row naming the import run.
  - [ ] Works on West 4's real export files. Blocked: West 4's old system and its export files haven't been received; write their mapping and dry-run them when they arrive (M9-06).
- **Tests:** unit tests for mapping and validation; an integration test of the rehearsal import; the venue-wall suite over the import, which writes only its own venue.
- **Notes:** Import only what West 4 exports with its old system's own tools, or through that system's documented API under West 4's own account; never scrape or reverse-engineer it. Spec gap: neither the spec nor the seed names West 4's old system or its export formats; ask West 4 first, and if the system has no export, West 4 exports by hand. `legacy_nightly_totals` isn't in the milestone's import list; load it if West 4 has nightly totals, for M7-18's trends.
  - **Built (Oct 8, 2026):** `pnpm db:import` (root script; `pnpm import` is pnpm's own command, so the script is `db:import`) in `packages/db/src/import-cli.ts` and `packages/db/src/import/` (CSV reader, value readers, the versioned mapping, prepare, load). Migration `0125_imports.sql`: `import_runs` (one per run, with file hashes, mapping version and report) and `import_refs` (legacy record → our row, with a hash of its values), both walled and audited; `app_migrator` may now insert users. Runbook and mapping format: `docs/runbooks/import.md`. Fixtures (all made up): `packages/db/test-fixtures/import/` (`rehearsal/` generated from the demo seed by `src/import/rehearsal.ts`, `sample/` for JSON, cents, consents and nightly totals, `refused/`). Tests: `src/import/import.test.ts` (unit), `src/import/import.int.test.ts` (rehearsal dry and live runs, re-run, delta, refusals, problems, and the venue wall: an import into venue B leaves venue A byte-for-byte unchanged, audits only in B's chain, and can't see A's rooms or imported guests).
  - **Cautious defaults:** the export format is unknown, so the tool reads any CSV or JSON through a mapping file (version 1) instead of one fixed format. A record already imported is never overwritten: if its values changed in the old system, the run lists it as "changed, not applied" and doesn't reconcile, for a manager to settle by hand. Any problem in any row stops the whole import (nothing partial). Local times that happen twice or never on daylight-saving nights are refused, not guessed. A card number anywhere in any cell refuses the file, even in a column the mapping doesn't read. A person whose email is already a user is linked to that user, and someone already on the venue's team keeps their membership untouched. Guests and people with no language get English.
  - **Dry run:** "a scratch venue on a staging copy" is done as one transaction that loads everything into the real target venue, writes the report, and rolls back, so the rooms the bookings need are the venue's own and nothing is left behind; point `DATABASE_URL` at a staging copy for the rehearsal. Only the `import_runs` row with its report is kept.
  - **Left for later tickets:** an imported booking gets no room block, payment, policy version or manage link yet, and `deposit_cents` stays empty with the old system's deposit in `deposit_legacy_cents` (M9-02); consent proof rules (M9-03); the menu's tax categories per item and promotion checks (M9-04); team invites (M9-05). `pnpm seed` now also wipes the venue's `import_runs` and `import_refs`.

### M9-02 · Import West 4's future bookings with their deposits

- **Status:** blocked
- **Size:** M
- **Depends on:** M9-01; M5-06 (policy versions), M5-11 (manage links), M5-12 (refund cut-offs); M4-04 (payments and allocations), M4-09 (deposits applied at check-in); M2-05 (room assignment)
- **Spec:** [Data model](../spec/04-data-model.md) · `bookings`, Room assignment, `policy_versions`, the money core (`payments` method `external`, `payment_allocations`); [Money rules](../spec/05-money-rules.md) 11 and 16 (customer deposits); [Payment flows](../spec/07-payment-flows.md) · Deposit when booking online (4 and 5)
- **Build:**
  - Each future booking as a `bookings` row with source `import`, its `legacy_ref` and status `confirmed`, with a real room by the assignment rules; a booking that fits no room goes on a manager's list.
  - The terms each guest accepted on the old site as `policy_versions` rows (text and hash), with `accepted_at` where the export has it, and each booking's refund cut-off from those terms.
  - Each deposit as `deposit_legacy_cents` plus an `external` payment for the booking (captured, paid through the old system), allocated at check-in like any deposit.
  - An opening journal entry on the cutover date that puts the imported deposits in customer deposits.
  - A manage link for each imported booking.
- **Acceptance:**
  - [x] Each imported booking shows on the Calendar, and on its night on the board, with its deposit.
  - [x] A rehearsal copy of Marcus T.'s booking with its $120.00 deposit, checked in and closed out as in the worked example, shows −$120.00 and $498.60 to pay.
  - [x] A booking that fits no room is on the manager's list, never dropped.
  - [x] The opening journal entry puts the imported deposits in customer deposits, and it balances.
  - [ ] Works on West 4's real export files. Blocked: West 4's old system and its export files haven't been received; map its bookings, terms and deposits and dry-run them when they arrive (M9-06).
- **Tests:** the rehearsal on the seed's 11 bookings; money-cases groups `deposits` and `room9_close_out`.
- **Notes:** Spec gap: legacy deposits sit on the old system's processor, so refunding or keeping one can't go through West 4's new Stripe account. Cautious default: a manager refunds it in the old system and records it here as a refund of the `external` payment with the old system's reference; a kept one becomes the usual `fee` check with a `forfeit` line. Confirm with the founder where the old deposits are held. The old site's manage links can't carry over; M9-09 redirects them.
  - **Built (Oct 8, 2026):** in the import tool (`packages/db/src/import/bookings.ts`, the bookings and new `policies` steps in `load.ts`, `import-cli.ts`), migration `0126_import_bookings.sql`. A booking whose status is `pending` or `confirmed` is one still to come: it gets a room block in the room the export named when that's free and fits, otherwise the assignment rules' smallest free room that fits (`roomOrder`, using `freeRoomsFor` from `@west4/rules` and the exclusion constraint); its old terms as a `policy_versions` row of the new kind `imported_terms` (text and hash; never the venue's own deposit policy), `accepted_at`, and `refund_cutoff_at` = start − the terms' `refund_hours`; `deposit_cents` and `deposit_legacy_cents`; an `external` payment, captured, on the cutover date (`payment_events` source `import`, no Stripe id, never a Stripe call); and a manage link (hash stored; the token goes only to the `--links-out` file). A booking that fits no room goes to `import_unplaced`, shown to managers at `GET /v1/venues/{v}/bookings/no-room` and named in the report. Each live run keeps an opening journal (`openingJournal` in `@west4/rules`: debit the new account "Deposits held by the old system" (`legacy_deposits`), credit customer deposits) on `import_runs.opening_journal`, written as a QuickBooks CSV with `--out`; the run reconciles only when the payments plus the listed deposits equal the deposits held and the journal balances. The rehearsal export now has a `terms.csv`.
  - **Kept out of the night's money:** an `external` payment with a booking is an imported deposit, so the night journal's deposits taken, the Z report's deposits taken, Unmatched payments (list, match, the offline-orders view and the outage drill) all leave it out; it enters the night's money only when check-in applies it (from customer deposits, as any deposit).
  - **Tests:** `packages/db/src/import/bookings.int.test.ts` (the rehearsal's 11 as bookings still to come plus one moved and one with no room: rooms, payments, terms and cut-offs, links, opening journal, re-run and delta, venue wall); `apps/api/src/routes/imported-bookings.int.test.ts` (Calendar, board, check-in applies the $120.00, Room 9's check with the imported deposit at −$120.00 and $498.60, the manager's list, tonight's deposits taken and Unmatched payments unchanged); the money-cases groups `deposits` and `room9_close_out` pass in the unit suite (an imported deposit keeps the old system's cents; nothing is recomputed). The Marcus case swaps the imported deposit onto the worked example's check with `applyDeposits` (the step check-in runs), because Room 9 is occupied on the demo night; a real check-in of an imported booking is tested separately on Oct 2.
  - **Cautious defaults:** statuses other than pending and confirmed are history (no block, payment or link). The debit side of the opening journal is one "Deposits held by the old system" account until the accountant names it. The opening journal lives on the import run and its CSV, not in `exports` (one accounting export per night); M9-06 or the accountant decides whether it joins the QuickBooks export screen. Terms with no refund window give no cut-off. A booking past the night's close is still placed (the old system already promised it).
  - **Left for later:** seating a listed booking with its deposit carried over (today a manager reads the list and books by hand; the deposit stays in the opening journal, not as a payment), recording an old-system refund against the `external` payment (the ticket's cautious default; the refund screens don't take an external payment yet), and a staff screen for the list. Founder: confirm where the old deposits are held.

### M9-03 · Import guests with their consent evidence

- **Status:** blocked
- **Size:** S
- **Depends on:** M9-01; M2-06 (guests), M2-23 (consents, STOP and HELP); M8-13 (opt-outs kept as hashes)
- **Spec:** [Data model](../spec/04-data-model.md) · `guests`, `consents`; [Song systems and texts](../spec/11-song-systems-texts.md) · Consent and timing; [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-M3
- **Build:** guests per venue, never shared across venues. `consents` rows only with their proof: the form, its wording (as `text_version`), the IP address and the time, with source `import`. A marketing opt-in without proof isn't imported as consent and is listed in the report. Opt-outs are imported as opt-outs and honored at once. Service texts go to the number given for each booking. Phone numbers must be +1 E.164; others are listed.
- **Acceptance:**
  - [x] The report counts consents by kind: marketing opt-ins with proof, opt-outs, and opt-ins dropped for lack of proof.
  - [x] A guest who opted out on the old site gets no text from us.
  - [x] No marketing consent exists without its proof.
  - [ ] Works on West 4's real export files. Blocked: West 4's old system and its export files haven't been received; map its guests and consents (and check it kept the form, wording, IP and time of each opt-in) and dry-run them when they arrive (M9-06).
- **Tests:** unit tests for the proof check; an integration test that an imported opt-out blocks a Booking confirmed text.
- **Notes:** West 4's two marketing texts stay off either way.
  - **Built (Oct 8, 2026):** `packages/db/src/import/consents.ts` (`consentOutcome`, `storedKind`), the consents step and report in `load.ts`, and the `ip` field and form (`source`) in the mapping. A marketing opt-in is imported only with all four pieces of proof: the form (stored as source `import:<mapping source> · <form>`), its wording (`text_version`), the IP address and the time; one missing any of them is set aside before loading, never stored as consent, and listed in the report with what's missing. Every opt-out is imported and honored at once. A guest's phone number that isn't +1 is left out of the guest (the guest still imports) and listed (`Prepared.listed`); a number that isn't a phone number at all is still a problem that stops the run. Service texts already go to the guest's own number; nothing changed there. Runbook: docs/runbooks/import.md · Guests and their consents.
  - **Tests:** unit tests for the proof check in `import.test.ts`; `packages/db/src/import/import.int.test.ts` (the sample's four consents: one with proof, one opt-out, one service, one dropped; no proofless marketing consent in the venue); `apps/api/src/routes/imported-consents.int.test.ts` (an imported opt-out makes `queueText` refuse Booking confirmed with `opted_out`; `marketingConsent` is true only with proof; a French number is listed).
  - **Cautious defaults:** an SMS opt-out of any kind (marketing or every text) is kept as an opt-out of every text (kind `texts`), so a guest who opted out on the old site gets no text at all, including service texts; an email opt-out keeps its kind. Proof is required of email marketing opt-ins too. Nothing is ever filled in for missing proof.

### M9-04 · Import the menu

- **Status:** blocked
- **Size:** S
- **Depends on:** M9-01; M3-03 and M3-04 (the menu API and Admin → Menu), M3-02 (the promotion checks), M3-05 (the menu PDF job); M6 (`pos_layouts`)
- **Spec:** [Data model](../spec/04-data-model.md) · the menu tables, `pos_layouts`; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Promotion checks; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · rule 2 (nothing moves)
- **Build:** West 4's menu through the same save path as Admin → Menu, so the promotion checks run: categories, items, variants, options and modifier groups, short button names, the alcohol flag, tax categories, stations and packages. The menu PDF job runs again. A `pos_layouts` version for the bar station is built from the imported items and published, starting the next business date.
- **Acceptance:**
  - [x] The menu page, the PDF and the room page show the same items and prices.
  - [x] Every alcohol item carries the flag, and every item has a tax category.
  - [x] An item or package the promotion checks refuse stops the import with the reason.
  - [x] The bar POS grid shows each item's button name in a fixed slot.
  - [ ] Works on West 4's real menu export. Blocked: West 4's old system and its export files haven't been received; map its menu (variants, choices, packages, tax categories, grid sections) and dry-run it when it arrives (M9-06).
- **Tests:** an integration test of a menu import through the save path; a test that a refused package stops the run.
- **Notes:** The seed's 127-line menu comes from the canvas; West 4's real menu replaces it in production.
  - **Built (Oct 8, 2026):** the import's `menu`, new `modifiers` and new `packages` steps in `packages/db/src/import/load.ts` now save through Admin → Menu's path: `insertMenuRow`/`patchMenuRow` and the promotion checks, which moved out of the menu route into `menuPromotionRefusals` in `packages/db/src/menu.ts` (the route now calls it; behaviour unchanged). Menu rows sharing `item_ref` are one item's variants; choices make modifier groups and options; packages are saved `unchecked`, checked, then stamped with the pack version, as in Admin. A live run first loads and checks the whole menu in a rolled-back transaction, so a refusal stops it before any batch commits (`file:line the rule pack's promotion checks refuse "<name>": <reason>`). After loading: `menu.changed`, the menu PDF job queued again, and a new bar grid version (`packages/db/src/import/layout.ts`) published through `publishPosLayout` (moved from the Bar POS route into `packages/db/src/pos-layouts.ts`, which the route now wraps) to start at the next business date. Migration `0127_import_menu.sql` (new ref kinds; `app_migrator` reads the rule packs and its own venue's `rule_pack_id`, and may publish a layout). Runbook: docs/runbooks/import.md · The menu.
  - **Tests:** `apps/api/src/routes/imported-menu.int.test.ts` on the demo night with the fixture in `packages/db/test-fixtures/import/menu/` (refused package stops it with nothing loaded; variants, choices and the checked package; alcohol flags and tax categories; the public menu that the menu page and the room page read and the PDF's HTML (`menuHtml`, what the PDF job prints) show the same items and prices; grid version 2 from Sep 26 with each new item in its section and no old button moved; a re-run changes nothing); unit tests for `sectionFor` and `placeItems`; the rehearsal tests now count variant refs too.
  - **Cautious defaults:** the tax category is required (the export's or the mapping's default, `drink` or `food`), never guessed; a category's rows must agree on it, since tax is per category (spec 04). An item's grid section is the export's `pos_section` or the section its category's name starts with; one with neither, or whose section is full, is left off the grid and listed for the owner. Buttons already on the grid never move; favorites stay empty for the owner to pick. If a draft layout is open in Admin → Bar POS, the import publishes no grid and says so. The PDF comparison uses the PDF's HTML rather than printing with Chromium (the e2e comparison test, M5-03, prints it). Item descriptions, price rules (happy hours) and per-item 86 state aren't imported: the export format is unknown; add them to the mapping when West 4's files show them.

### M9-05 · Import the team as people and roles only

- **Status:** blocked
- **Size:** S
- **Depends on:** M9-01; M1-05 (memberships), M1-14 (roles), M1-31 (Admin → Team and languages)
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · PINs, Roles, Languages; [Data model](../spec/04-data-model.md) · `memberships`; screens [AdminDesk](../screens.md#admindesk) note 8, [N25](../screens.md#n25-set-your-pin)
- **Build:** memberships with each person's name, phone, email, role (one of the five) and language, and no PIN and no badge. Tip eligibility is left for the owner to set in Admin → Team (M7-09). A file with a PIN column is refused. Each imported person gets their invite in M9-08.
- **Acceptance:**
  - [x] No imported membership has a `pin_verifier` or a badge.
  - [x] A team file with a PIN column is refused.
  - [x] Every imported role is one of Owner, Manager, Bartender, Front desk and Staff.
  - [ ] Works on West 4's real team export. Blocked: West 4's old system and its export files haven't been received; map its job titles onto the five roles and dry-run it when it arrives (M9-06).
- **Tests:** an integration test of the team import; the refusal test.
- **Notes:** The demo PINs in the seed are for staging only and never reach production.
  - **Built (Oct 8, 2026):** most of it came with M9-01 (the `people` step: a user, linked by email when one exists, and an invited membership with name, phone, email, role and language; the PIN-column refusal). This ticket adds the PIN's length for the role (`pin_digits`: 6 for owners and managers, 4 for the rest), set exactly as an invite from Admin → Team does (`pinDigitsFor`, now shared from `@west4/db`), so the person's own PIN screen (N25) knows how many digits to ask for. Still no PIN and no badge. Runbook: docs/runbooks/import.md · The team.
  - **Tests:** `packages/db/src/import/team.int.test.ts` (four people in four roles with their phones, emails and languages, invited with no PIN or badge, every membership the run inserted checked through its audit row; a PIN column refused before anything loads, in another spelling too and when the mapping doesn't read it; an unknown job title or role refused; someone already on the team left untouched, PIN and all).
  - **Cautious default:** tip eligibility isn't set by the import; the membership gets the same default as an invite from Admin → Team, and the owner sets it there (M7-09). Invites go out in M9-08.

### M9-06 · Run the import dry run and prove nothing is lost

- **Status:** blocked
- **Size:** M
- **Depends on:** M9-01 to M9-05
- **Spec:** [milestones](../milestones.md#m9--cutover-and-going-live) · M9 Done when; [milestones](../milestones.md#the-go-live-gate) · the go-live gate, item 3
- **Build:** the dry run on a staging copy of production: bookings, deposits and consents compared in count and to the cent with the old system's own totals, a report or screen West 4 takes from the old system on the day of the export, never the export file itself. Every difference is fixed and the run repeated until there are none. West 4's owner signs the report. The cutover delta is rehearsed: bookings made after the dry run are imported again by `legacy_ref`.
- **Acceptance:**
  - [ ] The dry run's bookings, deposits and consents match West 4's old system in count and to the cent. (The comparison is built and proven on the fixtures; waits on West 4's real export and the old system's own totals.)
  - [ ] The signed report is kept in `docs/gate/` as the evidence for gate item 3. (The report is written for signing and `docs/gate/import-dry-run.md` is its place; waits on the real run and the owner's signature.)
  - [ ] The rehearsed delta adds only the new bookings and changes nothing already imported. (Proven on the fixtures in `dry-run.int.test.ts`; rehearsed for real with West 4's newer files.)
- **Tests:** the dry run itself; the delta rehearsal.
- **Notes:** Built: `pnpm db:import … --dry-run --old-system <totals.json> --out <dir>` (`packages/db/src/import/old-system.ts`) compares the saved bookings (count), deposits (to the cent) and consents (count), and guests when given, with the old system's own totals typed from its own report on the day of the export; prints `match`/`DIFFERENT` per line, exits non-zero on any difference, and writes `dry-run-report-<run>.md` for the owner to sign (counts and cents only, no guest details). Rehearsed on the fixtures (`rehearsal/` and `sample/old-system-totals.json`) in `packages/db/src/import/dry-run.int.test.ts`: the match, a one-booking and one-cent difference named, the signable report, and the delta (two new bookings load, every earlier row unchanged). Runbook: `docs/runbooks/import.md` · The dry run; gate page `docs/gate/import-dry-run.md`. Cautious default: a marketing opt-in dropped for lack of proof (M9-03) counts as accounted for, with a note naming how many, since the law keeps it from becoming consent. Blocked on West 4's real export files and the old system's own totals; the owner's signature follows.

### M9-07 · Install and pair the hardware, and check the cellular signal at every pay point

- **Status:** blocked
- **Size:** M
- **Depends on:** M1-15 (pairing), M1-30 (the USB NFC readers), M3-13 and M3-14 (network and USB printers), M4-02 (readers on West 4's Location), M4-13 (drawers), M6 (the Up next TV), M8-02 (the router)
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Devices at West 4, Pairing, Room tablets, Router, Supported hardware; [Stripe setup](../spec/06-stripe-setup.md) 4; [Scope and architecture](../spec/01-scope-architecture.md) · When the venue's internet drops (1); screens [AdminDesk](../screens.md#admindesk) note 9, [Console](../screens.md#console) note 1; [demo seed](../demo-seed.md#cash-drawers-and-devices)
- **Build:**
  - Both S710s registered to West 4's Location with cellular on, labeled "Bar S710" and "Front desk S710".
  - Both receipt printers with their drawers on the kick ports; both USB NFC readers on the bar and front-desk computers.
  - The 14 room tablets in managed kiosk mode (Guided Access or device management on iPad, lock-task mode on Android), each paired to its room; the Up next TV; the router.
  - Every device paired, and Admin → Printers & devices and the Console checked against each other.
  - The cellular signal check in `docs/runbooks/cellular-check.md`: at each pay point, with the reader's Wi-Fi off, a small live payment completes over cellular and is refunded, three times at a busy hour, with the reader's signal noted.
- **Acceptance:**
  - [ ] The cellular signal check passes at the bar and at the front desk. (On site: `docs/runbooks/cellular-check.md` with its record table; needs the installed S710s and a busy night.)
  - [ ] Admin and the Console show the same devices online: both readers, "Backup internet · on", and 13 of 14 room tablets while Room 4 is out of service. (Software proven on the seed: `devices:check` and the Console share `deviceHealth` over the same rows, `apps/api/src/ops/hardware-check.int.test.ts`; `e2e/console.spec.ts` and `e2e/staff.spec.ts` show the same line on both screens. On site after the install.)
  - [ ] Each drawer opens on a cash payment and on a no-sale, and on nothing else. (Software proven: `cash.int.test.ts`, `drawer-moves.int.test.ts`, `training.int.test.ts`, and now a card payment in `tab-pay.int.test.ts` makes no kick; the kick test on each real drawer is on site, `hardware-install.md` step 3.)
  - [ ] Each room tablet shows "Room available" between sessions and takes no orders then. (Software proven: `room-tablet.int.test.ts`, `e2e/guest.spec.ts`; checked on each real tablet on site.)
- **Tests:** the check itself; a kick test on each drawer.
- **Notes:** Spec gap: "passes" has no mark of its own; cautious default: three live payments in a row complete over cellular at each pay point without an unknown result. Built: `pnpm --filter @west4/api devices:check` (`apps/api/src/ops/hardware-check.ts`), read-only, prints the install's device check as Markdown and exits non-zero naming what's not in place: each pay point's S710 (label, Stripe registration, cellular on, online), its drawer on an online receipt printer, its USB badge reader on its computer, one tablet per room (online unless out of service), the Up next TV, the router's backup internet, and the health line Admin and the Console share (the Console's `deviceHealth`). Runbooks: `docs/runbooks/hardware-install.md` (install table with blank serials, the checks) and `docs/runbooks/cellular-check.md` (the procedure and a blank record for the reader's signal as shown; nothing is estimated). The seed now links each USB badge reader to its computer and keeps the readers' cellular flag, as real pairing and registration do. Spec gap: spec 09 opens the drawer for drops, paid-outs and tip-outs too, so "nothing else" is read as no kick for a card payment, a reprint or a practice sale; written so in the runbook. No serial number or signal reading is invented; they're written on site. Blocked on the physical install at West 4.

### M9-08 · Get everyone their own PIN and badge

- **Status:** blocked
- **Size:** S
- **Depends on:** M9-05, M9-07 (badge readers installed); M1-23 (invites and Set your PIN), M1-30 (badge pairing), M1-22 (push)
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · PINs, Badges; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Staff phones; screens [N25](../screens.md#n25-set-your-pin), [Pin](../screens.md#pin) note 8, [AdminDesk](../screens.md#admindesk) notes 4 and 8; [demo seed](../demo-seed.md#the-team-tonight)
- **Build:** an invite to each person's own phone, where they confirm their number once, set a new PIN (4 digits, 6 for managers and owners) and pick their language; installing the staff app to the home screen with push (the iPhone walkthrough); pairing a badge by tapping it on the bar or front-desk reader in Admin → Team. Admin → Team shows who's waiting and for what: invite not accepted, no PIN, no badge, push off. A production check that no PIN verifies against the seed's demo PINs (915204, 730915, 4071, 6358), and that every PIN was set by its own person through an invite or a reset (audit rows).
- **Acceptance:**
  - [ ] Before the first live night, Admin → Team shows nobody waiting. (Built and tested: `team-admin.int.test.ts`, `e2e/staff.spec.ts`; waits on West 4's team doing it on their own phones.)
  - [ ] No imported PIN exists anywhere: every PIN's audit row shows its own person set it. (`pins:check` built and tested on the seed, `apps/api/src/ops/pins-check.int.test.ts`; run against production after setup.)
  - [ ] None of the demo PINs verifies for anyone in production. (Same check; run in production, and again the day before the first live night.)
  - [ ] Each person's badge tap takes over the bar computer in under 2 seconds. (Software proven with the emulated reader, `e2e/desktop.spec.ts`, `badge.int.test.ts`; on real hardware once M9-07 installs the readers.)
- **Tests:** the production PIN check, run again the day before the first live night.
- **Notes:** A PIN is never texted, emailed or shown to anyone, a manager included. Already built in M1: invites with the number confirmed once, Set your PIN (4 or 6 digits by role, blocklist) and the language pick (M1-23), PIN reset links, badge pairing in Admin → Team (M1-30), push and the iPhone walkthrough (M1-22). Built here: `GET /team` gives each person `push_on` and `waiting` (invite, pin, badge, push) plus `waiting_count`; Admin → Team shows "Nobody waiting" or "Waiting: N" and a "Waiting for" column (English and Spanish). `pnpm --filter @west4/api pins:check` (`apps/api/src/ops/pins-check.ts`) fails when a demo PIN verifies for anyone or when a PIN's newest audit row isn't an update by its own person (a seed, import or someone else wrote it), names people only, never a PIN. Runbook: `docs/runbooks/pins-and-badges.md`. Cautious default: "No badge" counts only once the venue has a USB badge reader paired, so a venue without readers isn't stuck waiting. Blocked on West 4's team setting up on their own phones and on the readers M9-07 installs.

### M9-09 · Move west4karaoke.com with a redirect from every old page

- **Status:** blocked
- **Size:** M
- **Depends on:** M5-01 (the guest site), M9-06 (the cutover delta)
- **Spec:** [milestones](../milestones.md#m9--cutover-and-going-live) · M9 Ships (the domain move), Done when; [Data model](../spec/04-data-model.md) · `domains`; [Song systems and texts](../spec/11-song-systems-texts.md) · The automatic texts (west4karaoke.com/b/… and /rc/… links); screens [SiteBuilder](../screens.md#sitebuilder) note 2
- **Build:**
  - The list of old URLs from West 4's own sources: its sitemap, its host's page list, Search Console for its domain and its analytics.
  - A redirect map served by the guest web: each old URL answers 301 to its new page, or to the nearest page.
  - The cutover runbook in `docs/runbooks/domain-move.md`: lower DNS TTLs a week ahead; keep West 4's email records (MX, SPF, DKIM, DMARC); issue TLS certificates before the switch; create West 4's `domains` row by the runbook (no Admin screen in phase 1); switch the old booking form off at the moment of the move; run the final delta import (M9-06) so bookings made on the old site before the move are on the board; a rollback plan.
  - Old manage-booking links redirect to a page with West 4's phone number, since their tokens can't carry over.
- **Acceptance:**
  - [ ] Every old west4karaoke.com page redirects, and no old URL answers 404. The five pages in the old site's sitemap pass (unit and e2e); waiting on the founder's list from Wix's page list, Search Console and analytics, and an old manage link's path.
  - [ ] Bookings made on the old site before the move are on the board. On move day: the final delta import (runbook, The move 1).
  - [ ] West 4's email still arrives after the move. On move day: `check:domain --expect` and a test email; the Google Workspace MX, SPF and DMARC records were saved on Oct 8.
  - [ ] Booking confirmed and Receipt links sent after the move open on the new site. Needs production with `GUEST_APP_URL=https://west4karaoke.com` and the DNS switch, both the founder's.
- **Tests:** a redirect test over every URL in the list; a DNS and TLS check before and after the switch.
- **Notes:** Built: `apps/guest/legacy-redirects.ts` (the old URLs from the old site's public sitemap, read Oct 8, 2026: `/`, `/menu`, `/menu?menu=menu`, `/room`, `/reservation`; `/reservation` 301s to `/book`; `www` 301s to the bare host when `SITE_HOST` is set; `LEGACY_MANAGE_PREFIXES`, empty until the founder reads the path off an old confirmation email), wired into `apps/guest/proxy.ts`; the page `/booking-moved` with West 4's number (English and Spanish strings `site.moved.*`); `pnpm --filter @west4/guest check:domain` (DNS, the email records saved and compared, the certificate, and every old URL), with `domain-check.ts`; the runbook `docs/runbooks/domain-move.md`; `tsx` added to the guest package, which `check:pay` also needed. Tests: `legacy-redirects.test.ts`, `domain-check.test.ts`, and the guest e2e "every old west4karaoke.com page answers". Cautious defaults: the old `/room` (the rooms page) collides with the new joined-guest room page, so without the room cookie it answers 302 to `/#rooms`, not 301, so no browser caches it. Gap: the data model's `domains` table is filled in phase 2 and doesn't exist, so there's no row to create; in phase 1 the domain is set by `SITE_VENUE`, `SITE_HOST` and `GUEST_APP_URL` (runbook). The old site is Wix with Google Workspace email; no DKIM record was found at the `google` selector. Listing the old URLs from West 4's own accounts isn't scraping; don't crawl anyone else's site. Spec gap: what happens to the old site's manage links; cautious default above, with no new text sent, since the 14 texts are fixed. Styles, section order and self-serve domains stay in phase 2.

### M9-10 · Train the team in training mode

- **Status:** blocked
- **Size:** S
- **Depends on:** M7-03, M7-04, M9-08
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Training mode; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · How we'll know it works; [Security and data retention](../spec/12-security-retention.md) 15
- **Build:** a practice checklist per role in `docs/trial/training-checklists.md`, each person in training mode on the real screens until theirs is done: bartenders the timed tasks (a walk-up beer in cash, a tab for a tapped phone with the consent line, another round, a close with a tip, taking over the terminal, accepting a room order, a void); the front desk check-in, a walk-in, a waitlist offer and a room close-out; managers approvals, drawer counts, Charge the remaining tabs and Close the night. New hires' phones use device training for their first shifts. Training is off for everyone before the first live night.
- **Acceptance:**
  - [ ] Each person's checklist is done. In person at the venue, after M9-08's PINs and badges; the sign-off table is in `docs/trial/training-checklists.md`.
  - [ ] Nobody is in training on the first live night, except a new hire's phone put in device training on purpose. `training:check` proves it (tested on the seed); run it before the first live night.
  - [ ] The first live night's Z report shows no practice check. The reconcile command's practice rule checks it; run after the first live night.
- **Tests:** none of its own; M7-03's tests cover the mode.
- **Notes:** Built: the per-role practice checklists and sign-off table in `docs/trial/training-checklists.md`, with the screens' own words; `pnpm --filter @west4/api training:check -- --venue <slug> [--allow-device "<name>"]` (`apps/api/src/ops/training-check.ts`, tested in `training-check.int.test.ts`), which names every person and device still in training mode and exits non-zero while any is, except devices named on purpose. Training mode itself is M7-03 and M7-04's; nothing in it changed. Waiting on the team's training sessions in the venue.

### M9-11 · Run the timed staff trial

- **Status:** blocked
- **Size:** M
- **Depends on:** M9-07, M9-10; M7-03 and M7-04 (training mode)
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Tests (Timed staff trial); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · How we'll know it works; [milestones](../milestones.md#m9--cutover-and-going-live) · M9 Ships (Training and the timed staff trial)
- **Build:**
  - The scripted 20-minute rush in `docs/trial/rush-script.md`, with the tasks and their targets: a walk-up beer paid in cash under 8 s; a tab opened for a tapped phone under 20 s, reading the consent line included; another round on a tab under 3 s; a tab closed with a tip under 20 s with the guest; taking over the terminal under 2 s; every room order accepted within 2 minutes; a drink rung by mistake voided under 6 s.
  - A rush driver that places the script's practice room orders on practice sessions at their times.
  - Tap and time capture in training mode only: taps, errors and seconds per task.
  - Three bartenders new to the system and a front-desk person run it in the venue, music on and hands wet, in training mode, and the results go in a table against the targets.
  - A missed target changes the design (a new ticket), not the target, and the trial runs again. The trial repeats after the first real Friday.
- **Acceptance:**
  - [ ] The staff trial meets its targets, or the design changed and the trial ran again. In person at the venue; needs the staging dry run first and the founder's answer on room orders in practice rooms (Notes).
  - [ ] The results, and the rerun after the first real Friday, are kept in `docs/gate/`. `trial:report --out docs/gate/staff-trial-<date>.md` writes them; nothing has run yet.
- **Tests:** a dry run of the rush driver and the capture in staging before the day.
- **Notes:** Built: the rush script and targets in `docs/trial/rush-script.md`; the capture in the staff app (`apps/staff/src/trial-capture.ts`, started by the shell only in training: each tap with the button's own words and the screen's path, the errors a screen showed, and a badge take-over's two moments) sent to `POST /v1/venues/{v}/trial-events` (`apps/api/src/routes/trial.ts`, 403 outside training) into `trial_events` (migration 0128, row-level security forced); the rush driver `pnpm --filter @west4/api rush:drive` (`apps/api/src/ops/rush.ts`: the script's 14 room orders over 20 minutes, one-tap items from the venue's own menu, joined and ordered through the guest routes); and `pnpm --filter @west4/api trial:report` (`apps/api/src/ops/trial.ts`), which finds each task by its buttons' words in English or Spanish from the catalog, times room orders from placed to accepted, and writes the table against the targets. Tests: `trial.test.ts`, `trial-capture.test.ts`, `trial.int.test.ts`. A target counts as met only when every run is under it (cautious). Contradiction found: M7-03 doesn't let a phone or tablet join a practice session at a real venue (only a test venue), so the driver's room orders can't reach West 4's practice rooms; the wall was kept, the driver works on a test venue (the staging dry run), and the founder decides (spec 14's training-mode question now says so). The task rules are first guesses checked by the staging dry run; the report lists each window's taps so a missed rule shows. Spec gap: the targets table has no front-desk tasks, though a front-desk person runs the trial; cautious default: time their check-ins, walk-ins and close-outs as a baseline, and judge only the listed targets.

### M9-12 · Review every staff screen in Spanish

- **Status:** todo
- **Size:** S
- **Depends on:** the staff screens of M1 to M8
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Languages; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · rules 11 and 12; [Testing and operations](../spec/13-testing-operations.md) · Tests (Language tests); [glossary](../glossary.md#other-exact-sentences)
- **Build:** a Playwright run that screenshots every staff screen and state in Spanish at phone and desktop sizes; a fluent Spanish speaker checks each one, and a Spanish list of the glossary's fixed sentences is kept beside the string catalog so each is said one way everywhere; fixes are merged, and the language test passes.
- **Acceptance:**
  - [ ] The reviewer signs off every staff screen.
  - [ ] No staff string is missing in Spanish, and no Spanish text is cut off at its longest.
  - [ ] Each fixed sentence, such as "Ask the room to wait" and "Charge the remaining tabs", reads the same in Spanish on every screen.
- **Tests:** the screenshot run and the language test in CI.
- **Notes:** Menu items keep their menu names.

### M9-13 · Collect the gate sign-offs and apply them

- **Status:** todo
- **Size:** M
- **Depends on:** nothing to start; the requests go out on day one
- **Spec:** [Open technical questions](../spec/14-open-questions.md) (the ten marked "gate"); [milestones](../milestones.md#the-go-live-gate) · the go-live gate, item 2; [decisions](../decisions.md) (how a decision is recorded)
- **Build:** for each of the ten questions marked gate, the answer in writing:
  - The accountant: whether room time, damage fees, kept deposits and no-show charges are taxable, the gratuity exempt, and each kept deposit on its own check number; and which business date gets after-midnight sales on the nights a sales-tax quarter ends.
  - The lawyer: how drinking-up time is measured; whether NYC's junk-fee rules cover the automatic gratuity; whether gratuity refunded after a pool was paid comes off the next pool; which occupations share tips at West 4 and in what shares, and whose job the tip-credit check is; whether the room gratuity may be pooled by hours; how long ID scans may be kept and shared; and who tells whom after a breach.
  - The PCI assessor: which validation we file, and what script-protection confirmation we give venues.
  - Each answer is recorded as a decision row and closed in Open technical questions, then applied as a settings change, a new rule-pack version (two approvers) or a ticket when it needs code, switching away from the cautious default where the answer differs.
- **Acceptance:**
  - [ ] All ten sign-offs are in and recorded.
  - [ ] Each cautious default built in M2 to M8 either stands by its answer or has been changed.
  - [ ] Gate item 2 is marked met in `docs/gate/`.
- **Tests:** the tests of whatever setting, rule-pack version or code each answer changes.
- **Notes:** Apply the answers as given; the owner has verified the legal conclusions, so don't re-check them.

### M9-14 · Prove every must-fix item closed

- **Status:** todo
- **Size:** S
- **Depends on:** M7-20, M8-24, and the sign-off tickets of M1 to M6
- **Spec:** [milestones](../milestones.md#must-fix-items-and-where-they-close) · Must-fix items and where they close; [milestones](../milestones.md#the-go-live-gate) · the go-live gate, items 1 and 4
- **Build:** a must-fix tracker in `docs/gate/must-fix.md`: GA-M1 to GA-M11, each with the milestone that closes it, the evidence that milestone passed its done-when (tests, drill reports, sign-off tickets) and the date. M7-20 and M8-24 fill their rows. M8-07's outage drill report is linked for gate item 4.
- **Acceptance:**
  - [ ] Every row from GA-M1 to GA-M11 is closed, with its evidence linked.
  - [ ] Gate items 1 and 4 are marked met.
- **Tests:** a link check over the tracker's evidence links.
- **Notes:** —

### M9-15 · Check every live night for money errors

- **Status:** todo
- **Size:** M
- **Depends on:** M7-13, M7-14, M7-15, M7-19 (the reconcile script)
- **Spec:** [milestones](../milestones.md#the-go-live-gate) · the go-live gate (a money error); [Money rules](../spec/05-money-rules.md); [money cases](../../seed/money-cases.json)
- **Build:**
  - A nightly money audit in production after each close and each payout, built on M7-19's reconcile script: every check's lines, tax and gratuity recomputed through `packages/rules` and compared with the stored lines; the Z report against the checks; each drawer's count against its moves; the tip ledger and shares against the pool; each payout's lines and its journal; every refund against its cap; every payment against its check, so a double or missed charge shows; the card fee (off at West 4).
  - A money-error log in `docs/gate/money-errors.md`: the night, what differed and by how much, the cause, the fix and who signed it off.
  - A morning summary to the founder and West 4's owner.
- **Acceptance:**
  - [ ] In staging, a tax line a cent off, a double charge, a refund over its cap and a drawer count that doesn't reconcile are each caught and logged as money errors.
  - [ ] A clean night reports none.
  - [ ] The audit covers every amount the definition names: charged, refunded, tipped, taxed, paid out and reported.
- **Tests:** seeded-fault tests for each kind of money error; money-cases, every group, through the recompute.
- **Notes:** —

### M9-16 · Go live, with on-call covering every opening hour

- **Status:** todo
- **Size:** M
- **Depends on:** M9-06 to M9-15; M8-17 (paging and the second responder); M8-22 (texts live)
- **Spec:** [milestones](../milestones.md#m9--cutover-and-going-live) · M9 Ships (Live nights); [Testing and operations](../spec/13-testing-operations.md) · On call; [Scope and architecture](../spec/01-scope-architecture.md) · When our cloud is down (the go-live checklist); [Stripe setup](../spec/06-stripe-setup.md) 3 and 11
- **Build:**
  - A go or no-go checklist in `docs/runbooks/go-live.md` for the day before: M4-29's go-live checklist again (the merchant category, each manager's Stripe Dashboard login and Tap to Pay phone), the hardware (M9-07), everyone signed in (M9-08), texts live (M8-22), the dry run signed (M9-06), the staff trial passed (M9-11), the Spanish review (M9-12), the sign-offs (M9-13), and the outage drill (M8-07).
  - The cutover: the old booking form off, the final delta import, the domain move (M9-09), and West 4's old system taking no new sales.
  - The first live night with the founder at the venue and on-call on the phone.
  - An on-call rota covering every opening hour for the whole gate (4:00 PM to 4:00 AM on weekdays, 2:00 PM to 4:00 AM on weekends, through each night's close), each shift with a named first and second responder.
  - A rollback plan for the first nights.
- **Acceptance:**
  - [ ] The go or no-go checklist passes the day before the first live night.
  - [ ] The first live night closes with a Z report that M9-15 finds clean.
  - [ ] The rota covers every opening hour of the 4 weeks with a first and a second responder.
- **Tests:** a test page to each responder at the start of the rota.
- **Notes:** Spec gap: what happens to West 4's old point-of-sale system at cutover isn't said; cautious default: it takes no new sales from the first live night and stays read-only for lookups during the gate.

### M9-17 · Run 4 weeks of live nights without a money error

- **Status:** todo
- **Size:** S (then the 4-week gate)
- **Depends on:** M9-13, M9-14, M9-15, M9-16
- **Spec:** [milestones](../milestones.md#the-go-live-gate) · The go-live gate; [milestones](../milestones.md#estimate) · Estimate (each money error adds up to 4 more weeks)
- **Build:** a gate tracker in `docs/gate/`: live nights since the last money error; a money error is fixed first and starts the 4 weeks again; a weekly summary to the founder and West 4's owner; the final gate report once all five gate items are met.
- **Acceptance:**
  - [ ] Every must-fix item is closed (M9-14).
  - [ ] Every gate sign-off is in (M9-13).
  - [ ] West 4's future bookings, deposits and guests are imported with nothing lost (M9-06).
  - [ ] The outage drill has passed (M8-07).
  - [ ] West 4 has run 4 weeks of live nights without a money error.
- **Tests:** none of its own.
- **Notes:** —

## Coverage

Every "Ships" item, done-when line and gate item that milestones.md gives M9, and where it lands. M9 adds no Admin sections and closes no must-fix item of its own; it proves them all closed (M9-14).

| From milestones.md | Tickets |
| --- | --- |
| Ships · Imports: future bookings with their deposits | M9-01, M9-02, M9-06 |
| Ships · Imports: guests with their consent evidence | M9-01, M9-03, M9-06 |
| Ships · Imports: the menu | M9-01, M9-04 |
| Ships · Imports: people and roles only, never PINs | M9-05 |
| Ships · Everyone's own sign-in | M9-08 |
| Ships · The domain move | M9-09 |
| Ships · Hardware installed and paired, with a cellular signal check at every pay point | M9-07 |
| Ships · Training and the timed staff trial | M9-10, M9-11 |
| Ships · A Spanish review | M9-12 |
| Ships · Live nights, with on-call covering every opening hour | M9-15, M9-16, M9-17 |
| Done when · An import dry run loses nothing | M9-06 |
| Done when · Before the first live night, everyone on West 4's team has set a new PIN | M9-08, M9-05 |
| Done when · The cellular signal check passes at both pay points | M9-07 |
| Done when · The staff trial meets its targets | M9-11 |
| Done when · Every old west4karaoke.com page redirects | M9-09 |
| Done when · The go-live gate below is met | M9-17, M9-13, M9-14, M9-15 |
| Gate · 1. Every must-fix item is closed | M9-14 |
| Gate · 2. The sign-offs marked "gate" are in | M9-13 |
| Gate · 3. Future bookings, deposits and guests imported with nothing lost | M9-06 |
| Gate · 4. The outage drill has passed | M9-14 (M8-07's report) |
| Gate · 5. 4 weeks of live nights without a money error | M9-17, M9-15 |
| Gate · What counts as a money error | M9-15 |

**Size:** 17 tickets: 8 S and 9 M, about 26 to 35 working days at the ranges' low and high ends, against the 2 weeks in milestones.md, then the 4-week gate.
