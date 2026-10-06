# M7 · Close the night and the books

Sep 29, 2026 · the backlog for [M7 · Close the night and the books](../milestones.md#m7--close-the-night-and-the-books), one ticket per Claude Code session. The [spec](../spec/README.md) says how each piece works, [screens](../screens.md) says where to build differently from the frozen canvas, and the checks use the [demo seed](../demo-seed.md)'s names and numbers. Paths follow the repo layout M1's first ticket creates (`apps/api`, `apps/staff`, `apps/desktop`, `packages/db`, `packages/rules`, `packages/shared`).

**Goal (usable when done):** Drawers counted, tips pooled, the Z report and exports reconciled, training mode.

**Done when** (from [milestones](../milestones.md#m7--close-the-night-and-the-books)):

- Two weeks of staging nights on the demo seed reconcile to the cent: every Z report matches the checks, both drawer counts, the tip ledger and Stripe's payouts, including one daylight-saving night.
- Night shows "3 slips not entered · tips post to Sat Sep 26" for the seed's three slips and won't close until every check passes or is fixed. "Print Z report" appears only after the close.
- The Z report's gratuity is 20% of room checks only: room time + room drinks + packages sold to rooms − room comps and refunds.
- A late tip posts to the current business date and points at its night, and a closed night never reopens.
- A training-mode check is numbered T-…, calls only Stripe's sandbox (a test shows a practice request can't reach the live key or a live reader), shows the band on every screen, and is absent from the Z report and every export.
- The accounting journal balances for every night and every payout, and the payroll export splits gratuity (wages) from tips.

**Depends on:** M6 (tabs and tips) and M4. **Size in milestones.md:** 2–3 weeks. The tickets below add up to more; see the size line at the end.

## Suggested order

1. **The base:** M7-01 (time clock) and M7-02 (closed nights and late postings). Everything later stamps its rows through them.
2. **Training mode early:** M7-03 and M7-04, so every report and export test from here on includes a practice check that must stay out.
3. **Drawers:** M7-05, then M7-06 and M7-07.
4. **Tips:** M7-08, then M7-09 and M7-10. M7-11 (the clock-out checklist) needs drops (M7-06) and declared tips (M7-08).
5. **Close the night:** M7-12, then M7-13.
6. **The books:** M7-14, then M7-15. M7-16, M7-17 and M7-18 can run beside them.
7. **Proof:** start M7-19 as soon as M7-14 and M7-15 land, because its two weeks run in real days; keep building while it runs. M7-20 closes the milestone.

Definition of done: see CLAUDE.md.

## Tickets

### M7-01 · Clock in with a duty, take breaks and build shifts

- **Status:** done
- **Size:** M
- **Depends on:** M1-24 and M1-25 (name and PIN, badges), M1-07 (audit triggers), M1-21 (string catalogs), M2-14 (the reason-only total), M2-15 (`manager_on_duty()` and its `duty_managers` stand-in), M6 (the bar POS top bar)
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Shifts; [Data model](../spec/04-data-model.md) · `time_punches`, `shifts`; [API](../spec/08-api.md) · Time clock; [Tenancy and access](../spec/02-tenancy-access.md) · The reason-only limit; [Money rules](../spec/05-money-rules.md) 2; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · What each module hides (Team, time clock & tips); screens [Pin](../screens.md#pin), [Staff](../screens.md#staff), [N24](../screens.md#n24-clock-in-duty-and-clock-out-checklist)
- **Build:**
  - Migration in `packages/db`: `time_punches (venue_id, id, membership_id, kind, duty, at, device_id, edited_by, reason)` with `kind` in `clock_in`, `clock_out`, `break_start`, `break_end` and `duty` in `bar`, `front_desk`, `runner`, `manager`; `shifts (venue_id, id, membership_id, business_date, duty, started_at, ended_at, break_minutes)`, one row per clock-in to clock-out, rebuilt from the punches in the same transaction. Row-level security, foreign keys that name the venue, audit triggers, and a partial unique index so a person has one open shift.
  - Routes in `apps/api`: `POST /shifts/clock-in {duty}`, `POST /shifts/break {start | end}` and `POST /shifts/clock-out` (M7-11 adds its checklist). They take a badge tap or name and PIN on a shared screen, or the person's own PIN on their phone. A shift's `business_date` is its clock-in's business date.
  - `shiftMinutes()` in `packages/rules`: elapsed time from clock-in to clock-out minus breaks, never wall-clock subtraction, so both daylight-saving nights count right.
  - Screens in `apps/staff`, English and Spanish: the duty picker at clock-in on Pin (shared screens and phones) with Bar, Front desk, Runner and Manager; Clock in and out on the staff phone with hours so far; "Maya · on break" in the bar POS top bar while a break is open (replace any stand-in M6 used).
  - Switch `reasonOnlyUsed()` (M2-14, $25 each and $75 a shift per person) from the business date to the person's open `shifts` row.
  - Switch `manager_on_duty()` (M2-15) to the open Manager-duty shift, and drop the `duty_managers` stand-in. With two managers clocked in, the latest accepted handover (M7-05) decides.
  - Bar-phone buzzes (M3-16's 30-second buzz and M3-17's no-bar-device buzz) go to bar-role people on the clock: bartenders, and the front desk while Admin lets it cover the bar. Phones of people not clocked in stop buzzing.
  - Seed loader: punches from the seed's `team[].shift`: Maya clocked in 4:00 PM on Bar, Andy 6:00 PM on Manager, Diego 7:00 PM on Front desk; Abhishek not on shift.
  - With Team, time clock & tips off, the time clock routes answer `404 module_off` and the clock leaves the menus and phone tabs.
- **Acceptance:**
  - [x] At 10:41 PM on the seed, Pin and the staff phone show Maya on since 4:00 PM (6h 41m), Andy since 6:00 PM (4h 41m) and Diego since 7:00 PM (3h 41m), and Abhishek not on shift.
  - [x] Clock-in is refused without a duty, and offers Manager only to Andy and Abhishek.
  - [x] Maya starts a break: every bar screen's top bar reads "Maya · on break" until she ends it, and her shift's `break_minutes` grows by the break.
  - [x] A second clock-in while a shift is open is refused.
  - [x] Maya's fix panel shows "$63 left this shift" from her open shift, and a new shift starts her at $75.
  - [x] With the stand-in gone, Andy's open Manager shift makes him the manager on duty, and Diego's void still reads "Waiting for Andy".
  - [x] A shift from 4:00 PM Sat Oct 31, 2026 to 4:30 AM Sun Nov 1 counts 810 minutes, and one from 4:00 PM Sat Mar 13, 2027 to 4:30 AM Sun Mar 14 counts 690; both belong to the Saturday's business date.
  - [x] With Team, time clock & tips off, every time clock route answers `404 module_off`.
- **Tests:** unit tests for `shiftMinutes()` (breaks, the 6:00 AM cutover, both daylight-saving nights); the principal and venue-wall suites over the new routes; money-cases group `reason_only_limits` with the shift as the basis; Playwright on phone and desktop sizes for the duty picker and "Maya · on break"; the language test.
- **Notes:**
  - Canvas: Pin never asks for a duty and shows 7:00 PM with "3h 00m so far" ([Pin](../screens.md#pin) notes 2 and 3).
  - Spec gaps: which roles may pick which duty isn't said; cautious default: the Manager duty only for owners and managers, any other duty for anyone. The API's event table has no shift event; write `shift.updated` so Night's "staff still on the clock" stays live, and add it to the table. Two managers on the clock at once isn't covered; the cautious default is above. M1-14 and M1-26 leave "when covering the bar" to the duty, but [Tenancy and access](../spec/02-tenancy-access.md) says permissions come from the role and the duty only feeds the tip pool; keep Admin's switch as the only gate for the front desk on the bar POS, and flag it.
  - Built (M7-01): migration `0092_shifts.sql` adds `shifts` (venue-named foreign keys to `memberships` and to the clock-in punch, `clock_in_punch_id` unique, partial unique index `shifts_one_open` so a person has one open shift, row-level security, audit trigger), a check that every clock-in punch carries its duty, and drops `duty_managers`. `time_punches` (0078) stays as it was. `packages/db/src/shifts.ts`: `recordPunch()` takes a per-person advisory lock, refuses a second clock-in, a break or clock-out off the clock and a break inside a break, writes the punch (a clock-out during a break ends the break first, same instant), rebuilds the shift from its punches in the same transaction and emits `shift.updated`; `openShifts()`, `rebuildShift()` (M7-11's punch edits call it). Punches at the same instant keep their written order through `created_at = clock_timestamp()`.
  - `packages/rules/src/shifts.ts`: `shiftMinutes()` (elapsed minus breaks, whole minutes, an open break counted to now; 810 and 690 minutes on the two daylight-saving nights), `splitShifts()`, `dutiesFor()`.
  - Routes (module `team`, principals owner_manager and staff): `GET /v1/venues/{v}/shifts` (who's on the clock, the signed-in person's shift and duties), `POST /shifts/clock-in {duty}` (201; 400 without a duty, 403 for Manager unless owner or manager), `POST /shifts/break {action: "start" | "end"}`, `POST /shifts/clock-out`; refusals are `409 version_conflict` with `details.refusal` (`already_on`, `not_on`, `on_break`, `not_on_break`). The punching person is the signed-in session, which came from a badge tap or name and PIN on a shared screen or their own PIN on their phone; the shared screen's device id is stamped when the request is signed. `GET /team/tiles` now carries each tile's open shift, and `GET /pos/terminal` adds `breaks` (everyone whose last punch is a break start), both only while Team, time clock & tips is on. `GET /shifts` and `shift.updated` are added to spec 08.
  - `reasonOnlyUsed()` now totals over the person's open shift (lines added since its clock-in); with no open shift it falls back to the business date, which can only be stricter. `managerOnDuty()` is the open Manager-duty shift of an active owner or manager; `managerOnDutyAt()` keeps its signature for its callers.
  - Bar-phone buzzes: M3-16's 30-second buzz and M3-17's no-bar-device buzz go to a new push audience `bar_on_clock` (bartenders, plus the front desk while its `pos.use` switch is on, each with an open shift), one job instead of one per role.
  - Seed: Maya (Bar, 4:00 PM), Andy (Manager, 6:00 PM) and Diego (Front desk, 7:00 PM) clock in through `recordPunch()` from `team[].shift`; `shifts` joins the wipe list.
  - Staff app: `TimeClock.tsx` (the panel and the phone's `/clock` tab, "Clock in and out", hidden with the module off). Pin's tiles read "On since 4:00 PM (6h 41m)" or "Not on shift"; a "Time clock" button on the shared Pin sends the next badge or name and PIN to the clock panel instead of home, and anyone not on the clock gets the panel with the duty picker after signing in ("Not now" goes home). Clocking out from the shared screen's clock panel locks the screen on Done. The bar POS top bar shows "Maya · on break" for everyone on break, whoever is signed in. Strings in English and Spanish.
  - Flagged defaults: Manager duty only for owners and managers (no spec rule). With two managers on Manager duty, the one who clocked in first stays manager on duty until M7-05's handover decides. Admin's front-desk `pos.use` switch stays the only gate for the front desk on the bar POS and for its buzzes (spec 02 says the duty only feeds the tip pool); a front-desk person on Runner duty still buzzes. The bar POS shows everyone on break, not only Bar duty, since the spec says "while someone is on break".
  - Tests: unit `packages/rules/src/shifts.test.ts`; integration `apps/api/src/routes/shifts.int.test.ts` (every acceptance line at the API), push resolution in `push.int.test.ts`, escalation and bar-presence tests updated to the one `bar_on_clock` buzz, `pin.int.test.ts` clocks Andy in instead of the stand-in; e2e "the time clock at 1280px / 390px" and "Andy's Clock in and out tab", `/clock` added to the Spanish fit check. Staging checks wait for M1-02.

### M7-02 · Guard closed nights and post late money to the next open night

- **Status:** done
- **Size:** S
- **Depends on:** M1-04 (business-date helpers), M1-07 (audit), M4-07 (`venue_counters`, including `z_report`), M4-21 (refunds with `adjusts_business_date`)
- **Spec:** [Money rules](../spec/05-money-rules.md) 2 and 16; [Data model](../spec/04-data-model.md) · `night_closes`, `venue_counters`, the money core; [Payment flows](../spec/07-payment-flows.md) · Bar tab with a growing hold 7, Refunds; screens [Night](../screens.md#night) note 1
- **Build:**
  - `night_closes (venue_id, business_date, z_number, closed_at, closed_by, totals, export_id)`, unique per venue and date, insert-only for `app_rw` (no update, delete or truncate); the Z number comes from M4-07's `z_report` counter.
  - `posting_business_date(venue, at)` in the database and in `packages/rules`: the business date of `at` (local time minus the 6:00 AM cutover), moved forward past any closed night. Every money, shift and drawer insert stamps `business_date` through it, M4-21's refunds included.
  - When a row belongs to an earlier night (a slip tip for a tab of that night, a refund of its check, a no-show charge, a kept deposit, money collected for a `capture_failed` tab), the same helper sets `adjusts_business_date` to that night.
  - A trigger on every table with `business_date` that refuses an insert dated to a closed night, so no route or job can reopen one.
  - `GET /nights/{date}` returns the date late money will post to, for "tips post to Sat Sep 26".
- **Acceptance:**
  - [x] At Sat 4:12 AM, before the close, Night computes "tips post to Sat Sep 26" for the three slips.
  - [x] After Fri Sep 25 closes at 4:48 AM, Dev S.'s slip tip entered at 5:10 AM waits for approval (entered more than 2 hours after signing) and, once approved, posts to Sat Sep 26 with `adjusts_business_date` Fri Sep 25.
  - [x] After the close, any insert dated Fri Sep 25 fails in the database, whatever route or job tries it.
  - [x] A refund approved on Sat Sep 26 against Room 9's paid check #1042 posts to Sat Sep 26 and points at Fri Sep 25.
  - [x] Tests that try to update or delete a `night_closes` row as `app_rw` fail.
- **Tests:** unit tests for the posting date across the cutover, on both daylight-saving nights, with zero, one and two closed nights in a row; database tests for the trigger on each table and for the grants; money-cases group `business_date`.
- **Notes:** Spec gap: Money rules 16 says late money posts to "the current business date" and Payment flows says "the next business date"; between the close and the 6:00 AM cutover they differ. Build the reading that keeps closed nights closed and matches the screen's words: the next open business date. Recorded as [D88](../decisions.md); Money rules 16, Payment flows · Refunds and API · Night close now say so.
  - Built (M7-02): migration `0093_night_closes.sql` adds `night_closes` (unique per venue and date and per venue and Z number, row-level security, audit trigger; `app_rw` gets select and insert only), `open_business_date(venue, date)` (the date, or the first after it that isn't closed), `posting_business_date(venue, at)` (local time minus the cutover, moved past closed nights), and the trigger `closed_night_guard` on all 19 tables with `business_date`: an insert dated to a closed night, or an update moving a row onto one, fails with SQLSTATE `W4N01`, which the API answers `409 version_conflict` with `details.reason: "night_closed"`. Rows already on a closed night can still change other columns (a refund's Stripe status, a shift's clock-out). It also grants `app_rw` update of a refund's two date columns.
  - `packages/rules/src/posting.ts`: `openBusinessDate()`, `postingBusinessDate()`, `latePosting()` (replaces M6-09's `tipPosting`). `packages/db/src/nights.ts`: `postingDate()`, `latePostingAt()`, `latePostsTo()`, `nightClose()`, `isNightClosed()`, `recordNightClose()` (takes the next `z_report` number and writes the row in the caller's transaction; M7-12's close calls it).
  - Stamping: the shared inserts stamp `business_date` through `open_business_date()` in SQL (payments, checks, check lines, computed lines, refunds, drawer sessions, staff banks, prepaid ledger, card-fee lines, the reconciler's external payments, shifts); where the table has `adjusts_business_date` and the date moved, it points at the closed night. Callers keep passing the business date of now, so this is `posting_business_date(venue, now)`.
  - Late money: a slip tip (M6-09) and the sweeper's captures (M6-17) post through `latePostingAt()`; settling a `capture_failed` tab posts to `postingDate()`; a refund posts to the posting date and points at its check's night (a deposit refunded before check-in, at its payment's); one asked before the close and approved after moves to the posting date, and its reversing lines carry `adjusts_business_date` too. Reopen (M6-12) is refused once the tab's night is closed, even before the cutover.
  - `GET /nights/{date}` adds `closed` (Z number, closed at, closed by) and `late_money_posts_to` (the first open date after the night, or today's posting date if later); "tonight" for it is the posting date, so after Friday closes at 4:48 AM, Saturday's night answers. The Night screen's "3 slips not entered · tips post to Sat Sep 26" line is M7-12's.
  - Jobs: the tab cut-off sweep and the clear-out check skip a closed night, so they never trip the guard after the close; `rebuildShift()` updates an existing shift instead of upserting (the insert trigger fires before `on conflict`), keeping a shift on its closed night, and stamps a new one through the posting date. `night_closes` joins the seed's wipe list.
  - Flagged: a new table with `business_date` (the tip ledger in M7-08, drawer moves if they get one) needs the trigger too; the integration test fails until it has it. `export_id` has no foreign key yet (exports arrive in M7-15) and, the row being insert-only, must be known at the close.
  - Tests: unit `packages/rules/src/posting.test.ts` (money-cases group `business_date`, the cutover, both daylight-saving nights, zero, one and two closed nights, `latePosting`); integration `apps/api/src/routes/night-closes.int.test.ts` (every acceptance line but the refund, Maya's clock-out after the close, the clear-out sweep, the trigger on each of the 19 tables as `app_rw` or the owner, update and delete and truncate refused, a second night in a row), `refunds.int.test.ts` (asked before the close and approved after; approved on Saturday), `tab-reopen.int.test.ts` (no reopen after the close). Staging checks wait for M1-02.

### M7-03 · Turn on training mode per person or per device

- **Status:** done
- **Size:** M
- **Depends on:** M1-31 (Admin → Team, `PATCH /team/{m}`), M1-15 (devices, `PATCH /devices/{d}`), M3-06 (the order pipeline), M3-13 (tickets), M4-07 (checks and the `check_training` counter), M4-19 (receipts), M6 (bar POS and tabs)
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 15; [Testing and operations](../spec/13-testing-operations.md) · Training mode; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Training mode; [Data model](../spec/04-data-model.md) · Training mode, the money core (`checks.training`); [API](../spec/08-api.md) · Conventions (Training mode); [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Training mode; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) rule 13; screens [N30](../screens.md#n30-training-band), [AdminDesk](../screens.md#admindesk) note 7
- **Build:**
  - Admin → Team → Training mode: per person (`memberships.training` through `PATCH /team/{m}`, in the owner's passkey session like the rest of Team) and per device for a new hire (`devices.training` through `PATCH /devices/{d}`). Off for everyone at West 4.
  - The API marks a request as training once, when the signed-in person or the device is in training, and every check it opens has `checks.training = true`, numbered from `venue_counters` `check_training` and shown as T-0012. A live caller can't add to a practice check and a trainee can't touch a live one (`403 forbidden`).
  - The band "TRAINING · not real money" on every staff screen while in training, in the app shell for phone and desktop, with no way to close it.
  - Tickets and receipts print TRAINING. Practice checks never text or email a guest: the text and email jobs refuse them.
  - The drawer never opens in training: no kick and no drawer move for practice cash; the cash panel still shows the change.
  - Views `live_checks`, `live_check_lines` and `live_payments` that every Z, tax, tip, export, report and reason-only query reads, and a CI lint that fails when report or export code reads the base tables.
  - Practice sessions (see Notes): in training, [+ Walk-in] opens a practice session on a free room that writes no `room_blocks` or `room_states` and shows only on screens in training; its orders ring only screens in training and print TRAINING tickets. Screens not in training never show practice sessions, orders or approvals.
- **Acceptance:**
  - [x] Abhishek turns on training for a new hire in Admin → Team. Her phone, and any shared screen she signs in on, shows "TRAINING · not real money", which can't be closed; the band leaves when Maya's badge takes over the bar computer.
  - [x] Her check is numbered T-… from its own counter, and the live counter (Room 9's #1042) doesn't move.
  - [x] A practice ticket and receipt print TRAINING, and a practice receipt can't be texted or emailed.
  - [x] A practice cash sale shows the change in large type, never kicks the bar drawer and writes no drawer move.
  - [x] A practice comp leaves the trainee's reason-only total untouched, and Maya still has "$63 left this shift".
  - [x] The live board still counts 8 rooms in use, 3 open, 2 cleaning and 1 out of service while a practice session is open.
  - [x] Turning training on for the bar computer makes everything rung there practice, whoever signs in.
  - [x] Money case `z_report_training_checks_left_out` passes: T-0012 never reaches the Z gratuity.
- **Tests:** a Playwright walk that fails if any staff route renders without the band in training (Board, Rail, Bar, DeskRoom, Room, Staff, Night); integration tests that insert practice checks and assert every report and export is unchanged; the principal suite for live and practice callers; print payload tests; the language test; money-cases group `z_report`.
- **Notes:**
  - Canvas: no board has a training state ([Board](../screens.md#board) note 20, [Rail](../screens.md#rail) note 20, [Room](../screens.md#room) note 8, [DeskRoom](../screens.md#deskroom) note 11, [Night](../screens.md#night) note 11). Don't build the "Demo: training mode" toggles.
  - Spec gap: the spec covers practice checks, payments, drawers, printouts and texts, but not practice room sessions, bookings, waitlist entries, room orders or approvals. Cautious default: a trainee can't check in a real booking, seat a real waitlist party or change a live room's state; practice sessions block nothing and are seen only in training; approvals from a practice check go to the manager like live ones, marked TRAINING in the Approvals inbox, and never count anywhere. Confirm with the founder before M9's staff trial.
  - Built (M7-03): migration `0094_training.sql` adds `room_sessions.training` and `approvals.training` (a before-insert trigger sets it from what the approval is about: a check, tab, order, payment or session), and the views `live_checks`, `live_check_lines` and `live_payments` (`security_invoker`, so row-level security still applies). The reason-only query moved to `packages/db/src/reports/reason-only.ts` and reads `live_check_lines`. The ESLint rule `west4-live/live-views-only` (`eslint-rules/live-views-only.js`) fails any SQL in a `src/reports` or `src/exports` folder of an app or package that reads `checks`, `check_lines` or `payments` after FROM or JOIN; M7-08 to M7-18 put their report and export code there.
  - The request is marked once (`apps/api/src/http/training.ts`, called from the conventions hook): the signed-in person's membership or any device the request came through (the device principal, the PIN or badge session's device, the signed device). The wall: a live caller gets `403 forbidden` (`details.reason: "training"`) for any practice check, session, tab, tab opening, order, payment or split, by route parameter or by a `check_id`, `session_id` or `tab_id` in a write's body; a trainee may read live work (the board, Room 9) but every write to it is 403. A trainee can't check in or no-show a booking, seat a waitlist party, change or clean a room, or sell song credits.
  - Practice checks: walk-ins, quick sales, tabs (the opening's hold payment carries the flag to the check it opens), a new room check after paying, and every payment on a practice check are practice, numbered from `check_training`. `GET /auth/me` adds `training` to each membership; `PATCH /team/{m}` takes `training` (passkey asked again, as before) and `GET /team` returns it; `PATCH /devices/{d}` takes `training` and emits `device.updated`. The shell shows the band in the app frame on phone and desktop with no close, and refreshes on `membership.changed` and `device.updated`.
  - Practice sessions: [+ Walk-in] in training takes a free (available) room only, writes no `room_blocks` or `room_states`, keeps no guest record and texts nobody; ending it writes no cleaning; it can't be moved. Live lookups by room (board, sessions list, headcount, faults, cleaning, room-tablet join, wrap-up texts) leave practice sessions out; a screen in training sees them on the board with `session.training`. Practice orders list only on screens in training and never escalate (no push, text or call to the manager).
  - Printouts: tickets print `TRAINING - NOT REAL MONEY` at the top and foot (ASCII); receipts and tab slips open with "TRAINING · not real money", and a practice receipt reads "Check T-0012". A practice receipt by text or email is 403 at `POST /checks/{c}/receipts`; `queueText` refuses a practice session's or check's text and the email job refuses a practice receipt at queue and send time.
  - Cash: a practice cash payment has no drawer session or staff bank, writes no drawer move and no kick; the panel still shows the change. A practice cash refund writes no drawer move.
  - Admin → Team: a Training mode column with a switch per person, and "Training mode on a device" listing the bar and front-desk computers and staff phones. Approvals inbox marks practice approvals TRAINING. The check-in sheet's done line shows T-0001 for a practice walk-in.
  - Rules: `packages/rules/src/z-report.ts` `zReportGratuity()` (sum of each room check's 20% line, bar tabs none, practice checks left out) passes money-cases group `z_report`, including `z_report_training_checks_left_out`; the Z report itself is M7-13's. `@west4/shared` `checkNumberLabel()` / `trainingNumber()` format T-0012.
  - Flagged: the seed has no `check_training` counter, so the first practice check is T-0001 (the spec's T-0012 is an example, not a seed fact). The spec gap above is built as written and added to the open questions (spec 14) for the founder before M9's staff trial; Data model · Training mode now names the views and the two flags. Card payments still go to the venue's Stripe connection until M7-04 routes practice to the sandbox.
  - Tests: unit `packages/rules/src/z-report.test.ts` (group `z_report`), `packages/shared/src/check-number.test.ts`, `apps/api/src/print/training.test.ts` (print payloads), `eslint-rules/live-views-only.test.js`; integration `apps/api/src/routes/training.int.test.ts` (every acceptance line but the band: T-0001 and the live counter, the live board's 8/3/2/1, the wall both ways, practice cash, receipts, comps and Maya's $63, approvals, the bar computer in training, the views), `team-admin.int.test.ts` (training on and off with the passkey); the security suites; e2e "training mode: the band on every staff route, at 1440 and 390, that can't be closed" (the band follows the signed-in session, so the badge handover is the same refresh; the walk checks it leaving when Maya's training goes off). Staging checks wait for M1-02.

### M7-04 · Send practice payments only to Stripe's sandbox

- **Status:** done
- **Size:** M
- **Depends on:** M7-03; M4-01 (the Stripe client, whose live or sandbox choice lives in one place), M4-02 (readers), M4-03 (webhook endpoints), M4-05 and M4-12 (the state machine and the reconciler); M6 (tab holds, tips on the reader)
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 5 and 15; [Stripe setup](../spec/06-stripe-setup.md) 4, 6 and 7; [Payment flows](../spec/07-payment-flows.md) · How every card payment runs, What staff see during a card payment; [Testing and operations](../spec/13-testing-operations.md) · Tests (training-mode tests)
- **Build:**
  - The sandbox side of M4-01's Stripe client, used only for payments with `payments.training = true`: sandbox restricted keys under their own secret names, West 4's sandbox connected account, and a sandbox Terminal Location with simulated readers. The live client refuses a practice payment before any request leaves the process, and the sandbox client refuses a live one.
  - In training, the reader picker lists only the simulated readers, and the server checks that a practice payment's `readerId` is a sandbox reader of that venue.
  - A training-only [Tap a test card] on the pay panel's waiting state, which presents a test card to the simulated reader through Stripe's test helpers, so trainees see the real card states.
  - A training webhook endpoint (for example `POST /v1/hooks/stripe/training`) with its own signing secret that accepts only test-mode events and applies them only to practice payments; the live endpoints keep refusing test-mode events. The reconciler runs a pass against the sandbox account for practice payments.
- **Acceptance:**
  - [x] A trainee's tap on a practice check runs on a simulated reader and shows the live states: "Waiting for a tap on the front-desk reader · Cancel", "Declined · try another card or cash", "Checking with Stripe · don't retry".
  - [x] A test that forces a practice payment through the live client fails before any network request, and CI's request log shows no call with a live key for any practice payment.
  - [x] A practice payment naming the live Bar S710's reader id is refused.
  - [x] A test-mode event at a live endpoint, or a live event at the training endpoint, is refused and logged.
  - [x] A practice bar tab opens a $50 hold on the sandbox, grows it as rounds are sent, and closes with a tip picked on the simulated reader.
- **Tests:** the "can't reach the live key or a live reader" test (network interception and key-prefix checks); sandbox flow tests with simulated readers; the webhook live-mode tests; a chaos test killing the API between the sandbox's success and our commit, adopted by the training reconciler pass.
- **Notes:**
  - Spec gaps: how a trainee "taps" on a simulated reader isn't said (the control above is the cautious default); the training webhook endpoint isn't in the API's list; add it there (done: spec 08 · Webhooks in and Conventions · Training mode, spec 06 · 6 and 7).
  - Built (M7-04): the sandbox is a second Stripe client (`apps/api/src/stripe/settings.ts` `loadStripeSandboxSettings`, `fakeSandboxSettings`) with its own restricted keys `STRIPE_SANDBOX_KEY_PAYMENTS`, `_REFUNDS`, `_REPORTING` and the training endpoint's secret `STRIPE_SANDBOX_WEBHOOK_SECRET_TRAINING` (`.env.example`, `infra/README.md`). A live key there is refused when the settings load; without sandbox keys the fake plays the sandbox locally (or wherever `STRIPE_API_BASE` names one) and anywhere else practice card payments are refused, never sent with the live keys. `stripeFromEnv()` (app and worker) attaches it to the live client; `StripeClient.forTraining(training)` is the one place a payment picks its side: a practice payment's calls go to the sandbox marked `training`. The live client refuses a marked call and the sandbox client an unmarked one or a live key, before any request (`StripeMisuse`). Every payment path picks its client and account from the payment's (or its check's) `training`: the tap run, check-status and cancel (`payments/run.ts`), the card-fee confirm, refunds, tab holds, raises, captures and the close's tip question (`tabs/open.ts`, `close.ts`, `saved-card.ts`), room cards, Terminal setup and reader health.
  - Migration `0095_training_stripe.sql`: `organizations.stripe_training_account_id` (the sandbox connected account; `stripe:create-account -- --org <id> --sandbox` makes it), `venues.stripe_training_location_id` and `stripe_training_terminal_config_id`, `devices.sandbox` (a simulated reader), `resolve_stripe_training_account()`, `ingest_stripe_event` resolving the training endpoint's venue only through the sandbox account (and the live endpoints only through the live one), and a trigger on `payment_allocations` that makes a payment on a practice check practice (only while it hasn't reached Stripe) and refuses one payment across a practice check and a live one, so a saved-card charge, walkout or share on a practice tab can't go live. No new table, so no closed-night guard is needed.
  - Readers: `readerOfVenue(c, v, d, training)` finds only sandbox readers for a practice payment and only live ones otherwise, so the live Bar S710 on a practice payment (or a simulated reader on a live one) is `404 not_found` and nothing reaches Stripe. `GET /readers` lists only the side the request is on (`practice` in each reader); `POST /readers` takes `practice: true` to register a simulated reader on the sandbox Location (anything not simulated is refused); `POST /readers/{r}/refresh` reads the reader on its side; Admin → Devices leaves the simulated readers out. `stripe:seed` now also makes West 4's sandbox account, its Location, and a simulated "Bar S710" and "Front desk S710" (`seedTrainingStripe`).
  - [Tap a test card]: `POST /v1/venues/{v}/readers/{r}/test-card` (`{ declined? }`, training only, a simulated reader of the venue only) presents Stripe's test card 4242 4242 4242 4242, or the generic decline 4000 0000 0000 0002, through Stripe's `present_payment_method` test helper on the sandbox. The pay panel's waiting state (`TapPayment`) and New tab's waiting state show [Tap a test card] and [Tap a declined test card] for a practice payment (`training` in the payment and opening views), English and Spanish. The tip on a practice tab's close is picked with Stripe's `succeed_input_collection` helper (the integration test does it; a trainee-facing control for it isn't drawn and is left out).
  - Webhooks: `POST /v1/hooks/stripe/training` checks its own secret, takes only test-mode events (in production too), listens to the reader, PaymentIntent and refund events, and the job applies them only to practice payments (`StripeEventContext.training`); the live endpoints never apply an event to a practice payment and keep refusing test-mode events in production. Every refusal is logged with the endpoint, event id and type only. The reconciler runs a training pass (`reconcilePass(…, true)`): practice payments' stale attempts, read from the sandbox account; it records no "unmatched" payments from the sandbox. The fake Stripe now plays the sandbox: its own keys, accounts made with them belong to it, a key never reaches the other side's account, and its events go to the training endpoint; its request log marks `sandbox` and `livePrefix`.
  - Cautious defaults: a pay link for a practice check is not found (online payments use the live Payment Element). Prepaid credit or another payment already at Stripe can't land on a practice check (the trigger refuses it).
  - Tests: unit `apps/api/src/stripe/training.test.ts` (the "can't reach the live key" test: intercepted network, live client refusing practice calls, the sandbox refusing live calls and live keys, key-prefix checks on the settings); integration `apps/api/src/routes/training-stripe.int.test.ts` (simulated readers on the sandbox Location and the reader picker; Waiting → test card → Paid with every request on the sandbox key and account; Declined; Checking with Stripe; the live Bar S710 refused with no request; the webhook livemode refusals logged; sandbox events only at the training endpoint and only on practice payments; the chaos test adopted by the training reconciler pass; a practice tab's $50.00 hold, raise and tip capture on the sandbox); the security suites (a wall case for the training endpoint); e2e "training mode: a trainee's tap runs on a simulated reader, declined then paid with a test card". The staging check against Stripe's real sandbox waits for M1-02 and the sandbox keys.
  - Smoke tests: four from M7-01 expected sign-in to land on Tonight for people who aren't on the clock; they now tap "Not now" on the time clock first. The guest bill test waits for the page's 10-second refresh when Present lands before the live socket connects.

### M7-05 · Count drawers blind and hand them over when the manager on duty changes

- **Status:** done
- **Size:** M
- **Depends on:** M7-01, M7-02; M4-13 (the two house drawers, their sessions opened at each business date's start with the starting bank, sale moves "Logged to Maya · bar drawer"); M2-15 (approvals on the approver's own phone); M1-11 (settings versions, read as they stood at a business date's start)
- **Spec:** [Money rules](../spec/05-money-rules.md) 15; [Data model](../spec/04-data-model.md) · `cash_drawers`, `drawer_sessions`, `drawer_moves`; [API](../spec/08-api.md) · Drawer; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `drawer` (`CashSettings`), When a change starts, the rule pack's `cash`; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Cash drawers at West 4; [Tenancy and access](../spec/02-tenancy-access.md) · Roles (count a drawer), Badges (cash counts ask for the PIN again); [decisions](../decisions.md) D21, D23; screens [Night](../screens.md#night) note 7, [Board](../screens.md#board) note 18, [AdminDesk](../screens.md#admindesk) note 9
- **Build:**
  - Opening stays as M4-13 built it: each house drawer's session opens at the business date's start with the starting bank ($300.00 at West 4), one open session per drawer, its model the `drawer` setting in force then.
  - `POST /drawer-sessions/{s}/count`: blind. The request carries only the counted cents; only the answer shows what the drawer should hold and the over or short. It asks for the PIN again even after a badge tap. Owners and managers count either drawer, bartenders the bar drawer, the front desk the front-desk drawer.
  - Expected cash = opening + cash in (sales with their cash tips, drops) − cash out (refunds, paid-outs, tip-outs), from `drawer_moves`. A difference over `drawer.noteOverCents` ($20 in the West 4 designs) needs a note; `drawer.secondCounter` (`never`, `whenOff`, `always`) asks a second person to count on their own sign-in (`witness_id`). Over or short stays on the session.
  - `POST /drawers/{d}/handover {incoming}`: for house drawers, counts each drawer blind, closes its session with the count and opens the next with the same cash, with the incoming manager as `responsible_id`. The incoming manager accepts on their own phone (`approved_by`), which makes them the manager on duty; until then the screens show "Waiting for Abhishek".
  - Night's drawer panel and the Board's drawer entry: both drawers, blind until counted, then opened with, cash taken, paid-outs, drops, should be, counted, over or short, note, who counted and the witness. `drawer.updated` events to Night and the front desk.
  - Admin → Cash drawers edits the `drawer` key: the model (house drawers or a drawer per person, with "Starts Sat Sep 26"), the starting bank, the note limit, the second counter, the paid-out amount that needs approval, and the per-person options (who has a drawer, count later). The rule pack's `cash.mustAccept` shows that cash can't be turned off. Save writes a new version checked against the rule pack.
- **Acceptance:**
  - [x] Both drawers open with $300.00 for Fri Sep 25, and Night lists "Bar drawer" and "Front-desk drawer", each answered for by Andy.
  - [x] Maya counts the bar drawer: the screen asks only for the count, and shows what it should hold and the difference only after she enters it. Diego can count only the front-desk drawer, Andy either.
  - [x] A count $25.00 short can't save without a note, and with the second counter on "whenOff" it also needs a second person's sign-in.
  - [x] Handing over from Andy to Abhishek counts both drawers blind, closes both sessions, opens two new ones with the counted cash, and waits on Abhishek's phone until he accepts. It can't be accepted on Andy's device.
  - [x] Counting asks for the PIN again after a badge tap.
  - [x] Switching to a drawer per person on Fri Sep 25 shows "Starts Sat Sep 26", and tonight's sessions stay house drawers.
- **Tests:** unit tests for expected cash from moves and for the blind answer's shape; a property test that expected cash always equals opening plus the signed sum of moves; integration tests for who may count which drawer, the PIN re-entry and the handover acceptance (never by the requester, never on the requester's device); Playwright for Night's drawer panel on desktop; the language test.
- **Notes:**
  - Canvas: Night and Board show one "House drawer" and a per-person demo with a bar drawer for Maya; build two house drawers and keep the per-person model behind the Admin switch ([Night](../screens.md#night) note 7, [Board](../screens.md#board) note 18). Don't build the "Demo:" links.
  - Spec gap: whether a house drawer's opening is counted isn't said. M4-13 opens it with the starting bank uncounted, so the night's first blind count is the handover or the close.
  - Spec gap: what starts a handover isn't said. Cautious default: the outgoing manager starts it from the Board, Night or their clock-out checklist; with no incoming manager, the drawers stay theirs until the close.
  - Seed gap: West 4's paid-out approval amount and second-counter rule aren't set. Cautious defaults until West 4 sets them: `paidOutApprovalCents: 0`, so every paid-out goes for approval, and `secondCounter: "whenOff"`.
  - Built (M7-05): rules `packages/rules/src/drawer.ts` (`drawerTotals`: opening + sales and drops − refunds, paid-outs and tip-outs; `checkCount`: a note past `noteOverCents`, a second counter on "always", or on "whenOff" past the same limit). Migration `0096_drawer_counts.sql`: `drawer_handovers` (one pending at a time, closed-night guard), `drawer_sessions.handover_id`, `shifts.on_duty_since`, approvals kind `drawer_handover`. Routes in `apps/api/src/routes/drawers.ts`: `POST /drawer-sessions/{s}/count`, `POST /drawers/{d}/handover`, and `GET /drawers` now lists each drawer's sessions for the business date (blind until counted), the people who may count, and whether this session gives the PIN again. `checkPinOf` in `routes/pin.ts` checks a second person's PIN on the same device with the same lockout ladder.
  - Accepting a handover runs on the incoming manager's own phone through the approvals route (never the requester, never the requester's device): the new sessions get `approved_by`, and their Manager shift's `on_duty_since` makes them the manager on duty (`managerOnDuty` now picks the latest `on_duty_since`, else the earliest clock-in). Someone not on the clock is clocked in with the Manager duty as they accept; someone on another duty is refused until they clock out of it. Declining gives the new sessions back to the outgoing manager.
  - Screens: `DrawerPanel` on Close the night and behind a "Cash drawers" button on the Board (anyone who may count; Hand over the drawers for owners and managers); Admin → Cash drawers (`screens/admin/CashDrawers.tsx`) edits the `drawer` key through Save and publish and shows "Starts Sat Sep 26" for a change, with the rule pack's cash.mustAccept note. English and Spanish.
  - Cautious defaults: once a count is entered it stands. A count that still needs a note or a second counter is kept on the session and the retry must carry the same number, so seeing the answer can't change the count (the spec doesn't say whether a recount is allowed). The second counter signs in with their own name and PIN on the same screen, and must be someone who may count that drawer. A passkey session (an owner or manager on their phone or desktop) counts without a PIN, since only PIN and badge sessions are asked again. A drawer counted tonight isn't reopened by the 5-minute sweep on the same business date. Seed defaults changed from M1-17's `secondCounter: "never"` and `paidOutApprovalCents: 2500` to this ticket's `whenOff` and `0`.
  - Tests: unit `packages/rules/src/drawer.test.ts` (expected cash, the property test, what a count needs); integration `apps/api/src/routes/drawer-count.int.test.ts` (every acceptance line at the API: $300.00 each for Andy, who counts which drawer, the PIN again after a badge tap, $25.00 short needing a note then a second counter, the handover waiting on Abhishek's phone and refused on Andy's device, "Starts Sat Sep 26"); the wall suite's bodies for the two new routes; e2e "Close the night: both drawers counted blind, the bar drawer $10.00 short".

### M7-06 · Take drops, paid-outs, no-sales and tip-outs at the drawer

- **Status:** done
- **Size:** M
- **Depends on:** M7-05; M4-13 (staff banks from cash taken on a phone, cash refunds as drawer moves, the drawer kick); M2-15 (approvals and `202 approval_pending`), M2-13 (`POST /files`)
- **Spec:** [Money rules](../spec/05-money-rules.md) 14 and 15; [Data model](../spec/04-data-model.md) · `drawer_moves`, `staff_banks`, `approvals` (`paid_out`), `files`; [API](../spec/08-api.md) · Drawer, Files; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Cash drawer; [Tenancy and access](../spec/02-tenancy-access.md) · Approvals, Badges; [glossary](../glossary.md#money-cards-and-cash) · Drop, paid-out and no-sale; screens [N21](../screens.md#n21-close-out-steps-and-card-states) (cash on a phone)
- **Build:**
  - `POST /drawer-sessions/{s}/drop`: hands a staff bank in at the drawer's own screen as a `drop` move, and sets `staff_banks.dropped_at` and `dropped_into_session_id`. The log reads "Logged to Diego · front-desk drawer".
  - `POST /drawer-sessions/{s}/paid-out {amount, reason, photo_file_id}`: cash out for an expense, with a reason and a photo of the receipt (`POST /files`, JPEG, PNG or HEIC up to 10 MB). Over `drawer.paidOutApprovalCents` it answers `202 approval_pending` (kind `paid_out`), the screen shows "Waiting for Andy", and the drawer opens only once it's approved.
  - `POST /drawer-sessions/{s}/no-sale {reason}`: asks for the PIN again, opens the drawer and logs a `no_sale` move with who and at which screen.
  - Tip-out: a manager records cash paid from a drawer to a named person as tips (PIN again), so the drawer's expected cash and that person's My tips agree (see Notes).
  - The drawer opens only for a cash payment, an approved paid-out or a no-sale, and every opening is logged against the open session and the person. Never in training (M7-03).
- **Acceptance:**
  - [x] Cash Diego took on his phone at a room close-out sits in his staff bank; he drops it at the front desk, the front-desk drawer shows the drop "Logged to Diego · front-desk drawer", and his bank reads $0.00.
  - [x] Andy's $42.00 ice-run paid-out with a photo of the receipt goes to Abhishek's phone (Andy's own requests go to the owner), and the drawer opens only after Abhishek approves.
  - [x] No-sale asks for the PIN again after a badge tap, then opens the drawer and logs it.
  - [x] A drawer kick with no cash payment, approved paid-out or no-sale behind it is refused.
  - [x] Each move shows on Night's drawer panel and moves the drawer's expected cash by its amount.
- **Tests:** integration tests for each move and its approval (never decided by the requester or on their device); kick tests through a network printer and a USB printer on the desktop app's print host; money-cases group `approvals`; Playwright for the paid-out photo step.
- **Notes:** Spec gaps: [Devices](../spec/09-devices-printing-offline.md) says the drawer opens for "an approved no sale", the milestone says "no-sale with the PIN", and `approvals` has no no-sale kind; build the PIN again and a reason, with no manager approval, and flag it. Tip-out is a move kind the spec never describes, and `drawer_moves` has no column for the person paid: add a nullable `paid_to` (an expand-only migration). Whether West 4 pays tips in cash at all, or only through payroll, is the founder's call; the build supports both.
- **Built (M7-06):**
  - Routes in `apps/api/src/routes/drawer-moves.ts`: `/drop` (the person's whole staff bank for the session's business date, which then reads $0.00), `/paid-out` (reason and a `paid_out_photo` upload required; over `drawer.paidOutApprovalCents` it answers `202` with an approval of kind `paid_out`, and the executor writes the move and opens the drawer only once approved; a session closed by then expires it), `/no-sale` (PIN again in a PIN or badge session, and a reason) and `/tip-out` (owners and managers, PIN again, `paid_to`). Each happens only at the drawer's own screen (the device paired to it), writes one move naming who and where, opens the drawer through its printer, and sends `drawer.updated`. None runs in training.
  - Migration `0097_drawer_moves.sql`: `drawer_moves.paid_to` (expand-only) and a trigger on `print_jobs` that refuses a drawer kick unless a cash payment or a drop, paid-out, no-sale or tip-out move of that venue is behind it, and refuses any reprint of one (`W4K01`).
  - `GET /drawers` adds the log of every move but sales (so the panel stays blind), `here` for the drawer this screen is paired to, and the caller's staff bank. The panel shows Drop my cash, Paid-out (with the receipt's photo), No sale and Tip-out at the drawer's own screen, and "Waiting for Andy C." after a paid-out over the limit. English and Spanish.
- **Decisions and defaults:** D89: a no-sale asks for the PIN again and a reason with no approval (as this ticket says), and drops and tip-outs also open the drawer, since cash goes in and out; spec 09 · Cash drawer updated. Who may take a paid-out or a no-sale: the people who may count that drawer (D21). A drop always hands in the whole bank. With West 4's paid-out limit at the cautious $0.00 (M7-05), every paid-out waits for approval.
- **Tests:** integration `apps/api/src/routes/drawer-moves.int.test.ts` (Diego's phone cash, his drop at the front desk and not on his phone; Andy's $42.00 paid-out to Abhishek, refused on Andy's phone and on the bar computer, the drawer opening only after approval; the no-sale's PIN after a badge tap; Andy's tip-out to Maya, refused for Maya; expected cash after each move; the kick with nothing behind it and the reprint refused in the database); the wall suite's bodies for the new routes; e2e "a paid-out with a photo of the receipt waits for Andy". The kick's transport (a network printer's CloudPRNT job, a USB printer through the desktop print host) is M4-13's and unchanged; its tests still pass. Training is refused through `request.training` (M7-03); no test drives a training device through these routes yet.
- **Founder's call:** whether West 4 pays tips in cash from a drawer at all, or only through payroll. The build supports both; nobody has to use Tip-out.

### M7-07 · Run a drawer per person with trays

- **Status:** done
- **Size:** M
- **Depends on:** M7-05, M7-06, M7-01
- **Spec:** [Money rules](../spec/05-money-rules.md) 15; [Data model](../spec/04-data-model.md) · `drawer_sessions` (`model`, `owner_id`, `tray_label`, `pulled_at`); [API](../spec/08-api.md) · Drawer (`/swap`, `/pull`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `drawer.perPerson`; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Cash drawer; screens [Night](../screens.md#night) notes 7 and 9, [Board](../screens.md#board) note 18
- **Build:**
  - With `drawer: "perPerson"` for the business date, each bartender (or bartenders and servers, per `perPerson.who`) opens their own session by counting in the starting bank (`POST /drawers/{d}/open` with `owner_id`). Only the owner takes cash into it, and the drawer opens only for them. Anyone without a drawer is told to hand the cash to someone who has one.
  - `POST /drawers/{d}/swap` at a shift change counts the session then, blind; or `POST /drawers/{d}/pull` pulls the tray (`pulled`, `pulled_at`, `tray_label`) to count at close while the next person counts in a fresh bank (`perPerson.countLater`).
  - Over or short stays on the owner's session. Night lists every session, pulled trays included, and M7-12's close waits for all of them.
- **Acceptance:**
  - [x] With Admin set to a drawer per person on Fri Sep 25, Sat Sep 26 opens that way and Fri Sep 25 stays house drawers.
  - [x] Maya counts in $300.00 on the bar drawer; Diego, covering the bar, can't take cash into Maya's session and is told to hand the cash to Maya or swap trays.
  - [x] With count later on, Maya pulls her tray at clock-out and Diego counts in a fresh bank; Night shows "Bar · Maya S. · tray pulled" until the tray is counted blind at close, and its over or short stays on Maya's session.
  - [x] The night won't close while a pulled tray is uncounted.
- **Tests:** integration tests for the swap and pull states and for the drawer opening only for the session's owner; a clock test that the model follows the setting in force at the business date's start; Playwright for the per-person path.
- **Notes:** Canvas: Night's per-person demo gives Diego a Staff role with cash sales and a reason-only comp; build Diego as Front desk, who can do both ([Night](../screens.md#night) note 9).
  - Built (M7-07): in `apps/api/src/routes/drawers.ts`, the model comes from the `drawer` setting in force at the business date's start. With a drawer per person the 5-minute sweep opens nothing; `POST /drawers/{d}/open { counted_cents, pin? }` opens the caller's own session with the bank they counted in (`owner_id`, PIN again in a PIN or badge session); a drawer already in use answers `409` until it's swapped or pulled. `POST /drawers/{d}/swap` counts the owner's session blind (the M7-05 count, with its note and second counter); `POST /drawers/{d}/pull { tray_label? }` (only with `perPerson.countLater`) marks it `pulled` with "Bar · Maya S.", and the tray is counted later with `POST /drawer-sessions/{s}/count` by its owner or a manager, the over or short staying on her session. Migration `0098_drawer_trays.sql` grants `tray_label`.
  - Only the owner takes cash into a per-person session: cash at the cash panel (`ownDrawerOnly` in `payments/cash.ts`, also song credits) and every drawer move refuse anyone else with `reason: "not_your_drawer"`, and the cash panel says "This is Maya's drawer. Hand the cash to Maya, or swap trays."
  - `recordNightClose` refuses while a pulled tray is uncounted (`UncountedTrays`); M7-12's checklist will list it. Night's panel shows "Maya S.'s drawer · Bar · Maya S. · tray pulled", with Count in the starting bank, Count it now and Pull the tray.
  - Cautious reading: who has a drawer of their own. `perPerson.who` names bartenders (and servers), but this ticket has Diego, Front desk, counting in at the bar when he covers it (the glossary says the front desk covers the bar on a bartender's break), so front desk counts too. Owners and managers don't open their own drawers.
  - Tests: integration `apps/api/src/routes/drawer-trays.int.test.ts` (the switch on Fri starting Sat and the sweep opening nothing; Maya counting in after a badge with her PIN; Diego and Andy kept out of her drawer; the pull, Diego's fresh bank, the close refused until the tray is counted $5.00 short on Maya's session); the wall body for `/swap`; e2e "a drawer per person: Maya counts in $300.00 and pulls her tray".

### M7-08 · Keep the tip ledger

- **Status:** done
- **Size:** M
- **Depends on:** M7-01, M7-02; M4-07 (gratuity lines), M4-20 ("Additional tip (optional)"), M4-13 (cash tips at the cash panel), M4-21 (refunds); M6 (tips on the reader, Tips to enter, tip review approvals, the sweeper)
- **Spec:** [Data model](../spec/04-data-model.md) · `tip_ledger`, `shifts`; [Money rules](../spec/05-money-rules.md) 9, 14 and 16; [Payment flows](../spec/07-payment-flows.md) · Bar tab with a growing hold 5–7, Refunds; [Security and data retention](../spec/12-security-retention.md) · How long we keep things (6 years); [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-M2
- **Build:**
  - `tip_ledger (venue_id, id, user_id, shift_id, business_date, adjusts_business_date, source, amount_cents, check_id, payment_id)` with `source` in `gratuity`, `card_tip`, `cash_tip`; insert-only, audited, under row-level security.
  - Rows written in the same transaction as the money they record: a room check's gratuity when the check is paid in full (the net of its gratuity lines, after any reversal); a card tip when its capture is recorded (a reader tip, a slip tip once approved, an additional tip by card); a cash tip when it's taken at the cash panel or declared at clock-out (M7-11). A refund's share of gratuity or a refunded tip writes a negative row.
  - Each row is credited to the staff member who collected it and their open shift. A row with no staff member (a guest's Pay my share completing the check, the 4:30 AM tab cut-off, the sweeper) has no user and still counts in its night's pool.
  - `business_date` and `adjusts_business_date` come from M7-02, so a slip tip entered after the close posts to the next night and points back.
  - Practice payments write nothing. Every screen and export labels the source "Gratuity", from the rule pack's `gratuity.label`.
- **Acceptance:**
  - [x] Paying Room 9's #1042 in full writes one gratuity row of $96.00, or $101.20 if o1 was accepted before the check was presented.
  - [x] Closing Jess P.'s tab with 20% on the reader writes a card tip row of $6.00 (the middle of $5.40, $6.00 and $6.60) on the shift of the person who closed it.
  - [x] A tip of $20.00 on Ana R.'s $62.50 slip waits for approval (over 25%) and enters the ledger only once approved.
  - [x] A refund of part of Room 9's check writes a negative gratuity row for that part on the refund's business date.
  - [x] For every closed night, the ledger's gratuity rows dated to it (adjustments of earlier nights aside) equal the Z report's gratuity.
- **Tests:** integration tests at each collection point; a property test that the ledger equals gratuity lines plus tips on payments for every simulated night; money-cases group `tips` (`tip_choices_t1`, `tip_review_over_25pct`, `tip_review_entered_late` and the rest).
- **Notes:** Spec gap: each ledger row names a person and a shift, but the spec doesn't say whose shift a gratuity or card tip is credited to before pooling. Cautious default above (the person who collected it, as the "daily log of the tips collected by each employee on each shift" reads); confirm with the founder.
  - Built (M7-08): migration `0099_tip_ledger.sql`, the `tip_ledger` table (insert-only, row-level security, audited, the closed-night guard) and triggers that run at commit, so each row is written in the money's own transaction and the payment's allocation to its check is there to read: a payment's tip once it's captured, or the difference when a captured tip changes (a slip tip entered or approved); a check's gratuity once it's paid (its gratuity lines, less what the ledger already holds for it, so a check paid again after a reopen isn't counted twice). The refund approval (`payments/refunds.ts`) writes a refund's share of gratuity and any tip it gives back as negative rows (`tip_ledger_reverse`), credited to whoever had the original row. Each row's date is the money's own business date moved past any closed night, keeping the payment's `adjusts_business_date` (Dev S.'s late slip tip posts to Sat Sep 26 pointing at Fri Sep 25).
  - Who it's credited to (the cautious default this ticket names): whoever the transaction runs for (`app.user_id`) and their open shift, or their shift on that night if they've clocked out; for a bar tab, whoever closed the tab (`tabs.closed_by`), since the capture runs in a job. A guest's Pay my share, the tip cut-off and the sweeper leave it empty. Confirm with the founder.
  - The acceptance's $20.00 slip is tested on Dev S.'s $48.00 tab (the slip tests' seed), not Ana R.'s $62.50; the rule is the same (over 25%). The "$101.20 if o1 was accepted first" case isn't a separate test: the row is the check's gratuity lines, whatever they hold.
  - Fix found here: a cash refund's drawer move was stored as a negative amount while expected cash also subtracts it, which would have raised what the drawer should hold. It's now stored as its size, like every other move.
  - Not here: the screens and exports that label the source "Gratuity" from the rule pack's `gratuity.label` are My tips (M7-10) and payroll (M7-16); cash tips declared at clock-out are M7-11.
  - Tests: integration `apps/api/src/routes/tip-ledger.int.test.ts` (Room 9's $96.00 gratuity and a $5.00 cash tip on Diego's shift; a refund's negative gratuity share and the $5.00 tip it gives back, credited to Diego; nothing for practice money; Friday's gratuity rows equal its gratuity lines, refunds included); ledger checks added to `tab-close.int.test.ts` (Jess P.'s $6.00 on the closer's shift), `tab-slip.int.test.ts` (nothing until the over-25% tip is approved) and `night-closes.int.test.ts` (the late slip tip on Saturday).

### M7-09 · Pool tips by hours with eligibility and shares by occupation

- **Status:** done
- **Size:** M
- **Depends on:** M7-01, M7-08; M1-31 (Admin → Team), M1-11 (settings versions)
- **Spec:** [Money rules](../spec/05-money-rules.md) 1 and 9; [Data model](../spec/04-data-model.md) · `memberships` (`tip_eligible`, `occupation_code`, `eligibility_set_by`, `eligibility_set_at`), `tip_pools`, `tip_pool_occupations`, `tip_shares`; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `pay.pool`, the rule pack's `gratuity` (`staffOnly`, `managersShare: false`, `eligibility: "dutiesWorked"`), When a change starts; [Tenancy and access](../spec/02-tenancy-access.md) · Roles (shares tips and gratuity); [decisions](../decisions.md) D8 and D22; [Open technical questions](../spec/14-open-questions.md); screens [Night](../screens.md#night) notes 1 and 2, [AdminDesk](../screens.md#admindesk)
- **Build:**
  - Admin → Team (owner only): per person, tip eligible or not and the occupation, saved with `eligibility_set_by` and `eligibility_set_at`. Owners and managers can't be made eligible: the rule pack's `managersShare: false` refuses the save with the reason. A change shows "Starts Sat Sep 26", and a pool reads eligibility as it stood when its business date started (the audit row holds the old value).
  - Admin → Card fee & gratuity: the pool method `pay.pool` (`hours` at West 4, `even`, `roomServer`), starting the next business date.
  - The occupation table: the eligible occupations and each one's `share_pct`, copied into `tip_pool_occupations` for each night. Empty shares mean one pool split by minutes across every eligible duty.
  - `tip_pools (business_date, method, status, exported_at)`: opened for each business date with the method in force at its start; `open` while the night runs, `closed` and final at the close (M7-12), `exported` and locked once a payroll export includes it (M7-16).
  - Shares in `packages/rules` and `tip_shares (pool_id, user_id, duty, minutes, gratuity_cents, card_tip_cents, cash_tip_cents)`: each source of the night's ledger is split on its own by largest remainder: by occupation share, then by eligible minutes in an eligible duty (`hours`); in equal shares among the eligible people who worked (`even`); or each room check's gratuity to its session's `server_user_id` and the rest by hours (`roomServer`). Owners and managers never share, whatever duty they clocked in with, and a Manager-duty shift never counts.
  - Late tips posted to this date that point at an earlier night (such as the three slips entered after Fri Sep 25 closed) are split by that earlier night's people and minutes, and written into this date's pool, so they reach the staff of the night they were earned and the closed pool never changes (see Notes).
  - Night's tips panel: gratuity from room checks, card tips and cash tips, the pool to share, and each person's hours and share, with "Not in the pool: Andy C., manager."
  - Gratuity refunded after its pool closed: a `pay` setting whose cautious default takes nothing from staff; the house absorbs it and Night lists it (see Notes).
- **Acceptance:**
  - [x] On the seed night Maya and Diego share, and Andy and Abhishek never do; Night reads "Not in the pool: Andy C., manager."
  - [x] Making Andy eligible in Admin → Team is refused with the reason.
  - [x] Money cases `tip_pool_by_hours_largest_remainder` (Maya 560 min and Diego 330 min split $1,000.01 as $629.22 and $370.79) and `tip_pool_three_equal_shares` pass through the pool code, not only `packages/rules`.
  - [x] Switching to `even` on Fri Sep 25 shows "Starts Sat Sep 26", and Fri's pool still splits by hours.
  - [x] For every pool and every source, the shares add up to the cent.
  - [x] On the fall-back night, a 4:00 PM to 4:30 AM shift counts 810 minutes in the pool.
  - [x] A practice tip never reaches a pool.
  - [x] The three slip tips entered on Sat Sep 26 go to Fri Sep 25's staff by Fri's minutes, recorded in Sat Sep 26's pool, and Fri Sep 25's pool is unchanged.
- **Tests:** unit tests for each method, occupation shares and largest remainder; property tests that shares always add up and equal minutes never differ by more than a cent; integration tests for eligibility as of the business date's start and for refusing managers; money-cases group `tips`.
- **Notes:**
  - Open questions for the lawyer, all gate items ([Open technical questions](../spec/14-open-questions.md)): which occupations share at West 4 and in what shares; whether the room gratuity may be pooled by hours given 146-2.18; whether gratuity refunded after a pool was paid comes off the next pool. Cautious defaults as settings: `pay.pool: "hours"` (the seed's value) with no occupation weights, and the new refunded-gratuity setting defaulting to the house absorbing it. Name the new key in Settings, rule packs and modules in the same change.
  - Spec gap: late tips post to the next business date, but the spec doesn't say whose pool they join, and shared among the next night's staff they could miss the people who earned them. Cautious default above; put it to the lawyer with the refunded-gratuity question.
  - `roomServer` needs `room_sessions.server_user_id`, which no phase 1 screen sets, so it falls back to hours for a session with no server.
  - Canvas: Night pools a gratuity taken on every sale and says no slips are waiting ([Night](../screens.md#night) notes 1 and 2). [Admin by milestone](../milestones.md#admin-by-milestone) gives `pay.pool` no Admin home; the canvas puts "Who gets tips and gratuity" in Card fee & gratuity, so it goes there.
- **Built (M7-09):**
  - Rules `packages/rules/src/tip-pool.ts`: `poolShares` (hours with optional occupation shares, even, roomServer; each source split on its own by largest remainder, a negative source by its size with the sign kept; owners, managers and Manager-duty shifts left out) and `poolMinutes` (real minutes, so the fall-back night's 4:00 PM to 4:30 AM is 810).
  - Migration `0100_tip_pools.sql`: `tip_pools` (one per business date), `tip_pool_occupations`, `tip_shares` (insert-only, refused once the pool isn't open, with `for_business_date`). App code never deletes, so an open pool is worked out live and its shares are written once by `closePool` (`apps/api/src/tips/pool.ts`), which M7-12's close will call.
  - `GET /nights/{date}/tips` (owners and managers): the sources, each person's minutes and share, "Not in the pool", and gratuity the house absorbed. Each person counts with their eligibility and occupation as they stood when the date started (later changes are walked back through the audit rows). Late tips posted to a date and pointing at an earlier night are split by that night's people, minutes and method, and recorded in this date's pool; the closed night's stored shares never change.
  - Admin → Team: a Tips column (owner only, through the passkey step-up): eligible or not and the occupation, with "Saved. It starts Sat Sep 26."; owners and managers read "Never shares", and the API refuses making one eligible (`reason: "managers_share"`, from the rule pack's `gratuity.managersShare`). Admin → Card fee & gratuity: "Who gets tips and gratuity", the pool method (with "Starts Sat Sep 26" for a change) and the refunded-gratuity setting. Night's tips panel (`TipsPanel`). English and Spanish.
- **Cautious defaults (the lawyer's open questions):** `pay.occupations` (new, empty: one pool by minutes) and `pay.refundedGratuity` (new, "house": a gratuity refunded after its night closed comes off nobody's share and Night lists it), both named in spec 03. The occupation shares have no editor yet; Admin shows them, and they're set in the `pay` key until the lawyer says which occupations share. `roomServer` gives a room's gratuity to its session's `server_user_id`, which no phase 1 screen sets, so in practice it falls to hours; the pool code passes no room servers yet.
- **Tests:** unit `packages/rules/src/tip-pool.test.ts` (both money cases, managers left out, occupation shares, even and roomServer, a negative source, the property test that every source adds up and equal minutes never differ by more than a cent, 810 minutes on the fall-back night); integration `apps/api/src/routes/tip-pool.int.test.ts` (Maya and Diego share Friday by minutes and Andy is "manager"; a practice tip stays out; `even` saved on Friday starts Saturday and Friday splits by hours; late slip tips on Saturday split by Friday's people in Saturday's pool while Friday's closed pool is unchanged and refuses a new share; the money case through the pool, 560 and 330 minutes splitting $1,000.01 as $629.22 and $370.79) and `team-admin.int.test.ts` (a manager refused with the reason; who set eligibility recorded); e2e "Close the night: the tips panel shares between Maya and Diego, never Andy".

### M7-10 · Show each person My tips with the 146-2.17 records

- **Status:** todo
- **Size:** S
- **Depends on:** M7-09
- **Spec:** [API](../spec/08-api.md) · Time clock (`GET /me/tips`); [Data model](../spec/04-data-model.md) · `tip_ledger`, `tip_shares`, `tip_pool_occupations`, `shifts`; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · What each module hides (My tips); [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-M2; screens [Staff](../screens.md#staff)
- **Build:** `GET /me/tips?from=&to=` returns only the caller's own records: their shifts (date, duty, clock-in and out, breaks, hours); the tips they collected by shift (their ledger rows, declared cash included); their share of each night's pool (gratuity, card tips and cash tips apart); each pool's eligible occupations and shares; and late tips with the night they belong to. My tips on the staff phone's Tips tab, in English and Spanish. Records go back 6 years.
- **Acceptance:**
  - [ ] After Fri Sep 25 closes, Maya's My tips lists her Bar shift from 4:00 PM, her hours and her shares of Fri Sep 25's pool; once the three slips are entered on Sat Sep 26, her share of them shows as "for Fri Sep 25 · posted Sat Sep 26".
  - [ ] Diego can't read Maya's records.
  - [ ] Andy's My tips shows his shifts and says managers don't share.
  - [ ] Gratuity and tips are separate lines, and the gratuity reads "Gratuity".
- **Tests:** the principal suite; Playwright at phone size; the language test.
- **Notes:** The 146-2.17 records follow what the data model keeps: a daily log of each person's tips by shift (declared cash included), the eligible occupations and their shares, and what each person got from the pool by date.

### M7-11 · Walk the clock-out checklist, and edit punches with a reason

- **Status:** todo
- **Size:** M
- **Depends on:** M7-01, M7-05 (the handover), M7-06 (drops), M7-07 (count your own drawer), M7-08 (declared cash tips); M6 (`tabs.owner_id`, `order_drafts`, `POST /tabs/{t}/hand-over`)
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Shifts; [API](../spec/08-api.md) · Time clock, Bar tabs (hand-over); [Data model](../spec/04-data-model.md) · `time_punches`, `tabs`, `order_drafts`, `staff_banks`; [decisions](../decisions.md) D68; screens [N24](../screens.md#n24-clock-in-duty-and-clock-out-checklist), [Pin](../screens.md#pin) note 2, [AdminDesk](../screens.md#admindesk)
- **Build:**
  - `POST /shifts/clock-out` answers with what's left, each line linked to its fix, and finishes only when the list is clear: hand over open tabs to someone still on the clock (`POST /tabs/{t}/hand-over`; build it here if M6 didn't); hand over unsent drinks; make a cash drop of the staff bank, or count your own drawer (a drawer per person only); declare cash tips (any amount, $0.00 included, written as a `cash_tip` ledger row). The manager on duty's list also asks for the drawer handover when another manager is on.
  - `PATCH /punches/{p}`: owners and managers change a punch's time with a reason, in a passkey session; the old time stays in the audit log and the shift is rebuilt.
  - Admin → Team gains "Time clock · tonight": the night's punches with Edit.
- **Acceptance:**
  - [ ] Maya's clock-out lists her 3 open tabs (Hana K., Jess P. and Luis M.) and won't finish until each goes to someone still on, such as Diego.
  - [ ] Diego's clock-out lists Tariq A.'s and Seat 6's tabs and his unsent 1 × Red Bull on Tariq A.'s tab.
  - [ ] Cash in a staff bank must be dropped into a drawer before the clock-out finishes.
  - [ ] Declaring $0.00 is recorded; declaring $15.00 writes a cash tip row on Maya's shift.
  - [ ] Andy moves Diego's clock-in from 7:00 PM to 6:55 PM with a reason: Diego's hours change and the audit log keeps 7:00 PM. An edit without a reason, or from a PIN session, is refused.
- **Tests:** integration tests for each checklist line and its fix; the principal suite for punch edits; Playwright on phone and desktop sizes; the language test.
- **Notes:**
  - Canvas: Maya clocks out with 3 open tabs on the canvas ([Pin](../screens.md#pin) note 2).
  - Spec gaps: how unsent drinks are handed over (cautious default: each draft moves to the person taking its tab and is never sent by itself); who may edit whose punches (cautious default: owners and managers, never their own, so a manager's own go to the owner).

### M7-12 · Build Close the night: the checks before closing and the close

- **Status:** todo
- **Size:** L
- **Depends on:** M7-01, M7-02, M7-05, M7-07, M7-09, M7-11; M3-23 (the clear-out check); M6 (Charge the remaining tabs, the 4:30 AM tab cut-off, Tips to enter, `capture_failed` tabs); M2-25 (waitlist), M2-19 (cleaning), M2-15 (approvals)
- **Spec:** [API](../spec/08-api.md) · Night close; [Money rules](../spec/05-money-rules.md) 5 (clear-out check) and 16; [Payment flows](../spec/07-payment-flows.md) · Bar tab with a growing hold 6 and 7; [Data model](../spec/04-data-model.md) · `night_closes`, `clear_out_checks`, Tabs at the cut-off and at close, `order_drafts`, `menu_items.out_until`; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · Charging the remaining tabs, rule 5; [decisions](../decisions.md) D75, D77; screens [Night](../screens.md#night), [N17](../screens.md#n17-clear-out-check), [N26](../screens.md#n26-tips-to-enter); [demo seed](../demo-seed.md#later-tonight)
- **Build:**
  - `GET /nights/{date}` lists the checks before closing, each with a link to its fix. They block the close: open rooms; open or tipping bar tabs; staff still on the clock; open waitlist entries; ringing or asked-to-wait orders; pending approvals; rooms still cleaning; unsent drinks; the clear-out check; every drawer counted (both drawers, pulled trays included). Shown but not blocking: paper slips not entered ("3 slips not entered · tips post to Sat Sep 26") and `capture_failed` tabs with their balances.
  - Night in `apps/staff` (desktop, owners and managers, English and Spanish): the checks; the open bar tabs with totals and cards and [Charge the remaining tabs], M6's route, with one confirmation that shows how many cards and the total and skips tabs waiting on an approval; the clear-out prompt ("Walk every room and the bar · no drinks left out"); the drawers (M7-05); the tip pool (M7-09); the report (M7-13); the link to Unmatched payments (M7-14); and a place for M8's "Review after outage".
  - `POST /nights/{date}/close` for an owner or manager, after one confirmation: it runs every check again in one transaction, takes the next Z number, writes `night_closes` with the Z totals, closes the tip pool, clears any unsent drafts left, 86'd items (`out_until`) and the Closed tonight list, ends the reopen window for settled tabs, posts the night's journal (M7-15) and sends a `night.closed` event.
  - Nothing reopens a closed night (M7-02's guard).
  - With Team, time clock & tips off, the clock check drops out.
- **Acceptance:**
  - [ ] At Sat 4:12 AM (business date Fri Sep 25), Night lists the nine checks of the seed plus open rooms and tabs, each linking to its fix: "Pending approvals · 1" opens Diego's void in Andy's inbox, and "Staff still on the clock" opens each clock-out.
  - [ ] "3 slips not entered · tips post to Sat Sep 26" shows for Dev S., Tom W. and Ana R. and doesn't block the close.
  - [ ] The clear-out check is due at 4:30 AM, [Done] records "Clear-out check · Andy · 4:31 AM", and the close is refused until then.
  - [ ] While anything blocking is open, the close is refused with each failing check named; once all are fixed it succeeds and Night reads "Night closed · 4:48 AM".
  - [ ] "Print X report (running)" shows until the close, and "Print Z report" only after it.
  - [ ] After the close, Hoegaarden, Casamigos Blanco and Casamigos · bottle are no longer 86'd and Closed tonight is empty.
  - [ ] A `capture_failed` tab doesn't block the close and stays on the manager's list with its balance until it's settled.
  - [ ] Rooms and bar tabs are counted apart.
- **Tests:** integration tests for each check; the seed's `night_close` scenario as a Playwright test on desktop size, driving the seed from 10:41 PM to Sat 4:48 AM on the simulated clock (every room paid, the tabs charged, Diego's void decided, the three slips left waiting, everyone clocked out, both drawers counted blind, the clear-out done by Andy at 4:31); clock tests on a normal night and both daylight-saving nights; a race test where two managers close at once and one wins; the language test.
- **Notes:**
  - Canvas: Night checks only rooms, tabs and the drawer and says no slips are waiting (note 1), offers "Print Z report" before the close and counts bar tabs as rooms (note 3), runs to about 1:20 AM (note 4), says "Last call" (note 5), has no clear-out check (note 6) and no capture-failed list (note 12), all in [Night](../screens.md#night).
  - Spec gaps: whether the closing manager must be clocked out first ("no staff on the clock"); cautious default: the manager closing the night is exempt, and the close clocks them out at the close time. Whether the close asks for the PIN again; cautious default: yes, like cash counts. `night.closed` isn't in the event table; add it. The API's close conditions leave out unsent drinks, while Night's checks list them and the data model clears drafts at the close; cautious default: unsent drinks block until each is sent or discarded, and the close clears any left.
  - Open question: drinking-up time sets the 4:30 AM clear-out (lawyer, gate); it's M3's setting, read here.

### M7-13 · Print the running X report and the Z report

- **Status:** todo
- **Size:** L
- **Depends on:** M7-12, M7-05, M7-09, M7-03; M4-07 (check revisions, tax and gratuity lines), M4-09 (deposits and forfeit lines), M4-21 (refunds); M6 (tabs)
- **Spec:** [Money rules](../spec/05-money-rules.md) 8, 9, 11, 15 and 16; [API](../spec/08-api.md) · Night close (`GET /nights/{date}/report`); [Data model](../spec/04-data-model.md) · the money core, `night_closes`, `drawer_sessions`, `print_jobs`; [decisions](../decisions.md) D76, D77; screens [Night](../screens.md#night) notes 2, 3, 10 and 11; [demo seed](../demo-seed.md#later-tonight); [money cases](../../seed/money-cases.json)
- **Build:** one report function in `apps/api` over the `live_*` views, using `packages/rules` totals and never a percent of sales:
  - Sales: room time; drinks split into Room checks and Bar tabs; packages sold to rooms; songs; damage fees; kept deposits and no-show charges (`fee` checks and `forfeit` lines); minimum-spend lines; the card surcharge (off at West 4); comps and voids; refunds; net sales.
  - Tax by jurisdiction and rate (8.875%), with its taxable base, from the tax lines.
  - Gratuity: the sum of the gratuity lines on the checks that carry one, which at West 4 are room checks only.
  - Payments: deposits allocated at check-in, deposits kept, card payments by way (tap, card on file, Pay my share), cash, card and cash tips, refunds and the card total; deposits held for guests (taken today for later nights, refunded, still held).
  - The tip pool (M7-09) and each drawer session: opening, cash taken, paid-outs, drops, tip-outs, count, over or short and note.
  - Exceptions: every comp, void and refund with time, room or tab, what, why, who asked, who approved and amount.
  - Adjustments: late lines and payments posted to this date that point at earlier nights.
  - Rooms and bar tabs counted apart, and the night's log in time order, in plain words from the audit log, agreeing with the Board (Room 4 out of service since Tue).
  - Times with EDT or EST on both daylight-saving nights.
  - `GET /nights/{date}/report` runs on the replica as the running X report until the close, then returns the Z report from `night_closes.totals`, never recomputed.
  - "Print X report (running)" and "Print Z report" print on the front-desk receipt printer as print jobs of kind `x_report` and `z_report`, headed with the Z number, the date and who closed it; the PDF job makes the Z report's PDF for exports and email.
- **Acceptance:**
  - [ ] With the 8 occupied rooms and 5 bar tabs as if closed at 10:41 PM (money case `z_gratuity_room_checks_only`), the Z gratuity is $510.57, drinks read Room checks $1,031.00 and Bar tabs $219.00, and it is never $554.37 (20% of all sales).
  - [ ] Rooms 3 and 12 give $96.26 of gratuity, the sum of their lines, not $96.27 (`z_gratuity_sum_of_lines_vs_aggregate`).
  - [ ] Room 9 with one Jäger Bomb comped gives $93.60 of gratuity (`z_gratuity_comp_lowers_base`).
  - [ ] T-0012 is absent from every figure (`z_report_training_checks_left_out`).
  - [ ] The Z report's totals equal the night's check lines by category, the drawer sessions and the tip pool to the cent.
  - [ ] Slip tips entered on Sat Sep 26 show under Adjustments on Sat Sep 26's report, pointing at Fri Sep 25, and Fri Sep 25's Z report never changes.
  - [ ] The fall-back night's report shows EDT before 2 AM and EST after.
  - [ ] Printing a Z report before the close is refused.
- **Tests:** money-cases groups `z_report` (all four cases) and `tax_and_gratuity` through the report function; integration tests for the X-to-Z switch and for the snapshot never changing; print payload tests; the daylight-saving report test; Playwright for Night's report panel.
- **Notes:**
  - Canvas: Night's gratuity is 20% of every sale and its Z figures come from an older night ([Night](../screens.md#night) note 2); compute from the checks. The seed has no whole-night Z totals.
  - The done-when's "20% of room checks only: room time + room drinks + packages sold to rooms − room comps and refunds" describes the base; the figure is the sum of each room check's rounded gratuity line (money-cases ambiguity A1).
  - Spec gap: which printer prints the Z report and in what form; cautious default: the front-desk receipt printer, plus a PDF.
  - Open question: how room time, damage fees, kept deposits and no-show charges are taxed (accountant, gate); M4 built the cautious default and the report reads the tax lines as written.

### M7-14 · Match payouts and work through Unmatched payments

- **Status:** todo
- **Size:** M
- **Depends on:** M7-02; M4-03 (payout events stored for M7), M4-04 (payments with `stripe_pi_id`), M4-12 (the reconciler, which already records Stripe activity with no row of ours), M4-21 (refunds), M4-24 (disputes)
- **Spec:** [Stripe setup](../spec/06-stripe-setup.md) 8 and 11; [Payment flows](../spec/07-payment-flows.md) · How every card payment runs 5; [Data model](../spec/04-data-model.md) · `payouts`, `payout_lines`, `payments` (method `external`); [Security and data retention](../spec/12-security-retention.md) 4 (payouts matched every night); [glossary](../glossary.md#money-cards-and-cash) · Unmatched payments; screens [N37](../screens.md#n37-admin--payments-disputes-and-unmatched-payments), [Night](../screens.md#night) note 8
- **Build:**
  - A job on `payout.reconciliation_completed`: list the payout's balance transactions on the venue's account (`GET /v1/balance_transactions?payout=po_…&expand[]=data.source`), match each charge and refund to our payments row by its PaymentIntent (never by metadata), take the venue from that row through a definer resolver, and write `payouts` and `payout_lines` (gross, fee, net) under each venue's scope. The lines must add up to the payout.
  - Unmatched payments: Stripe activity with no row of ours (a break-glass Tap to Pay payment from Stripe's Dashboard app, anything the reconciler couldn't adopt, anything left after payout matching). M4-12 already records what the reconciler finds as `payments` rows with method `external` and no allocation; payout matching adds its leftovers the same way, with the PaymentIntent, amount, card brand and last four, time and business date.
  - The list, opened from Close the night for a manager and in Admin → Payments for the owner: each shows its amount, card and time, and the manager picks the check it belongs to. That writes the allocation, never over the amount due (`422 over_amount_due`); a match to a closed night's check posts to the current night and points back.
  - A payout that doesn't reconcile alerts the owner (M8 adds the page to us). `GET /reports/payouts` is owner only.
- **Acceptance:**
  - [ ] A sandbox payout that covers Room 9's tap and Jess P.'s tab matches both payments, and its `payout_lines` add up to the payout to the cent.
  - [ ] A Tap to Pay payment taken in the sandbox Dashboard app shows in Unmatched payments with its amount, card and time; Andy matches it to Room 12's check from Night, and Room 12's amount due drops by it.
  - [ ] Matching more than a check's amount due is refused.
  - [ ] Stripe's fees in a payout post as fees, not as unmatched payments.
  - [ ] A venue sees only its own payout lines, and the owner's report shows the whole payout through the org scope.
- **Tests:** integration tests on the connected sandbox; venue-wall tests for the job, which runs with no user; a replay test where the same event twice changes nothing.
- **Notes:** Spec gaps: the data model has no table for Unmatched payments (M4-12's cautious default, kept here: `external` payments with no allocation); what to do with balance transactions that aren't charges or refunds isn't said (cautious default: Stripe's fees post as fees; anything else lands in Unmatched payments as other Stripe activity). Check early that the sandbox sends `payout.reconciliation_completed` for the connected sandbox account; M7-19 needs it.

### M7-15 · Write the nightly accounting journal and Export for QuickBooks

- **Status:** todo
- **Size:** L
- **Depends on:** M7-12, M7-13, M7-14; M4-24 (dispute funds kept for the journal), M4-28 (the prepaid-value ledger's kinds)
- **Spec:** [Money rules](../spec/05-money-rules.md) 11 and 16; [Stripe setup](../spec/06-stripe-setup.md) 8 and 9; [API](../spec/08-api.md) · Reports and exports; [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what (exports ask for the passkey again); [blueprint](../blueprint.md) · Integrations (Accounting); screens [AdminDesk](../screens.md#admindesk) note 21, [N38](../screens.md#n38-reports-and-exports)
- **Build:**
  - A journal for each closed night, posted at the close from the same totals as the Z report, to the named accounts: sales by category, sales tax payable by jurisdiction, gratuity payable, tips payable, customer deposits, prepaid value, Stripe clearing, cash, cash over and short, comps and refunds. Debits equal credits to the cent. Late adjustments post on the day they're entered, with a memo naming their night.
  - A journal for each payout: bank (net), Stripe fees and Stripe clearing (gross); dispute funds withdrawn and reinstated post too.
  - `GET /exports/accounting?date=`: a file for QuickBooks with one balanced journal per night and one per payout; `POST /exports/{e}/email` to the addresses the owner sets. Both ask for the passkey again, and practice checks never appear. `night_closes.export_id` points at the night's export.
  - Admin → Connections: "Export for QuickBooks" (not "Connect"), where the owner maps each named account to West 4's chart of accounts and sets where the nightly file is emailed. No live QuickBooks connection.
- **Acceptance:**
  - [ ] Every night of M7-19's run and every payout has a journal whose debits equal its credits.
  - [ ] Room 9's close-out posts debits of $120.00 to customer deposits and $498.60 to Stripe clearing, and credits of $322.00 room time, $158.00 drinks, $42.60 sales tax payable and $96.00 gratuity payable.
  - [ ] Jae & co.'s $50.00 deposit, paid Wed Sep 23, sits in customer deposits until it's allocated at check-in.
  - [ ] A $5.00 short drawer posts to cash over and short.
  - [ ] The export is refused from a PIN session and downloads, then emails, with a passkey.
  - [ ] The file imports into a QuickBooks test company without errors.
- **Tests:** unit tests that every Z figure maps to exactly one account and every journal balances; a golden-file test for the export; money-cases groups `room9_close_out`, `deposits`, `refunds` and `z_report`; the principal suite for exports.
- **Notes:**
  - Canvas: Connections shows a QuickBooks "Connect"; build "Export for QuickBooks" ([AdminDesk](../screens.md#admindesk) note 21). Yelp and Homebase stay out.
  - Spec gaps for the accountant: no named account for money waiting in Unmatched payments (cautious default: a suspense liability until it's matched), for dispute withdrawals and fees (cautious default: a disputes account), or for voids (cautious default: voids net against their category's sales; comps post to comps). The file format is only "a file for QuickBooks" (cautious default: QuickBooks Online's journal-entry CSV import layout).

### M7-16 · Export payroll with gratuity split from tips

- **Status:** todo
- **Size:** S
- **Depends on:** M7-01, M7-09
- **Spec:** [API](../spec/08-api.md) · Reports and exports (`GET /exports/payroll?from=&to=`); [Data model](../spec/04-data-model.md) · `tip_shares` (gratuity is paid as wages; tips are tips), `tip_pools`, `shifts`; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · the rule pack's `wages`; [blueprint](../blueprint.md) · Integrations (Payroll); [Open technical questions](../spec/14-open-questions.md); screens [N38](../screens.md#n38-reports-and-exports)
- **Build:** a CSV for a date range: per person and shift, the name, role, duty, business date, clock-in and out, break minutes and hours; per person and night, the gratuity share in a wages column and card and cash tips in tips columns; totals. It asks for the passkey again, leaves practice out, can be emailed, and marks each included pool `exported` (locked).
- **Acceptance:**
  - [ ] The export for Fri Sep 25 puts Maya's and Diego's gratuity shares in the wages column and their card and cash tips in the tips columns; Andy and Abhishek have hours and no shares.
  - [ ] Once exported, Fri Sep 25's pool can't change, and a late tip shows on the next pool.
  - [ ] The wages and tips columns add up to the pools for every night.
- **Tests:** a golden-file test; a property test that shares add up; the principal suite (owners and managers, passkey).
- **Notes:** Open question (lawyer, gate): is checking tip-credit coverage our report's job or payroll's? Cautious default: the export marks any shift whose tips per hour fall under the rule pack's `wages.tipCreditCents` ($5.65) as "check tip credit with payroll", a flag only, with no wage math.

### M7-17 · Report the sales-tax quarter

- **Status:** todo
- **Size:** S
- **Depends on:** M7-13
- **Spec:** [API](../spec/08-api.md) · Reports and exports (`/reports/tax-quarter`); [Money rules](../spec/05-money-rules.md) 2 and 8; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Rule packs (`salesTax`); [milestones](../milestones.md#must-fix-items-and-where-they-close) GA-S12; [Open technical questions](../spec/14-open-questions.md); screens [N38](../screens.md#n38-reports-and-exports)
- **Build:** `GET /reports/tax-quarter` for New York's quarters (Mar–May, Jun–Aug, Sep–Nov, Dec–Feb), by business date: taxable base and tax per category and jurisdiction code, sales not taxed (the gratuity), and late adjustments in the quarter they post to. The after-midnight sales of each quarter's last night (Nov 30, Feb 28 or 29, May 31, Aug 31) show on their own line. Practice is left out; it runs on the replica; exporting asks for the passkey again. DeskReports and Reports show it.
- **Acceptance:**
  - [ ] The Sep–Nov 2026 quarter includes Fri Sep 25 and shows 8.875% tax on room time, drinks and damage fees.
  - [ ] Sales from midnight to 6:00 AM on Tue Dec 1, 2026 (business date Mon Nov 30) show on their own line.
  - [ ] The quarter's tax equals the sum of its nights' tax lines to the cent.
- **Tests:** unit tests for quarter boundaries by business date, including Feb 29, 2028; an integration test against M7-19's nights.
- **Notes:** Open question (accountant, gate): which business date gets after-midnight sales on the nights a quarter ends. Build the cautious default as a rule-pack field (`salesTax.quarterBoundary`, "businessDate"), so the answer ships as a new rule-pack version; the split line shows either way. The $300,000 sales-tax alert is phase 2 ([Not in phase 1](../milestones.md#not-in-phase-1)).

### M7-18 · Build Reports and the report routes

- **Status:** todo
- **Size:** L
- **Depends on:** M7-13, M7-14, M7-16, M7-17
- **Spec:** [API](../spec/08-api.md) · Reports and exports, Conventions (reports on a read replica with a 5-second limit); [Tenancy and access](../spec/02-tenancy-access.md) · The database walls (owner reports), Approvals (the nightly exceptions report); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · What each module hides (Reports & accounting); [Testing and operations](../spec/13-testing-operations.md) · Capacity; screens [DeskReports](../screens.md#deskreports), [Reports](../screens.md#reports), [N38](../screens.md#n38-reports-and-exports)
- **Build:**
  - Routes on the read replica with the 5-second limit: `GET /reports/sales` (sales by night before tax and gratuity, weekly Fri to Thu, 8-week trends, average by weekday, best sellers for rooms and the bar); `/occupancy` (rooms in use by hour, of 14); `/bookings` (booked online, walk-ins seated, big parties of 20 or more, stayed past booked time, no-shows with the deposit kept, the no-show rate by week); `/staff-actions`; `/exceptions` (every comp, void and refund, approved or not); `/payouts` (owner only). Weeks before go-live come from `legacy_nightly_totals`, which M9 loads.
  - Owner reports across an organization's venues run read-only in the org scope.
  - DeskReports (This week, Trends · 8 weeks, Tonight → Close the night) and the phone's Reports, in English and Spanish: tonight's report as the running X report until the close and the Z report after; the tax quarter; the payroll and accounting exports, which ask for the passkey again.
  - "Reviews from the morning text" reads "Off" while the Review ask text is off.
  - With Reports & accounting off, the reports and exports hide and answer `404 module_off`, and the Z report stays on Night under Payments & checks.
- **Acceptance:**
  - [ ] DeskReports shows this week and 8-week trends from M7-19's nights and "Reviews from the morning text · Off".
  - [ ] "Email CSV" asks for the passkey again on the shared computer.
  - [ ] The phone's Reports shows Fri Sep 25 as the running X report linked to Close the night, and the Z report once closed.
  - [ ] The exceptions report for Fri Sep 25 lists Maya's $12.00 COMP on Luis M.'s tab and Diego's $70.00 VOID on Tariq A.'s tab, with who asked and who approved.
  - [ ] Payouts answers `403` for Andy and works for Abhishek.
  - [ ] Each report answers within 5 seconds on the replica with 8 weeks of nights.
  - [ ] With Reports & accounting off, the report routes answer `404 module_off` and Night still prints the Z report.
- **Tests:** the principal suite and the module test over every report route; Playwright at phone and desktop sizes; the language test at the longest translation.
- **Notes:**
  - Canvas: DeskReports emails a CSV without a passkey (note 1), counts 19 reviews from a text that's off (note 2) and has no tax-quarter, payroll or accounting screens (note 3) ([DeskReports](../screens.md#deskreports)); Reports says tonight's report "closed out at 4 AM" ([Reports](../screens.md#reports) note 3).
  - Spec gap: what the staff-actions report holds; cautious default: per person and date, their comps, voids, refunds asked and approved, cut-offs, no-sales, paid-outs, drawer over or short and punch edits, with counts and amounts. The phone canvas's "Birthday list" is guest CRM (phase 2); leave it out. Revenue per room-hour, ticket times and labor share are phase 2.

### M7-19 · Reconcile two weeks of staging nights to the cent

- **Status:** todo
- **Size:** L (then 14 real days of runs)
- **Depends on:** M7-12, M7-13, M7-14, M7-15, M7-16
- **Spec:** [milestones](../milestones.md#m7--close-the-night-and-the-books) · M7 Done when; [Testing and operations](../spec/13-testing-operations.md) · Environments, The demo seed, Tests; [Money rules](../spec/05-money-rules.md); [demo seed](../demo-seed.md#loading-the-seed)
- **Build:**
  - A staging night runner (`apps/api` scripts on `packages/db` test helpers) that plays one business date each real day on the simulated clock, from opening to the close, built from the demo seed's venue, rooms, menu, team and settings.
  - Each night has bookings with deposits, walk-ins, room orders (accepted, asked to wait, declined, canceled at 4 AM), comps and voids within and over the limit, bar tabs with growing holds and reader tips, slips, a split, Pay my share, cash in both drawers with a drop and a paid-out, a refund, a no-show charge, punches for each person, a practice check, a break-glass payment, the clear-out check, Charge the remaining tabs and the close. The runner calls the public API only, on the connected sandbox with simulated readers.
  - 14 nights on 14 real days, so Stripe's automatic sandbox payouts land between them; one is business date Sat Oct 31, 2026, the fall-back night.
  - A reconcile script after each close and each payout: the Z report equals the checks' lines by category and their tax and gratuity lines; each drawer's expected cash equals its moves and its count differs only by the scripted over or short; the tip ledger equals gratuity lines plus tips, and the shares add up to the pool; each payout's lines match Stripe's balance transactions; every night's and payout's journal balances; practice checks show nowhere. Any cent off fails the run and names the night, the check and the rule.
- **Acceptance:**
  - [ ] 14 staging nights, the fall-back night among them, pass the reconcile script with no difference of any amount.
  - [ ] Every sandbox payout in the window is matched; nothing is left in Unmatched payments except the scripted break-glass payments, each matched by a manager.
  - [ ] Each night's reconcile report is kept as evidence for M7-20.
- **Tests:** the runner and the reconcile script run in CI in a one-night compressed mode, without payouts, on every merge that touches money code.
- **Notes:** Stripe lists a payout's balance transactions only for automatic payouts, so the runs take real days; start as soon as M7-14 and M7-15 land. If the sandbox doesn't send `payout.reconciliation_completed`, match on `payout.paid` plus a daily re-check, and record it. One more real day on the spring-forward night (business date Sat Mar 13, 2027) is cheap once the runner exists.

### M7-20 · Close GA-M2 and GA-M4, and sign off M7

- **Status:** todo
- **Size:** S
- **Depends on:** M7-01 to M7-19
- **Spec:** [milestones](../milestones.md#must-fix-items-and-where-they-close) · GA-M2 and GA-M4; [Security and data retention](../spec/12-security-retention.md) 4 and How long we keep things; [Data model](../spec/04-data-model.md) · the money core grants
- **Build:**
  - GA-M2 proof: "Gratuity" is the one label on every screen, receipt, report and export (a string-catalog check); all of it goes to eligible staff by duties, never owners or managers (pool tests); the tip, pool, share, ledger, punch and shift rows have no delete grant and are kept 6 years (a retention entry for M8's job); the payroll export splits gratuity from tips.
  - GA-M4 proof: dated Z reports that never reopen; no deletes on money rows (a grants test over every money, tip, drawer and night table). Tax lines and check numbers came in M4.
  - A walk through each M7 done-when line in staging, with its evidence (test runs, screenshots, M7-19's reports) linked here.
- **Acceptance:**
  - [ ] Each M7 done-when line has a passing test or a recorded staging walk.
  - [ ] The grants test shows `app_rw` can't update, delete or truncate any money, tip, drawer or night row.
  - [ ] GA-M2 and GA-M4 are marked closed in M9-14's must-fix tracker.
- **Tests:** the grants test and the string-catalog check in CI.
- **Notes:** —

## Coverage

Every "Ships" item, done-when line, Admin section and must-fix item that milestones.md gives M7, and where it lands.

| From milestones.md | Tickets |
| --- | --- |
| Ships · Drawers: blind counts of both drawers | M7-05 |
| Ships · Drawers: the handover when the manager on duty changes | M7-05 |
| Ships · Drawers: drops, paid-outs over the limit sent for approval, no-sale with the PIN | M7-06 |
| Ships · Drawers: the drawer-per-person model with trays (a change starts at the next business date) | M7-07, M7-05 |
| Ships · The time clock: clock-in with the duty, breaks | M7-01 |
| Ships · The time clock: edits with a reason, and the clock-out checklist | M7-11 |
| Ships · Tips: the tip ledger | M7-08 |
| Ships · Tips: pools by hours with per-person eligibility and shares by occupation (owners and managers never share) | M7-09 |
| Ships · Tips: My tips with the 146-2.17 records | M7-10 |
| Ships · Close the night: the checks before closing, each with a link to fix it | M7-12 |
| Ships · Close the night: "Print X report (running)" and "Print Z report"; drinks split; gratuity from room checks only | M7-13 |
| Ships · Close the night: adjustments after the close | M7-02, M7-13 |
| Ships · The books: payout matching and "Unmatched payments" (break-glass payments included) | M7-14 |
| Ships · The books: the nightly accounting journal (a file for QuickBooks) | M7-15 |
| Ships · The books: the payroll export | M7-16 |
| Ships · The books: the tax-quarter report | M7-17 |
| Ships · The books: the reports (weekly and 8-week trends, occupancy, bookings, staff actions) | M7-18 |
| Ships · Training mode | M7-03, M7-04 |
| Ships · Canvas boards: Night, DeskReports, Reports, Staff and AdminDesk | M7-12, M7-13, M7-18, M7-01, M7-10, M7-11, M7-05, M7-09, M7-15 |
| Done when · Two weeks of staging nights on the demo seed reconcile to the cent | M7-19 |
| Done when · Night shows "3 slips not entered · tips post to Sat Sep 26" | M7-12, M7-02 |
| Done when · The Z report's gratuity is 20% of room checks only | M7-13 |
| Done when · A late tip posts to the current business date and points at its night | M7-02, M7-08 |
| Done when · A training-mode check is numbered T-… | M7-03, M7-04 |
| Done when · The accounting journal balances for every night and every payout | M7-15, M7-16 |
| Admin · Team: tip eligibility and training mode come in M7 | M7-09, M7-03, M7-11 |
| Admin · Connections: the accounting export (M7) | M7-15 |
| Admin · Cash drawers | M7-05 |
| Must-fix · GA-M2 (gratuity and the tip pool) | M7-08, M7-09, M7-10, M7-16, M7-20 |
| Must-fix · GA-M4 (dated Z reports, no deletes) | M7-02, M7-12, M7-13, M7-20 |
| Should-have · GA-S12 (reporting by sales-tax quarter) | M7-17 |

**Size:** 20 tickets: 5 S, 10 M and 5 L, about 45 to 60 working days at the ranges' low and high ends, against the 2–3 weeks in milestones.md. M7-19 also needs 14 real days of runs.
