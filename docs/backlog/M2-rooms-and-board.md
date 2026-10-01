# M2 · Rooms and the board

The backlog for [M2 · Rooms and the board](../milestones.md#m2--rooms-and-the-board), ticket by ticket. The [spec](../spec/README.md) decides how each piece works, [screens](../screens.md) says where to build differently from the frozen canvas, and the [demo seed](../demo-seed.md) supplies the names and numbers in every check. Where a ticket had to pick something the spec doesn't say, its Notes say so and name the cautious default it builds.

## Goal

A staff-run room night in staging: check-in, waitlist, moves, clocks and texts.

## Done when

Copied from [milestones.md](../milestones.md#m2--rooms-and-the-board):

- On the demo seed at 10:41 PM, every tile, clock and "Room time so far" matches the seed to the cent (Room 9: 161 min, $322.00; VIP room: 71 min, $295.83), and the board counts 8 rooms in use, 3 open, 2 cleaning and 1 out of service.
- Pricing property tests pass for bands in each rate mode, billing steps of 1, 15, 30 and 60 minutes, party-size changes mid-session, and both daylight-saving nights (Nov 1, 2026 and Mar 14, 2027).
- Checking in Sam O. shows "3 guests · Fridays bill at least 4", shows his $40 deposit and texts a new 5-character room code. [Mark no-show] appears only after the 15-minute grace.
- Offering Room 11 to Amara B. holds it for 10 minutes with a countdown and texts her. A failed text shows "Not delivered · Call", and an expired offer releases the room to the next party that fits.
- The move sheet for Rob & Kim lists only rooms that fit 7 and are free long enough (Room 11, free all night). Moving them issues a new code and sends Room 7 to cleaning.
- A clock-pause request from Diego lands in Andy's Approvals inbox and never on Diego's device, and Diego's screen shows "Waiting for Andy". Andy's own request goes to Abhishek.
- With no occupancy limit set, the board shows "Limit not set · Admin → Safety" and no number.
- A guest's reply ("running 15 late") lands in Messages on the right booking, and STOP stops every text to that number at once.

**Depends on:** M1.

**Size:** milestones.md plans 2–3 weeks. These 35 tickets are 16 S and 19 M: about 46 to 73 working days at S = ½–1 day and M = 2–3 days.

## Suggested order

Ticket numbers follow the dependencies, so working top to bottom is always safe. Tickets on one line can run side by side once the line before is done.

1. The money and time rules, test-first: M2-01, then M2-02, then M2-03.
2. Rooms, blocks, bookings and the clock: M2-04, M2-05, M2-06, M2-07, M2-08.
3. Texts, then check-in: M2-09 and M2-10, then M2-11 and M2-12.
4. Files, limits and approvals: M2-13, M2-14, M2-15.
5. Room operations: M2-16, M2-17, M2-18, M2-19, M2-20, M2-21.
6. The inbox and the automatic texts: M2-22, M2-23, M2-24.
7. The waitlist and the headcount: M2-25, M2-26, M2-27, M2-28.
8. The screens: M2-29, then M2-30, M2-31, M2-32 and M2-33, then Admin in M2-34.
9. The seed's M2 scenarios end to end: M2-35.

Definition of done: see CLAUDE.md.

## Tickets

### M2-01 · Write the room-time rules test-first

- **Status:** done
- **Size:** S
- **Depends on:** M1-04
- **Spec:** [Money rules](../spec/05-money-rules.md) 2 and 3; [Data model](../spec/04-data-model.md) · `session_segments`; [Testing and operations](../spec/13-testing-operations.md) · Tests (pricing unit and property tests)
- **Build:**
  - `roomTime(segments, { firstHourMinimum })` in `packages/rules`: bills `round(Σ hourly_cents × minutes / 60)` over all segments, rounded once (`floor((Σ hourly_cents × minutes + 30) / 60)`). A paused segment bills nothing. The first-hour minimum applies once per session, topping a session shorter than an hour up to 60 minutes at its first segment's rate.
  - `roomTimeBetween(start, end, hourlyCents)`: real elapsed minutes, never clock times subtracted.
  - Segments start and end on the minute.
- **Acceptance:**
  - [x] Every case in the `room_time` group of [money-cases.json](../../seed/money-cases.json) passes: 40 minutes at $40.00 an hour then 44 at $50.00 bill $63.33, never $63.34; 1, 41, 59 and 60 minutes at $40.00 an hour bill $40.00 and 61 minutes $40.67; two 20-minute segments at $40.00 and $50.00 bill $43.33.
  - [x] Room 9, one 161-minute segment at $120.00 an hour, bills $322.00; Room 5, 41 minutes at $40.00, bills $40.00.
  - [x] From 11:00 PM EDT on Oct 31 to 3:00 AM EST on Nov 1, 2026 is 300 minutes, $300.00 at $60.00 an hour; from 11:00 PM EST on Mar 13 to 3:30 AM EDT on Mar 14, 2027 is 210 minutes, $210.00.
- **Tests:** the `room_time` group (9 cases, with their `must_not_equal` checks), written before the code.
- **Notes:** "On the minute" is read as segment starts and ends taken to the whole minute on the server's clock, so every segment is whole minutes; the spec doesn't say how a part minute counts (flagged). Built in `packages/rules/src/room-time.ts`: `roomTime(segments, { firstHourMinimum })` keeps Σ hourly_cents × minutes exact and rounds once with `floor((Σ + 30) / 60)`; a paused segment bills nothing and doesn't count toward the hour; the top-up uses the first billed segment's rate; it also returns `billedMinutes` and `elapsedMinutes` for the screens. `roomTimeBetween(start, end, hourlyCents)` subtracts instants, so both daylight-saving nights come out in real minutes, and takes a part minute down to the whole minute (cautious default for the flag). Tests: the 9 `room_time` cases with their `must_not_equal` checks, Room 9 and Room 5, pauses, and the guards against non-whole or negative minutes.
### M2-02 · Write the rate, tab-so-far and deposit rules test-first

- **Status:** done
- **Size:** M
- **Depends on:** M1-11, M2-01
- **Spec:** [Money rules](../spec/05-money-rules.md) 2, 3 and 11; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `Rate`, `PriceSettings`, `DepositRule`; [Glossary · Billable guests, Tab so far, Deposit](../glossary.md#rooms-time-and-bookings)
- **Build:**
  - `hourlyRateAt(localTime, partySize, room, prices)` returns the business date, the minimum guests for it (`minGuests.weeknight` or `minGuests.friSat` by the business date's weekday), the billable guests (the larger of the party size and that minimum) and the hourly cents in the venue's rate mode: `perPerson` (billable guests × `perPersonCents`), `basePlusExtra` (`baseCents` plus `extraCents` for each billable guest over `baseGuests`) or `flatBySize` (`bySizeCents` for the room's size tier). In a room listed in `vip.roomIds`, a party of at least `vip.fromGuests` pays `vip.hourlyCents` instead (`rate_kind` `vip`); a smaller party pays the normal rate.
  - `tabSoFar(session, lines, at)`: room time so far plus the check's lines so far, before tax and gratuity. A ringing order isn't a line, so it isn't counted.
  - `deposit(partySize, businessDate, depositRule, prices)`: the first hour for billable guests (`firstHour`), or the `bigParty` rule from its guest count (a flat $250 from 20 guests at West 4), plus the `perPerson`, `flat` and `percent` modes; `cardHold` charges nothing.
- **Acceptance:**
  - [x] Every case in the `billable_guests` group passes: a party of 3 on a Friday bills as 4 at $40.00 an hour; on a Wednesday, parties of 2 and 3 bill as 3; 12:30 AM on a Saturday is Friday's business date, so 3 bill as 4; 19 in the VIP room pay $190.00 an hour and 20 or 22 pay $250.00.
  - [x] Every case in the `tab_so_far` group passes for room time, drinks and tab so far: Room 9 $322.00 + $158.00 = $480.00, Room 5 $40.00, the VIP room $295.83 + $480.00 = $775.83, and the rest of the eight rooms.
  - [x] The `deposits` cases pass: Sam O.'s 3 guests on Fri Sep 25 owe $40.00, a party of 3 on Wed Sep 23 owes $30.00, 19 guests owe $190.00, and 20 or 22 guests owe $250.00.
- **Tests:** the `billable_guests` group (14 cases), the `tab_so_far` group (8 cases; their `if_presented_now` totals are asserted in M4 with tax and gratuity) and the `deposits` group (8 cases; `deposit_larger_than_check_forfeit` is M4's), all written first.
- **Notes:** The glossary words "tab so far" as room time plus drinks. This counts every line on the check (drinks, comps and voids, a damage fee), since the seed has only drinks and a tile that left out a damage fee would understate what's owed (flagged). Online booking reuses the deposit rule in M5.
  - **Built:** `packages/rules/src/rates.ts` (`hourlyRateAt(at, partySize, room, prices, venue)` with `minGuestsOn`, `billableGuestsOn` and `hourlyCentsFor` for the three rate modes and the VIP rule; a flat-by-size room with no price for its tier is an error, never a guess), `tab.ts` (`tabSoFar(session, lines, at)` over closed segments plus the open one to `at`), `deposit.ts` (`deposit(partySize, businessDate, rule, prices)` with the big-party flat and percent rules, the five modes, and the rule's words, for example "first hour: billable guests x $10"), and `west4-fixtures.ts` (West 4's price and deposit settings as the spec gives them, for the tests). Exported from `@west4/rules`.
  - **Cautious defaults:** a percent deposit (plain or big-party) is taken on the first hour's room cost for billable guests; the spec says "the larger of room cost and the booking's minimum spend", and minimum spend arrives in M4 (empty at West 4), so that half joins then. A big-party rule wins over the deposit mode once the party reaches `fromGuests`.
  - **Tests:** the 14 `billable_guests` cases, the 8 `tab_so_far` cases (room time, drinks and tab so far; their `if_presented_now` totals wait for M4), the 8 booking `deposits` cases (the forfeit case is M4's), plus base-plus-extra, flat-by-size, the VIP party in an ordinary room, the other deposit modes and a tab with closed and open segments. Time bands join `hourlyRateAt` in M2-03.
### M2-03 · Add time bands with a billing step and rounding, and the pricing property tests

- **Status:** done
- **Size:** M
- **Depends on:** M2-02
- **Spec:** [Money rules](../spec/05-money-rules.md) 2 and 3 (Billing step); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `Billing`, `PriceSettings.bands`; [Data model](../spec/04-data-model.md) · `session_segments`; [Testing and operations](../spec/13-testing-operations.md) · Tests
- **Build:**
  - Bands from `prices.bands`: each has its days (business-date weekdays), `fromMin` and `toMin` (minutes from midnight at the start of the business date, so 12:30 AM is 1,470), a rate in the venue's own rate mode (K13) and a billing step (`incrementMin` 1, 15, 30 or 60) with a rounding rule (`up`, `nearest` or `down`).
  - A session's segment closes and the next opens, on the minute, at every band boundary. Each segment copies `band_id`, `rate_kind`, `hourly_cents`, `increment_min` and `rounding`.
  - With a step above 1 minute, the session's minutes after the first hour are rounded to the step by the rule of the band the session ends in, and the minutes added or taken off bill at the last segment's rate.
  - Bands resolve per business date through Temporal, reading minutes from midnight on the wall clock on the daylight-saving nights. West 4 has no bands and bills by the minute.
- **Acceptance:**
  - [x] Pricing property tests pass for bands in each rate mode, billing steps of 1, 15, 30 and 60 minutes with each rounding rule, party-size changes mid-session, and both daylight-saving nights (Nov 1, 2026 and Mar 14, 2027).
  - [x] In every generated session, room time equals a second, separately written reference, is rounded once, never drops as minutes grow, applies the first-hour minimum once, and with a step of 1 equals the per-minute sum.
  - [x] Segments tile each session with no gap and no overlap, and on the daylight-saving nights their minutes equal the real elapsed time.
- **Tests:** property tests (fast-check) against the reference implementation; unit tests for a band that starts mid-session (a 12:30 AM band change on a Saturday is minute 1,470 of Friday's business date).
- **Notes:** Money-cases ambiguity A7 (wall-clock minutes for bands on the daylight-saving nights) is the reading used. Holiday price rules are phase 2.
  - **Built:** `packages/rules/src/bands.ts`: `bandAt(prices, businessDate, minutesFromMidnight)` (the first band covering the minute on that business-date weekday, JS numbering; outside every band, the base rate and billing), `rateAt(...)` (the band's rate, or the VIP flat rate), `bandBoundaries(start, end, prices, venue)` and `segmentsFor({ start, end, partySize, room, events }, prices, venue)`, which tiles a session with a new segment at every band change, every business-date cutover, every party-size change and every pause or resume, each on the minute and copying `band_id`, `rate_kind`, `hourly_cents`, `increment_min`, `rounding` and `paused` the way `session_segments` stores them. `roomTime` (M2-01) takes the billing step: minutes after the first hour rounded to the step by the rule of the band the session ends in (`roundToStep`; nearest rounds half up), the difference billed at the last segment's rate. `hourlyRateAt` (M2-02) now reads the band at the instant. `fast-check` joins the rules package.
  - **How band edges land on the daylight-saving nights:** boundaries come from walking the session's real minutes and reading each on the wall clock, so an edge at a wall-clock minute that doesn't exist on the spring-forward night (2:01 AM) falls at 3:00 AM, and a band over the repeated hour on the fall-back night runs for both of them. This is what makes the segments and the separately written minute-by-minute reference agree to the cent.
  - **Cautious default:** a session still open at the 6:00 AM cutover closes a segment there, because the business date, its minimum and its bands change; the spec lists only party size, band, move and pause as reasons (flagged).
  - **Two corners where the spec's own rule lets a longer session bill less (flagged for the spec):** (1) the step is "the rule of the band the session ends in", so a session that runs one minute past a band with a 15-minute step into a by-the-minute band drops the rounding; (2) inside the first hour, the top-up is priced at the first segment's rate, so a cheaper later minute replaces a dearer top-up minute. The "never drops as minutes grow" property is therefore asserted past the first hour with the same ending step, and the two cases are documented in the test.
  - **Tests:** `bands.test.ts` (the 12:30 AM Saturday band at minute 1,470 of Friday's business date, a session across it, a party-size change, a pause, the three rounding rules, West 4 by the minute) and `pricing.property.test.ts` (300 generated sessions per property across the three rate modes, steps 1/15/30/60 with each rounding rule, party-size changes and pauses, both daylight-saving nights and the cutover: equal to the reference, rounded once, tiled with no gap or overlap and real minutes, the first-hour minimum once, and step 1 equal to the per-minute sum).
### M2-04 · Build rooms and room states, and Admin → Rooms

- **Status:** done
- **Size:** S
- **Depends on:** M1-11, M1-13, M1-31
- **Spec:** [Data model](../spec/04-data-model.md) · `rooms`, `room_states`, Room assignment; [API](../spec/08-api.md) · Rooms; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `RoomSettings`; [Admin by milestone](../milestones.md#admin-by-milestone) (Rooms); [AdminDesk](../screens.md#admindesk)
- **Build:**
  - `rooms` (venue_id, name, size_tier, capacity_min, capacity_max, cleaning_min, is_vip, bookable_online, archived_at); an empty `cleaning_min` uses `rooms.cleaningMin`. `room_states` (venue_id, room_id, state, reason, since, until, set_by) with the states `available`, `in_use`, `wrap_up`, `cleaning` and `out_of_service`.
  - `GET /rooms`, `POST /rooms` and `PATCH /rooms/{r}`: archiving sets `archived_at`, and nothing deletes a room. `PATCH /rooms/{r}/state`. Switching a room off or out of service re-runs assignment for its future bookings (M2-05) and lists any that no longer fit for a manager.
  - Admin → Rooms: names, sizes, capacities, cleaning minutes, VIP, bookable online, on or off, and the `rooms` settings (`cleaningMin`, `cleaningEnds`, `cleaningFlagMin`, `stayOnWhenFree`).
  - The seed's 14 rooms in four tiers: small (Rooms 1–5, 3–6 guests), medium (Rooms 6–10, 6–12), large (Rooms 11–13, 12–20) and the VIP room (20–40). `room.updated` events. Every route belongs to the Rooms & room clock module.
- **Acceptance:**
  - [x] West 4 lists 14 rooms with the tiers and capacities above, and Room 4 is out of service.
  - [x] Archiving a room hides it from the board and from assignment and keeps its history.
  - [x] *(Filled in and tested in M2-06.)* Switching a room off moves each of its future bookings to the smallest free room that fits, and lists any that can't move for a manager.
  - [x] With Rooms & room clock off, every route here answers `404 module_off`.
- **Tests:** API integration tests; a Playwright test of Admin → Rooms.
- **Notes:** The data model has no column for a room switched off in Admin (it isn't archived, and the plan still bills it). Cautious reading built here: "off" is an `out_of_service` state with the reason "Switched off" (flagged); the matching `out_of_service` block arrives with `room_blocks` in M2-05.
  - **Built:** migration `0027_rooms.sql` (`rooms` and `room_states`, walled and audited; `room_states` is the current state per room, and the audit log is its history; the tablet's `devices.room_id` foreign key the M1 table left open), `packages/db/src/rooms.ts`, the routes in `apps/api/src/routes/rooms.ts` (`GET /rooms` with `?all=1` for archived ones, `POST /rooms`, `PATCH /rooms/{r}` including `{ archived }`, `PATCH /rooms/{r}/state`; every route in the `rooms` module; `room.updated` events; names are unique per venue), the seed's 14 rooms with tonight's states (Room 4 out of service with its fault note, tablets linked to their rooms), and Admin → Rooms in `apps/staff/src/screens/admin/Rooms.tsx` (each room's tier, guests, cleaning minutes, bookable online, on or off and archive; the `rooms` settings through Save and publish; add a room). Size tiers show as Small, Medium, Large and VIP from the catalog.
  - **Seed choice:** the VIP room is staff-only (`bookable_online` off) because the seed's online booking stops at 25 guests and the VIP room starts at 20; the others are bookable online (flagged; Admin can change it).
  - **Also:** the security suites learned the new `:r` parameter (venue B's room in the wall cases); the desktop smoke test now waits out a 429 from the sign-in rate limit, which the growing staff suite reaches in a full run (the limit itself is unchanged).
### M2-05 · Build room blocks and room assignment

- **Status:** done
- **Size:** M
- **Depends on:** M1-12, M2-04
- **Spec:** [Data model](../spec/04-data-model.md) · `room_blocks` (the money-core SQL), Room assignment; [Money rules](../spec/05-money-rules.md) 4; [API](../spec/08-api.md) · Errors (`room_not_free`)
- **Build:**
  - `room_blocks` exactly as the SQL: `btree_gist`, an exclusion on `(venue_id, room_id, period)`, the kinds `booking`, `hold`, `session`, `cleaning`, `out_of_service` and `buyout`, and `expires_at` for holds. A job deletes holds once they expire.
  - Assignment: the smallest free room that fits the party, and a bigger tier only when no booking that needs it would be left without a room. A room fits when the party is no bigger than its `capacity_max`; `capacity_min` only orders the choice.
  - A booking's block covers its booked time plus the room's cleaning minutes, and becomes the session's block at check-in. A session past its booked end extends its block 15 minutes at a time, only while nothing is booked next. A booking into that room needs at least the wrap-up notice (`alerts.roomEndingMin`, 10 minutes) plus cleaning before it starts.
  - `free_until` for each room: the start of its next block, or free all night up to the night's close (M1-12). A "free for the time needed" query for moves (M2-18) and waitlist offers (M2-26, at least an hour).
  - Nothing runs past the night's close: a booking must end by it.
- **Acceptance:**
  - [x] Two overlapping blocks in one room can't both be written.
  - [x] A 10-minute hold is gone after it expires, and its room is free again.
  - [x] At 10:41 PM on the seed, Room 11 is free all night, Room 8 is free until 11:00 PM, and Room 2 is held for Sam O. until 10:45 PM.
  - [x] A party of 7 is given a medium room when one is free, and Room 11 (large) only when none is.
  - [x] A booking that would end after the 4:00 AM close is refused.
- **Tests:** integration tests for the exclusion, hold expiry, extensions and assignment, using fixtures beside the seed.
- **Notes:** Room 11 counts as fitting Rob & Kim's 7 and Amara B.'s 7, as the seed says, even though the large tier starts at 12.
  - **Built:** migration `0028_room_blocks.sql` (the spec's SQL with `btree_gist` and the exclusion, plus an id, the venue wall, the audit trigger, a hold-only `expires_at` and two venue-checked definer doors, `expire_room_holds` and `release_room_block`, because `app_rw` never deletes); `packages/db/src/blocks.ts` (`addBlock` turns an exclusion refusal into `RoomNotFree`, `blocksBetween`, `setBlockEnd`, `moveBlock`, `releaseBlock`, `expireHolds`); the pure rules in `packages/rules/src/assignment.ts` (`assignmentOrder`, `freeRoomsFor`, `chooseRoom` with the `past_close` and `no_room` refusals, `freeUntil`, `canExtend`); the venue side in `apps/api/src/rooms/assignment.ts` (`availability`, `freeFor`, `assignBooking` with a savepoint retry on a lost race, `extendSession`, and the night's close from M1-12); the hold sweep every 15 seconds (`apps/api/src/jobs/hold-sweep.ts`); `GET /rooms/availability?at=` (the board's free-until) and `GET /rooms/free?party=&from=&to=|minutes=`; the seed's 15 blocks (four confirmed bookings, eight sessions extended 15 minutes at a time to cover 10:41 PM, two rooms cleaning, Room 4 out of service).
  - **How "held for Sam O. until 10:45 PM" reads:** Sam's booking block covers 10:30 to 11:30; a booking whose party hasn't arrived is held until its start plus the deposit rule's grace (15 minutes), so the availability answer gives `held_until` 10:45 PM. No separate hold block is written.
  - **Cautious defaults:** a cleaning block ends when staff mark the room clean and at the latest at the night's 6:00 AM cutover, so a wipe left undone doesn't take the room off later nights (flagged; the spec's `cleaningEnds: "staff"` says only who ends it). A bigger tier is taken only when no smaller fitting room is free; when several bookings are placed at once, the largest parties go first. Room assignment for switched-off rooms (the M2-04 hook) moves bookings, which arrive in M2-06; the hook is filled in there.
### M2-06 · Build guests and staff bookings, each with a real room

- **Status:** done
- **Size:** M
- **Depends on:** M1-07, M1-17, M2-02, M2-05
- **Spec:** [Data model](../spec/04-data-model.md) · `guests`, `bookings`, Room assignment; [API](../spec/08-api.md) · Bookings; [Money rules](../spec/05-money-rules.md) 2 (the booking grid on the daylight-saving nights); [Payment flows](../spec/07-payment-flows.md) · Deposit when booking online, step 7
- **Build:**
  - `guests` (venue_id, name, phone_e164, email, locale, last_seen_at, erased_at), per venue and never shared. Their contact fields join the audit redaction list (M1-07).
  - `bookings` with every column in the data model, the statuses `pending`, `confirmed`, `checked_in`, `no_show`, `cancelled` and `completed`, and `source` `staff` (web comes in M5 and import in M9). `booked_by` (K9) is empty at West 4.
  - `GET`, `POST` and `PATCH /bookings`: every booking gets a real room (M2-05), guests see only the size tier, and staff can reassign the room. Booking limits come from `prices.booking` (hours, guests and start slots); past and overlapping slots are refused.
  - On the fall-back night the booking grid shows both 1 AM hours, labeled EDT and EST; on the spring-forward night it refuses times that don't exist.
  - `deposit_cents` from the deposit rule (M2-02). A booking that owes a deposit saves as `pending` with a `hold` block until M5's payment link collects it; with the deposit rule off it confirms at once.
  - `booking.updated` events.
- **Acceptance:**
  - [x] A staff booking for 6 on Sat Sep 26 at 9:30 PM for 2 hours gets a real room from Rooms 1–5 (never Room 4, which is out of service), owes a $60.00 deposit and saves as pending.
  - [x] A booking for tonight at 9:00 PM is refused (it's already 10:41 PM), and so is one in the VIP room from 11:00 PM, where Bianca L.'s party holds it until 12:30 AM.
  - [x] For Sat Oct 31, 2026 the grid offers 1:00 AM EDT and 1:00 AM EST; for Sat Mar 13, 2027 a 2:30 AM start is refused.
  - [x] The seed's 11 bookings load with their rooms, deposits and statuses.
- **Tests:** API integration tests; unit tests for the grid on both daylight-saving nights.
- **Notes:** The spec doesn't say how a staff booking confirms before M5's payment link exists. Cautious default built here: it stays `pending` with its hold, and `pending_until` is set when M5 sends the link; with the deposit rule off it confirms at once (flagged). West 4's booking limits aren't in the seed; they stay empty until Admin sets them (M2-34), and online booking in M5 needs them.
  - **Built:** migration `0029_guests_bookings.sql` (`guests`, per venue, with `phone_e164` and `email` added to the audit redaction list as the migrator role; `bookings` with every column in the data model, walled and audited); `packages/db/src/bookings.ts`; the grid rules in `packages/rules/src/booking-grid.ts` (`bookingGrid` walks real time 30 minutes apart from the opening to the last start that ends by the close, so the fall-back night offers 1:00 AM EDT and EST and the spring-forward night skips 2:00 to 2:59 AM; `resolveStart` turns a business date and "HH:MM" into an instant, refuses a skipped time, and needs the offset for a repeated one); the staff routes in `apps/api/src/routes/bookings.ts` (`GET /bookings`, `GET /bookings/grid`, `POST /bookings`, `PATCH /bookings/{b}` for room, party size or cancel); the M2-04 switch-off hook now moves each future booking to the smallest free room that fits, largest parties first, and lists any it can't; the seed's 17 guests and 11 bookings.
  - **What a staff booking checks:** the start isn't past and is on the night's grid; the length is within `prices.booking` (1 to 12 hours, at most 40 guests from the seed defaults); it ends by the close; the room staff picked fits, isn't out of service and is free, or assignment picks one. The deposit comes from M2-02's rule; a booking that owes one writes a `hold` block with no expiry and the refund cut-off 24 hours before its start.
  - **Cautious defaults:** with no start slots set, the grid offers every half hour (flagged). The seed's bookings load with source `web`, since their deposits were paid by card, and a refund cut-off 24 hours before their start.
### M2-07 · Build room sessions, clock segments and the live room clock

- **Status:** done
- **Size:** M
- **Depends on:** M1-09, M2-03, M2-05, M2-06
- **Spec:** [Data model](../spec/04-data-model.md) · `room_sessions`, `session_segments`; [Money rules](../spec/05-money-rules.md) 3 (Resume) and 4; [API](../spec/08-api.md) · Board and sessions; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Clocks
- **Build:**
  - `room_sessions` with every column in the data model (booked_by included) and `session_segments` (venue_id, session_id, room_id, started_at, ended_at, billable_guests, rate_kind, hourly_cents, band_id, increment_min, rounding, paused, reason, approved_by).
  - `PATCH /sessions/{s}`, `POST /sessions/{s}/end` and `POST /sessions/{s}/resume`: a session ended by mistake resumes within 10 minutes with the same room code and check.
  - The soft end: the booked end never stops the clock. With nobody booked next and `rooms.stayOnWhenFree` on, the room stays on by the minute, worded "Stay on by the minute until we close at 4 AM"; when a booking or a waitlist party needs the room, staff and the room screens get wrap-up prompts. Offers to stay on stop 30 minutes before the close, and at the close every room goes to wrap-up.
  - Room time so far from `packages/rules` on the server's times. Screens tick with the offset they measure from `server_time` and fetch the total again every minute. `room.updated` events.
- **Acceptance:**
  - [x] At 10:41 PM on the seed, Room 9 reads 161 minutes and $322.00, the VIP room 71 minutes and $295.83, and Room 5 41 minutes and $40.00 (the first-hour minimum).
  - [x] Room 10 (Tanya W., booked to 10:00 PM, nobody next) reads "Staying · 41 min past", keeps billing, and shows "Stay on by the minute until we close at 4 AM".
  - [x] Ending Room 5 by mistake at 10:50 PM and resuming it at 10:55 PM keeps its code and check, and room time bills straight through.
  - [x] At 3:30 AM no screen offers to stay on, and at the 4:00 AM close every room is in wrap-up.
- **Tests:** integration tests on the simulated clock; a Playwright test that a tile's clock ticks on the server's offset while the device clock is wrong.
- **Notes:** The spec doesn't say whether the minutes between a mistaken end and its resume are billed; since the party never left, this bills straight through (flagged). A walk-in's session opens through M2-11.
  - **Built:** migration `0030_room_sessions.sql` (`room_sessions` with every model column, `check_id` a plain id until checks arrive in M3, and `session_segments`, where a paused segment must carry `approved_by`); the pure clock in `packages/rules/src/session-clock.ts` (room time from the segments on the server's times; the tile, "In room · N min left", "Staying · N min past" with nobody next, "Needed now · N min past" with someone next; the stay-on offer while nobody is next, stopping 30 minutes before the close; wrap-up from the notice before a booked end when someone is next, and at the close); the service in `apps/api/src/rooms/sessions.ts` (live views, end, resume within 10 minutes, the soft end, and marking wrap-ups); `GET /sessions`, `GET /sessions/{s}`, `PATCH /sessions/{s}` (`booked_end_at`), `POST /sessions/{s}/end`, `POST /sessions/{s}/resume`; a wrap-up sweep every minute that moves rooms in use to `wrap_up`; the seed's eight sessions and segments; and the room clocks on Tonight (`apps/staff/src/screens/Tonight.tsx`), which tick on the measured server offset and refetch every minute and on `room.updated`.
  - **End and resume:** ending stops the open segment, ends the session's block, writes a cleaning block until the next booking or the cutover, and sets the room to cleaning. Resuming releases that cleaning block, reopens the same segment (so the minutes in between bill), runs the session's block on again, and sets the room back in use; the room code, token version and check are untouched. A resume after 10 minutes, or into a room someone else now has, is refused.
  - **Seed:** each session's block now ends at its planned end (Room 5's walk-in planned to midnight), which moves the M2-06 switch-off test's Nguyens to Room 9; the sessions' check ids are recorded in `seed_ids` for M3.
  - **Also:** the staff smoke tests' enrolment helper waits out a 429 from the sign-in rate limit, which a full smoke run now reaches.
  - **Later tickets:** the board itself (states, alerts, the waitlist) is M2-29; the walk-in check-in that opens a session is M2-11; moves, party-size changes and pauses that open new segments are M2-17 to M2-20.
### M2-08 · Open a room check for each session, numbered in order

- **Status:** todo
- **Size:** S
- **Depends on:** M1-03, M2-07
- **Spec:** [Data model](../spec/04-data-model.md) · The money core (`checks`, `check_lines`, `venue_counters` and their grants); [API](../spec/08-api.md) · Checks (`GET /checks/{c}`); [Security and data retention](../spec/12-security-retention.md) 4
- **Build:**
  - `checks`, `check_lines` and `venue_counters` exactly as the money-core SQL, with its grants. The rest of the money core (revisions, payments, attempts, allocations, payment events) comes in M4.
  - A room check opens at check-in (kind `room`, the business date, the session and the booking), and its number comes from `venue_counters` (`check`) in its own short transaction, before anything else.
  - `GET /checks/{c}` returns the lines, the tab so far and the number (#1042). Tax, gratuity, totals and revisions come with finalize in M4. `version` goes up with every line, and `check.updated` goes out.
  - The seed loader adds all 13 seeded checks and their lines, numbered in the order they opened with Room 9's #1042 fixed; the five bar checks' tabs join in M6.
- **Acceptance:**
  - [ ] Room 9's check is #1042, with its three drink lines adding up to $158.00.
  - [ ] Each new check takes the next number; two check-ins at the same moment get two different numbers, and no number is used twice.
  - [ ] `app_rw` can't change a line's `amount_cents` or delete a line.
- **Tests:** a concurrent numbering test; grant tests.
- **Notes:** The data model makes `checks.number` required, so the number is taken at open. M4 adds the gapless-sequence guarantees (a failed tap voids the check and keeps its number). No test may depend on a seeded check number other than #1042.

### M2-09 · Set up West 4's Twilio subaccount and send texts from `message_templates`

- **Status:** todo
- **Size:** M
- **Depends on:** M1-06, M1-13, M2-06
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Texts through Twilio, The automatic texts; [Data model](../spec/04-data-model.md) · `integrations`, `conversations`, `messages`, `message_templates`, `webhook_events`; [Security and data retention](../spec/12-security-retention.md) 8; [Demo seed · Texts and the inbox](../demo-seed.md#texts-and-the-inbox)
- **Build:**
  - West 4's own Twilio subaccount, made by us through Twilio's API, with its number, recorded in `integrations` (kind Twilio). `resolve_sms_number` (a definer function) maps a number to its venue.
  - `message_templates` (venue_id, key, category, body, on, updated_by) with the 14 texts in the spec's order and West 4's wording from the seed: 12 service texts (Booking confirmed, Reminder, Room code, Room ready, Offer expiring, Please wrap up, Booked time ending, Receipt, Deposit refund, Payment link, Running late reply, You're up next) and 2 marketing texts (Review ask, Birthday), both off.
  - `conversations` (venue_id, guest_id, phone_e164, context_kind, context_id, unread, assigned_to, last_inbound_at) and `messages` (venue_id, conversation_id, direction, template_id, category, body, sent_by, provider_sid, status, read_at, sent_at).
  - The sender, a job in the normal pool: it writes the message as `sending` before calling Twilio, so a retried job never sends twice. Twilio's status callbacks (`POST /v1/hooks/twilio/status`, signature checked before anything else, run once through `webhook_events`) move it to `sent`, `delivered` or `failed`.
  - Service texts go to the number the guest gave for that booking or waitlist spot. Only +1 numbers, with Twilio's SMS pumping protection on and rate limits per number prefix. A template that's off never sends, and with Guest texts off no service text sends.
  - Staging sends only to our own test phones.
- **Acceptance:**
  - [ ] A Room ready text to Amara B. is written as `sending`, then becomes `sent` and `delivered` from Twilio's callbacks.
  - [ ] The same send job retried after a crash sends nothing twice, and a repeated callback changes nothing.
  - [ ] A failed callback marks the message `failed`.
  - [ ] A text to a number outside +1 is refused, and staging refuses a number outside our test phones.
  - [ ] Review ask and Birthday never send.
- **Tests:** integration tests against Twilio's test credentials and a fake callback sender; a signature test for the webhook.
- **Notes:** Texts go live on West 4's registered 10DLC campaign in M8. Marketing texts need their own opt-in (M5) and campaign (M8).

### M2-10 · Build Admin → Phone & texts and Admin → Texts

- **Status:** todo
- **Size:** S
- **Depends on:** M1-31, M2-09
- **Spec:** [Admin by milestone](../milestones.md#admin-by-milestone) (Phone & texts, Texts); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `PhoneSettings`, `MessageSettings`; [Song systems and texts](../spec/11-song-systems-texts.md) · The automatic texts; [AdminDesk](../screens.md#admindesk) notes 13, 14 and 25
- **Build:**
  - Phone & texts: `phone.callNumber` (on the site, in texts, behind every Call button and "Call to book") and `phone.textNumber` (the Twilio number texts come from, which can be the call number itself), both E.164.
  - Texts: all 14 texts in order, each with its wording and whether it's on, plus `messages.reminderAt` and `messages.offerExpiringMin` (5). The two marketing texts show off and can't be turned on while the Marketing texts module is off.
  - West 4's wording, including "Booked. Room for 6 at 9:30 PM, Sat Sep 26. A 20% gratuity is added to room tabs. Deposit $60 paid, comes off your bill. Free to cancel until Fri 9:30 PM: west4karaoke.com/b/…" and "…Nobody's booked after you, so you can stay on by the minute until we close at 4 AM.". No text for an order on its way: "The bar needs a few minutes" and "On its way" are room-screen messages.
- **Acceptance:**
  - [ ] Admin → Texts lists exactly the 14 texts, in the spec's order, with West 4's wording.
  - [ ] Turning Reminder off stops it being sent.
  - [ ] Review ask and Birthday show off and can't be turned on.
  - [ ] Phone & texts shows West 4's number, +1 212 255 0011, for calls and texts.
- **Tests:** Playwright for each section; a test that the list matches the spec's 14.
- **Notes:** `messages.reminderAt` has no value for West 4 in the seed or the spec; the field stays empty until West 4 sets it (M2-24 sends nothing until then).

### M2-11 · Build the check-in sheet, walk-ins and Mark no-show

- **Status:** todo
- **Size:** M
- **Depends on:** M2-07, M2-08, M2-09
- **Spec:** [N10 Check-in sheet](../screens.md#n10-check-in-sheet); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · The board and staff phones (Check in); [API](../spec/08-api.md) · Bookings (`POST /bookings/{b}/check-in`, `/no-show`), Board and sessions (`POST /rooms/{r}/sessions`); [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Joining a room
- **Build:**
  - One sheet, the same on the board and on staff phones: 1. the party size, with the billable minimum ("3 guests · Fridays bill at least 4"); 2. IDs checked, "x of n", with "The runner checks the rest"; 3. the room, confirmed or changed to one that fits and is free; 4. the clock starting now or at the booked time; 5. the deposit, shown from the booking (−$40.00), allocated to the check once the payment core lands in M4; 6. a new 5-character room code, texted to the host with the join link (the Room code text).
  - `POST /bookings/{b}/check-in {party_size, ids_checked, room_id, start_at}`: the booking becomes `checked_in`, its block becomes the session's block, the session and its first segment open, the check opens (M2-08), and the ID count is recorded (M2-12). The room code never contains the room number; it's stored as `room_code_hash` with `token_version` 1, and the host's link carries a host token (`host_token_hash`).
  - [+ Walk-in] opens the same sheet with a free room. `POST /rooms/{r}/sessions` takes the check-in body plus a planned end and the guest's name and phone for the Room code text.
  - [Mark no-show] beside Check in: `POST /bookings/{b}/no-show`, allowed only after `deposit.graceMin` (15 minutes) past the start. It sets `no_show` and frees the room's block.
  - A booking whose party isn't there shows Late on its tile, with its room held until `running_late_until` (set by the Running late reply in M2-22).
- **Acceptance:**
  - [ ] At 10:44 PM, checking in Sam O. with 3 guests shows "3 guests · Fridays bill at least 4" and his −$40.00 deposit, and texts his number a new 5-character code (never containing "2") with the join link.
  - [ ] His room time bills 4 × $10.00 an hour with the one-hour minimum: $40.00.
  - [ ] [Mark no-show] isn't shown, and the API refuses it, at 10:44 PM; from 10:45 PM it's shown, and marking it frees Room 2.
  - [ ] [+ Walk-in] on Room 11 opens the same sheet with Room 11 filled in and seats the party with a new code.
  - [ ] Checking a party into a room that doesn't fit, or isn't free, answers `409 room_not_free`.
- **Tests:** API integration tests on the simulated clock; Playwright for the sheet on the board and on a phone.
- **Notes:** [Board](../screens.md#board) note 1 and [Staff](../screens.md#staff) notes 2 and 13. The join page the link opens is built in M3 (M3-08). The check-in body has no planned end, which a walk-in needs (Leo M. has 2 hours); this adds one to the walk-in route (flagged). What a no-show does to the deposit (a `fee` check with a `forfeit` line, or a first-hour charge) comes in M4 and M5. The spec doesn't say whether Mark no-show waits for a running-late hold that ends after the grace; cautious default: it waits for the later of the two (flagged).

### M2-12 · Record ID checks at check-in

- **Status:** todo
- **Size:** M
- **Depends on:** M1-02, M2-11
- **Spec:** [Data model](../spec/04-data-model.md) · `id_checks`; [API](../spec/08-api.md) · Safety (`POST /sessions/{s}/id-checks`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · the rule pack's `idScan`; [Security and data retention](../spec/12-security-retention.md) 6 and How long we keep things; [Open technical questions](../spec/14-open-questions.md); [N10 Check-in sheet](../screens.md#n10-check-in-sheet) (step 2)
- **Build:**
  - `id_checks` (venue_id, session_id or check_id, order_id, checked_by, checked_at, method, scanned_fields, key_id, delete_after) and `POST /sessions/{s}/id-checks`.
  - At check-in, the "x of n" count writes one visual row per person checked, recording only who checked and when.
  - A scan is read on the device that took it, through a barcode library that runs there and never through an ID vendor's cloud. Only the rule pack's four fields (name, date of birth, ID number, expiration) are kept, encrypted with a key for the venue and the business date from the key service, with `delete_after` set by `idScan.keepDays` (7 days).
  - The "ID ✓ x of n" chip counts the session's rows against its party size. ID checks are never in the org-wide read scope or any export. With Safety & ID records off, scanning is hidden and the count stays.
- **Acceptance:**
  - [ ] Room 1 shows "ID ✓ 3 of 4 · the runner checks the last ID", and Room 5 "ID ✓ 4 of 4".
  - [ ] Checking in Sam O.'s 3 guests with all 3 IDs checked writes three visual rows.
  - [ ] A scan keeps only the four fields, encrypted with West 4's key for Fri Sep 25, with `delete_after` Fri Oct 2.
  - [ ] An org-scope read of `id_checks` returns nothing.
  - [ ] With Safety & ID records off, the scan button is gone and Room 5 still reads "ID ✓ 4 of 4".
- **Tests:** integration tests for the rows, the encryption and the org scope; a unit test of the four-field filter on sample barcodes.
- **Notes:** How long scans may be kept is open with the lawyer; this builds the rule pack's 7-day default ([Open technical questions](../spec/14-open-questions.md)). Destroying each night's key after 7 days is M8, the runner's check at the room (`order_id`) is M3, and a bar tab's is M6.

### M2-13 · Build presigned uploads with type and size limits

- **Status:** todo
- **Size:** S
- **Depends on:** M1-02, M1-08
- **Spec:** [Data model](../spec/04-data-model.md) · `files`; [API](../spec/08-api.md) · Files; [Security and data retention](../spec/12-security-retention.md) · How long we keep things (Files)
- **Build:**
  - `files` (venue_id, kind, storage_key, content_type, bytes, sha256, uploaded_by, uploaded_at, attached_at).
  - `POST /files` takes the kind, type and size and returns a presigned POST and a file id; storage refuses any other type or a bigger file. Photos (damage, slip, paid-out, lost item) are JPEG, PNG or HEIC up to 10 MB; license copies PDF, JPEG or PNG up to 20 MB; songbook CSVs up to 5 MB; dispute evidence whatever Stripe's Files API takes.
  - `GET /files/{f}` returns a short-lived download link. A file counts once a row that needs it attaches it (`attached_at`), and a job deletes unattached uploads after 24 hours.
- **Acceptance:**
  - [ ] A 4 MB JPEG damage photo uploads; a 12 MB photo, or a PDF sent as a damage photo, is refused by storage.
  - [ ] An upload nothing attaches is gone 24 hours later on the simulated clock.
  - [ ] A download link stops working when it expires, and venue B can't get one for venue A's file.
- **Tests:** integration tests against the local S3 store.
- **Notes:** M2 uses damage and lost-item photos first; the menu PDF (M3) and receipt PDFs (M4) are files too.

### M2-14 · Write the reason-only limit test-first and total it per person

- **Status:** todo
- **Size:** S
- **Depends on:** M1-04, M2-08
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · The reason-only limit; [Money rules](../spec/05-money-rules.md) 7; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `PosSettings.reasonOnly`
- **Build:**
  - `reasonOnly(usedThisShiftCents, amountCents, { eachCents, perShiftCents })` in `packages/rules`, returning whether approval is needed, whether it's over each limit, the shift total after and what's left before.
  - Limits from `pos.reasonOnly`: 2500 and 7500 cents at West 4; 0 sends every comp and void for approval.
  - `reasonOnlyUsed(membership)`: the sum of that person's reason-only comp and void lines from every screen (the bar POS, Room, DeskRoom and the board), leaving out practice checks (M7), and the "$X left this shift" figure the fix panel shows (M3-19).
- **Acceptance:**
  - [ ] Every case in the `reason_only_limits` group passes: Maya, with $12.00 used, comps $13.00 with a reason and no approval, leaving "$50 left this shift"; $25.00 exactly needs only a reason and $25.01 needs approval; a shift total of exactly $75.00 needs only a reason and $75.01 needs approval; Diego's $70.00 void needs approval.
  - [ ] Comp 15 min of room time is $10.00 in Room 5 (4 guests), a reason is enough, and $30.00 in Room 9 (12 guests), which needs approval.
  - [ ] After the seed loads, Maya's total is $12.00 (her COMP of a Jäger Bomb on Luis M.'s check), so she has $63 left.
- **Tests:** the `reason_only_limits` group (8 cases), written first; an integration test of the per-person total across two screens.
- **Notes:** The spec totals the limit over the person's open shift, which needs the time clock (M7). Until then the window is the business date, which can only make the limit stricter (flagged); M7 moves it to the shift. Money-cases ambiguity A2 (voids that resolve a returned order) is decided in M3-06.

### M2-15 · Build approvals, their routing and the Approvals inbox

- **Status:** todo
- **Size:** M
- **Depends on:** M1-09, M1-19, M1-22
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Approvals; [Data model](../spec/04-data-model.md) · `approvals`; [API](../spec/08-api.md) · Approvals, Conventions (Approvals); [N18 Approvals inbox](../screens.md#n18-approvals-inbox); [Staff](../screens.md#staff) note 6
- **Build:**
  - `approvals` with every column in the data model and the statuses `pending`, `approved`, `declined` and `expired`. M2 uses the kinds `clock_pause` and `comp` (room time over the limit); `void` joins in M3, `refund`, `card_on_file` and `party_size_down` in M4, `tip_review` and `over_hold` in M6, and `paid_out` in M7.
  - Routing: to the manager on duty; the manager on duty's own requests go to another manager or the owner (Andy's go to Abhishek); the owner's go to a manager. Nobody approves their own request.
  - `manager_on_duty(venue, at)`, one function that every caller uses (approvals now, room-order escalation in M3, alerts). Its source is the time clock's open Manager duty, which lands in M7; until then it reads a stand-in row per business date, `duty_managers` (venue_id, business_date, membership_id), which the seed fills with Andy and M7 removes. M1's device and PIN-pause alerts now go to the manager on duty.
  - A route that needs approval answers `202 approval_pending` with the approval and who it waits for; the payload says what happens when it's approved, and that runs on approval. `GET /approvals?status=pending`, `GET /approvals/{a}` and `POST /approvals/{a}/decide`, which works only from the approver's own phone (their `staff_phone`) in a passkey session, never from the requester's device and never for the requester. A request whose target is gone becomes `expired`.
  - `approval.requested` and `approval.decided`, and a push to the approver's phone.
  - The Approvals inbox on managers' and owners' phones: "Approvals · N", each request with its line, amount, reason, who asked and when, and [Approve] and [Decline]. The requester's screens show "Waiting for Andy", then the decision.
- **Acceptance:**
  - [ ] The `approvals` cases pass: Diego's and Maya's requests go to Andy, and Andy's go to Abhishek.
  - [ ] An approval can't be decided by its requester, from the requester's device, from a shared screen, or in an authenticator or PIN session.
  - [ ] Andy's phone shows "Approvals · 1" with the line, amount, reason, who asked and when, while the requester's screen shows "Waiting for Andy".
  - [ ] A declined request changes nothing, and the requester sees the decision.
- **Tests:** the `approvals` group (3 cases), written first; the approval half of spec 13's role and approval tests.
- **Notes:** The spec defines the manager on duty through the time clock, which comes in M7, but approvals start here; the `duty_managers` stand-in is the cautious bridge (flagged). The seed's pending void (Diego's, on Tariq A.'s check) loads in M3, once voids can run.

### M2-16 · Report faults: out of service, pause the clock and comp 15 minutes

- **Status:** todo
- **Size:** M
- **Depends on:** M2-07, M2-14, M2-15
- **Spec:** [N14 Report a fault](../screens.md#n14-report-a-fault); [Data model](../spec/04-data-model.md) · `room_faults`; [Money rules](../spec/05-money-rules.md) 3 (Pauses and faults) and 7; [API](../spec/08-api.md) · Room care, Board and sessions (`/pause`, `/unpause`, `/comp-minutes`)
- **Build:**
  - `room_faults` (venue_id, room_id, session_id, text, reported_by, reported_at, out_of_service, pause_segment_id, comp_line_id, fixed_by, fixed_at); `POST /rooms/{r}/faults` and `PATCH /faults/{f}` (marks it fixed). Report a fault on the board and DeskRoom logs it with three choices:
  - Out of service: the room's state and an `out_of_service` block; assignment re-runs for its future bookings and lists any that no longer fit for a manager; its tablet goes off.
  - Pause the clock: `POST /sessions/{s}/pause` always needs approval (`clock_pause`, with a reason). Once approved, it closes the segment and opens a paused one that bills nothing, with `approved_by`. `POST /sessions/{s}/unpause` starts billing again.
  - Comp 15 min of room time: `POST /sessions/{s}/comp-minutes`, a reason-only comp of 15 minutes at the segment's rate under the same limits as any other (M2-14): a `comp` line with `tax_category` `room_time`, linked from `room_faults.comp_line_id`.
  - Open faults show on the room's tile.
- **Acceptance:**
  - [ ] A clock-pause request from Diego on the front-desk computer lands in Andy's Approvals inbox on Andy's phone and never on the front-desk computer or Diego's phone, and Diego's screen shows "Waiting for Andy".
  - [ ] Andy approves on his phone and the clock stops billing from that minute; Andy's own pause request goes to Abhishek.
  - [ ] Comp 15 min in Room 5 writes a −$10.00 comp line at once with its reason; in Room 9 it's $30.00 and waits for approval.
  - [ ] Room 4 shows "Out of service" with "Mic dead since Tue. Replacement ordered." (logged Tue Sep 22), and its tablet is off.
  - [ ] Marking a fault fixed takes it off the tile.
- **Tests:** API integration tests on the simulated clock; Playwright for the sheet on the board and DeskRoom.
- **Notes:** [Board](../screens.md#board) note 8 and [DeskRoom](../screens.md#deskroom) note 6. Room-time lines are computed at finalize (M4), so a room-time comp has no stored line to point at; it's stored as a `comp` line with `tax_category` `room_time`, `source_id` the segment and an empty `reverses_id` (flagged).

### M2-17 · Build the party-size control

- **Status:** todo
- **Size:** S
- **Depends on:** M2-07
- **Spec:** [N13 Party size control](../screens.md#n13-party-size-control); [Money rules](../spec/05-money-rules.md) 3 (Party size); [API](../spec/08-api.md) · Board and sessions (`/party-size`)
- **Build:** + and − on the board panel, DeskRoom and the Room phone. `POST /sessions/{s}/party-size` closes the current segment on the minute, opens the next with the new billable guests and rate, and returns the new hourly rate and billable minimum. The "ID ✓ x of n" chip follows the new size, and the VIP rate starts or stops as a VIP-room party crosses 20.
- **Acceptance:**
  - [ ] Raising Room 9 from 12 to 14 at 10:41 PM closes the 161-minute segment and shows $140.00 an hour; at 11:11 PM room time is $392.00.
  - [ ] Lowering Sam O.'s party from 3 to 2 on a Friday shows the minimum of 4 still billed, at $40.00 an hour.
  - [ ] Bianca L.'s party going from 22 to 19 in the VIP room changes the rate from $250.00 to $190.00 an hour from that minute.
  - [ ] Room 9's chip reads "ID ✓ 12 of 14" after the change.
- **Tests:** integration tests on the simulated clock.
- **Notes:** Lowering the party size after the gratuity applies needs approval (`party_size_down`), which M4 adds with the gratuity; until then it needs none.

### M2-18 · Move a room with the move sheet

- **Status:** todo
- **Size:** M
- **Depends on:** M2-05, M2-07, M2-11
- **Spec:** [N12 Move sheet](../screens.md#n12-move-sheet); [Data model](../spec/04-data-model.md) · Room assignment; [API](../spec/08-api.md) · Board and sessions (`/move-options`, `/move`); [Money rules](../spec/05-money-rules.md) 3
- **Build:**
  - The Move sheet on the board, DeskRoom, the Room phone and the staff phone. `GET /sessions/{s}/move-options` lists the rooms that fit the party and are free for the time needed, each with its free-until time; occupied, cleaning and too-small rooms are greyed out with the reason.
  - `POST /sessions/{s}/move` anywhere else answers `409 room_not_free`. Otherwise, in one transaction: the segment closes and the next opens in the new room on the minute, the session's block moves, a new room code is issued, `token_version` goes up so the old code stops working, the old room goes to cleaning, and the check stays one check.
  - `room.updated` for both rooms, and an event on the session's room channel so joined phones can show "You've moved to Room 11 · new code …" (the guest page is M3).
- **Acceptance:**
  - [ ] The move sheet for Rob & Kim (7, in Room 7) lists Room 11, free all night, and greys out the other rooms with the reason each can't be used.
  - [ ] Moving them opens a segment in Room 11 at the same $70.00 an hour, issues a new 5-character code, stops the old code working and sends Room 7 to cleaning for the Parks at 11:00 PM.
  - [ ] A move into Room 8 answers `409 room_not_free`.
  - [ ] Room 7's check keeps every line and stays one check.
- **Tests:** API integration tests; Playwright for the sheet from the board's alert and from DeskRoom.
- **Notes:** [Board](../screens.md#board) note 6, [Staff](../screens.md#staff) note 7. "Free for the time needed" isn't defined for a party already past its booked end; cautious default: the rest of the booked time, or past the end one 15-minute extension step (the step a session extends by), plus cleaning (flagged).

### M2-19 · Run cleaning, room notes and lost and found

- **Status:** todo
- **Size:** S
- **Depends on:** M2-07, M2-13
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `RoomSettings`; [Data model](../spec/04-data-model.md) · `room_notes`, `lost_items`, `room_blocks`; [N15 Lost and found](../screens.md#n15-lost-and-found); [Board](../screens.md#board) notes 9 and 15
- **Build:**
  - A session that ends or moves sends its room to cleaning: the `cleaning` state and a block for the room's cleaning minutes. With `rooms.cleaningEnds` `staff` (West 4) the room stays cleaning until someone marks it clean; with `timer` it ends by itself. The board flags a room still cleaning after `rooms.cleaningFlagMin` (8 minutes), and the tile reads "Needs a wipe · left 10:33 PM (8 min)". Marking a room clean changes no booking.
  - `room_notes` (venue_id, room_id, text, added_by, added_at, cleared_at) and `POST /rooms/{r}/notes`; notes stay with the room.
  - `lost_items` with every column in the data model; `GET`, `POST` and `PATCH /lost-items`. The board's lost and found reads "Found in Room 9 · kept at the bar · claimed by …", with a photo when staff take one; `room_id` is empty for something found at the bar.
- **Acceptance:**
  - [ ] Room 6 reads "Needs a wipe · left 10:33 PM (8 min)" at 10:41 PM and is flagged by 10:42 PM; Room 13 (left 10:36 PM) isn't flagged at 10:41 PM.
  - [ ] Marking Room 6 clean makes it Open and leaves every booking as it was.
  - [ ] Room 6 keeps its note, "TV remote goes missing. Check under the couch."
  - [ ] A lost item logged in Room 9 with a photo reads "Found in Room 9 · kept at the bar", and "claimed by …" once someone claims it.
- **Tests:** integration tests on the simulated clock; Playwright for the lost-and-found log.
- **Notes:** A paid check sends its room to cleaning from M4. The signed cleaning checklist is phase 2.

### M2-20 · Send room calls to the board and every staff phone's Calls list

- **Status:** todo
- **Size:** S
- **Depends on:** M1-22, M2-07
- **Spec:** [N19 Calls list](../screens.md#n19-calls-list); [Data model](../spec/04-data-model.md) · `room_calls`; [API](../spec/08-api.md) · Live events (`room.call`); [Staff](../screens.md#staff) note 9
- **Build:**
  - `room_calls` (venue_id, session_id, kind, created_at, acked_by, acked_at), with the kinds another mic, TV, check and other.
  - `room.call` reaches the board and every staff phone's Calls list, with a push. [On it] records who and when and clears it everywhere.
  - A "TV or song isn't working" call can be logged as a fault in one tap (M2-16).
  - The guest's Call staff button comes with the room page in M3, where the guest reads "Staff get it on their phones".
- **Acceptance:**
  - [ ] The seed's Room 9 call, "Another mic, please" at 10:39 PM, shows as a pink board alert with [On it] and in the Calls list on Andy's, Maya's and Diego's phones, with a push.
  - [ ] Diego's On it clears it on the board and on every phone, and records Diego and the time.
  - [ ] A "TV or song isn't working" call becomes a fault on its room with one tap.
- **Tests:** integration tests; Playwright for the Calls list on a phone.
- **Notes:** Help alerts are incidents, not calls, and come in M8.

### M2-21 · Add the damage fee with a photo

- **Status:** todo
- **Size:** S
- **Depends on:** M2-08, M2-13
- **Spec:** [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · The board and staff phones (Damage fee); [API](../spec/08-api.md) · Checks (`POST /checks/{c}/lines`); [Money rules](../spec/05-money-rules.md) 8 and 9; [Room](../screens.md#room) note 6
- **Build:** the $150.00 damage fee (`prices.damageFeeCents`) on the room tab on desktop and phone. `POST /checks/{c}/lines` with kind `damage` needs a photo (a `file_id` from `POST /files`, from the camera or an upload) and a reason. The line shows the photo's thumbnail and has `tax_category` `damage`; it's taxed and kept out of the gratuity base when M4 works those out. No screen says "photo attached" without a photo.
- **Acceptance:**
  - [ ] Adding a damage fee to Room 9 without a photo is refused.
  - [ ] With a camera photo and a reason, a $150.00 damage line shows the thumbnail, and Room 9's tab so far goes from $480.00 to $630.00.
  - [ ] The attached photo survives the 24-hour cleanup of unattached uploads.
- **Tests:** API integration tests; Playwright on a phone with a fake camera.
- **Notes:** None.

### M2-22 · Take replies into the two-way inbox, on Messages desktop and phone

- **Status:** todo
- **Size:** M
- **Depends on:** M2-09
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Two-way inbox; [API](../spec/08-api.md) · Messages, Webhooks in (`/v1/hooks/twilio`), Live events (`message.received`); [Messages](../screens.md#messages); [DeskMessages](../screens.md#deskmessages); [Demo seed · Texts and the inbox](../demo-seed.md#texts-and-the-inbox)
- **Build:**
  - Incoming texts arrive on `POST /v1/hooks/twilio` (signature first, run once through `webhook_events`), resolved to the venue with `resolve_sms_number`, into the guest's conversation, tied to its booking, waitlist spot or room session, marked unread, with an assignee. `message.received` updates the board, the message badges and the phone of the manager on shift.
  - Matching: the number's open conversation; otherwise its context tonight, in this order: an open room session, a waiting waitlist entry, tonight's booking, then the next booking.
  - `GET /conversations`, `GET /conversations/{c}` and `POST /conversations/{c}/messages`. Staff type free text only as a reply in an open service conversation, with links and promotions blocked; a template text can be sent in a conversation too.
  - The Running late reply: on Sam O.'s "running 15 late", [Reply "no problem"] sends "No problem. We'll hold your room until 10:45 PM." and sets `bookings.running_late_until` (by default the start plus `deposit.graceMin`; staff can change the time before sending), so Room 2 reads "Open · held for Sam O. until 10:45".
  - Messages on the desktop and the phone: the threads, and the list of the 14 automatic texts in order with whether each is on.
- **Acceptance:**
  - [ ] Sam O.'s "running 15 late" (10:24 PM) lands unread in Messages on his 10:30 PM Room 2 booking, and the board, the badges and Andy's phone update.
  - [ ] [Reply "no problem"] sends the Running late reply, and Room 2 reads held until 10:45.
  - [ ] A free-text reply with a link ("west4karaoke.com/book") is refused.
  - [ ] Marcus T.'s and Bianca L.'s threads read as in the seed, and both Messages screens list the same 14 texts in Admin's order.
- **Tests:** webhook integration tests with signed fixtures; Playwright for both Messages screens.
- **Notes:** [Messages](../screens.md#messages) and [DeskMessages](../screens.md#deskmessages) notes 1–5. The spec ties each reply to its booking, waitlist spot or room session but doesn't say how to choose between them; the order above is the cautious reading (flagged). "The manager on shift" is the manager on duty (M2-15). The Payment link goes out through its own template in M5.

### M2-23 · Honor STOP and HELP at once

- **Status:** todo
- **Size:** S
- **Depends on:** M2-22
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Consent and timing; [Data model](../spec/04-data-model.md) · `consents`; [API](../spec/08-api.md) · Messages (`POST /messages/{m}/opt-out`); [Must-fix items](../milestones.md#must-fix-items-and-where-they-close) (GA-M3); [Messages](../screens.md#messages); [DeskMessages](../screens.md#deskmessages)
- **Build:**
  - `consents` (venue_id, guest_id, channel, kind, given_at, source, text_version, ip, revoked_at, revoked_via).
  - Incoming texts are checked for opt-out wording: STOP, and other reasonable ways to say it, such as STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT or "stop texting me". Staff can mark one with a tap (`POST /messages/{m}/opt-out`). One confirmation goes back.
  - Every send checks for an opt-out before it writes `sending`, so every text to that number stops at once.
  - HELP gets the venue's name and phone number.
- **Acceptance:**
  - [ ] After Sam O. texts STOP, every text to his number stops at once: the Room code text at his check-in is never sent.
  - [ ] He gets one confirmation and nothing after it.
  - [ ] "please stop texting me" is caught too, and staff can mark an opt-out with one tap.
  - [ ] HELP gets "West 4 Boho Karaoke" and +1 212 255 0011.
- **Tests:** unit tests for the opt-out wording; integration tests for the send path after an opt-out.
- **Notes:** Keeping an opt-out as a hash after a guest is erased is M8. GA-M3 closes in M8: STOP here, the marketing opt-in in M5 and the campaign in M8.

### M2-24 · Send the Reminder and the wrap-up texts on their triggers

- **Status:** todo
- **Size:** S
- **Depends on:** M2-05, M2-07, M2-09
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · The automatic texts; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `AlertSettings`, `MessageSettings`; [Money rules](../spec/05-money-rules.md) 4
- **Build:**
  - Jobs in the normal pool, each sent once per trigger (its `dedupe_key`):
  - Reminder, on the day of a confirmed booking at `messages.reminderAt`.
  - Please wrap up, `alerts.roomEndingMin` (10) minutes before the booked end when someone is booked next; Booked time ending at the same time when nobody is ("…Nobody's booked after you, so you can stay on by the minute until we close at 4 AM."). No offer to stay on goes out in the last 30 minutes before the close.
  - The board's buttons ([Text Rob & Kim: please wrap up]) send Please wrap up by hand.
  - The other texts send from their own tickets: Room code (M2-11), Room ready and Offer expiring (M2-26) and the Running late reply (M2-22). Booking confirmed, Receipt, Deposit refund, Payment link and You're up next come with the milestones that raise their events (M4, M5 and M6).
- **Acceptance:**
  - [ ] At 10:50 PM, Marcus T. gets "Your booked time in Room 9 ends at 11:00 PM. Nobody's booked after you, so you can stay on by the minute until we close at 4 AM." once.
  - [ ] With a booking added in Room 1 at 11:30 PM, Dana K. gets Please wrap up at 11:20 PM instead of Booked time ending.
  - [ ] While `messages.reminderAt` is empty, no Reminder goes out.
  - [ ] A text switched off in Admin → Texts isn't sent.
- **Tests:** job tests on the simulated clock.
- **Notes:** West 4's reminder time isn't in the seed or the spec; cautious default: no Reminder until West 4 sets one (flagged).

### M2-25 · Build the waitlist: entries, the guest page behind the door QR, and the drawer

- **Status:** todo
- **Size:** M
- **Depends on:** M1-08, M2-06, M2-09
- **Spec:** [N11 Waitlist drawer](../screens.md#n11-waitlist-drawer); [Waitlist](../screens.md#waitlist); [Data model](../spec/04-data-model.md) · `waitlist_entries`; [API](../spec/08-api.md) · Waitlist; [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what (Guest with a link); [Demo seed · Waitlist](../demo-seed.md#waitlist)
- **Build:**
  - `waitlist_entries` with every column in the data model and the statuses `waiting`, `offered`, `seated`, `declined`, `expired` and `left`.
  - Staff: `GET /waitlist`; adding a party from the drawer (`POST /waitlist`) with its name, mobile, party size and quote; `POST /waitlist/{w}/remove`; and Text, which opens the entry's conversation (M2-22).
  - The guest page behind the door QR, in the guest web: `POST /v1/public/venues/{slug}/waitlist` with name, mobile and party size (a party of 3 is allowed and "bills as 4 on Friday"; the CAPTCHA and limits come in M2-27). It returns a link token (128 bits, stored hashed, expiring) for `GET` and `PATCH /v1/public/waitlist/{token}`: the place in line from the live list ("3 parties ahead"), leaving, and declining an offer ("give it away").
  - The drawer on the board, opened from "Waitlist · 3", and the staff phone's Waitlist tab: each row with the party size, joined time, quote and wait, and Offer a room, Text and Remove. "+ Add a walk-in" opens check-in with a free room.
  - `waitlist.updated` events.
- **Acceptance:**
  - [ ] The drawer lists Amara B. (7, joined 10:15 PM, quoted 25 min, waited 26), Nadia K. (6) and Chris P. (3, bills as 4), and the board reads "Waitlist · 3".
  - [ ] A guest who joins from the door QR as a party of 4 is fourth, and their page reads "3 parties ahead".
  - [ ] Remove takes a party off every screen at once.
- **Tests:** API integration tests; Playwright for the guest page on a phone and for the drawer.
- **Notes:** [Waitlist](../screens.md#waitlist) notes 1, 3 and 4 now; note 5's "Sing at the bar" link opens the singer's queue page, which comes in M6, so it's left off until then. The API table has no staff route to add a party, though staff add entries; this adds `POST /waitlist` (flagged). The spec doesn't say how a guest who joins from the page gets a quote; cautious default: staff set quotes, and the page shows a quote only once one is set (flagged). The spec sets languages only for staff screens, so guest pages ship in English with their strings in the catalog.

### M2-26 · Offer a waiting party a room: hold it 10 minutes, text, count down and expire

- **Status:** todo
- **Size:** M
- **Depends on:** M2-05, M2-09, M2-25
- **Spec:** [N11 Waitlist drawer](../screens.md#n11-waitlist-drawer); [Data model](../spec/04-data-model.md) · Room assignment; [API](../spec/08-api.md) · Waitlist (`/offer`, `/seat`); [Song systems and texts](../spec/11-song-systems-texts.md) · The automatic texts (Room ready, Offer expiring)
- **Build:**
  - `POST /waitlist/{w}/offer` picks the smallest room that fits and is free for an hour, or a bigger one that no booking tonight needs, and places a `hold` block that expires in 10 minutes. It sends the Room ready text ("Your room is ready: Room 11. You have 10 minutes to claim it at the front desk."), keeps `offer_message_id`, and shows a countdown on the drawer, the board and the guest's page ("Room 11 is ready · 10:00 to claim it").
  - A Room ready text that fails shows "Not delivered · Call (212)…" on the row, with the guest's number.
  - The Offer expiring text goes out with `messages.offerExpiringMin` (5 minutes) left.
  - `POST /waitlist/{w}/seat` opens check-in (M2-11) in the held room.
  - An offer not taken in 10 minutes expires: a job releases the hold and offers the room to the next party that fits. A guest who declines ("give it away") releases it the same way.
  - The board's lime alert, [Offer Room 11 · 10 min to claim], runs this.
- **Acceptance:**
  - [ ] Offering a room to Amara B. picks Room 11, holds it for 10 minutes with a countdown and texts her the Room ready text.
  - [ ] If the text fails, her row shows "Not delivered · Call" with her number.
  - [ ] With 5 minutes left she gets Offer expiring; at 10 minutes the hold is released and Room 11 is offered to Nadia K. (6), the next party that fits.
  - [ ] Seat opens check-in in Room 11 for Amara's party of 7.
  - [ ] After Sam O.'s no-show at 10:45 PM, an offer to the guest who joined fourth reads "Room 2 is ready · 10:00 to claim it" on their page.
- **Tests:** API integration tests on the simulated clock with a fake failing text; Playwright for the countdown on the board and the guest page.
- **Notes:** Room 8 isn't free for an hour (the Nguyens at 11:00 PM), so it's never offered. [Board](../screens.md#board) note 2, [Waitlist](../screens.md#waitlist) note 2.

### M2-27 · Add the server-checked CAPTCHA and daily limits to the waitlist page and phone codes

- **Status:** todo
- **Size:** S
- **Depends on:** M1-23, M2-25
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 8; [API](../spec/08-api.md) · Waitlist (public routes check a CAPTCHA); [Waitlist](../screens.md#waitlist) note 4
- **Build:** a CAPTCHA checked on the server on `POST /v1/public/venues/{slug}/waitlist` and on every phone-code send (staff invites now, singers in M6), and daily limits per phone number, IP address and device on both, kept in one place in the code.
- **Acceptance:**
  - [ ] A waitlist join without a valid CAPTCHA token is refused, and so is a phone-code request.
  - [ ] Past the daily limit, another join from the same phone number, IP address or device is refused, and the next day it works again.
- **Tests:** integration tests with the provider's test keys.
- **Notes:** The spec names no CAPTCHA provider and no limit numbers; the founder picks the provider and sets the numbers (flagged). Booking and enquiries get the same checks in M5.

### M2-28 · Count the headcount with the door counter, and build Admin → Safety

- **Status:** todo
- **Size:** S
- **Depends on:** M1-31, M2-07, M2-25
- **Spec:** [N31 Occupancy warning and door counter](../screens.md#n31-occupancy-warning-and-door-counter); [N36 Admin → Safety](../screens.md#n36-admin--safety); [Data model](../spec/04-data-model.md) · `door_counts`; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `SafetySettings`; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Safety
- **Build:**
  - `door_counts` (venue_id, business_date, delta, counted_by, device_id, at) and `POST /door-counts` (+1 or −1), from a counter on the front desk's board.
  - The headcount: open sessions' party sizes, plus waiting parties, plus door counts (M6 adds people on bar tabs), against `safety.occupancyLimit`. The board warns when it reaches `safety.warnAtPct` (90%) of the limit. With no limit set, the board shows "Limit not set · Admin → Safety" and no limit number, never a made-up one. `headcount.updated` events.
  - Admin → Safety: the occupancy limit (empty at West 4) and the warning share (90%).
- **Acceptance:**
  - [ ] With no occupancy limit set, the board shows "Limit not set · Admin → Safety" and no limit number.
  - [ ] On the M2 seed the board reads 93 inside (77 in rooms, 16 waiting); it reads 98 once M6 counts the 5 on bar tabs.
  - [ ] A +1 on the door counter makes it 94 at once, and a −1 takes it back.
  - [ ] In a test venue with a limit of 100, the board warns at 90 inside and not at 89.
- **Tests:** integration tests; Playwright for the board's headcount and the counter.
- **Notes:** A 90% warning appears at West 4 only on a demo limit labeled "Demo" ([Counts at 10:41 PM](../demo-seed.md#counts-at-1041-pm)); never guess one. The help alert and incidents join Admin → Safety in M8.

### M2-29 · Build the Tonight board: tiles, states, clocks and counts

- **Status:** todo
- **Size:** M
- **Depends on:** M1-21, M2-07, M2-08, M2-11, M2-16, M2-19, M2-20, M2-28
- **Spec:** [Board](../screens.md#board); [API](../spec/08-api.md) · Board and sessions (`GET /board`); [Glossary · Room state](../glossary.md#rooms-time-and-bookings); [Demo seed · Rooms at 10:41 PM](../demo-seed.md#rooms-at-1041-pm); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `AlertSettings`
- **Build:**
  - `GET /board`: each room's state, `free_until`, open faults and alerts, its tab so far, and the headcount.
  - Tiles for the 14 rooms in the glossary's words ("In room · 19 min left", "Staying · 41 min past", "Needed now · 11 min past", "Wrap up · 4 min left", "Needs a wipe · left 10:33 PM (8 min)", "Open · held for Sam O. until 10:45", "Open · next 11:00", "Open · free all night", "Out of service"), with the party, the ID chip, the deposit and the tab so far. A tile turns amber `alerts.roomEndingMin` (10) minutes before its booked end and red once the room runs over.
  - The counts: rooms in use, open, cleaning and out of service. The tile panel: check-in and Mark no-show for arriving and late bookings, party size, move, faults, calls, notes and lost and found.
  - The desktop side menu from the modules and the role: Tonight, Calendar, Messages, Admin and Lock now, the rest as their screens ship.
  - Live through `room.updated`, `booking.updated`, `waitlist.updated` and `headcount.updated`; clocks tick on the server's offset, and totals refetch every minute.
- **Acceptance:**
  - [ ] At 10:41 PM on the seed every tile, clock and "Room time so far" matches the seed to the cent: Room 9 161 min, $322.00; the VIP room 71 min, $295.83; Room 1 71 min, $47.33; Room 3 116 min, $96.67; Room 5 41 min, $40.00; Room 7 131 min, $152.83; Room 10 221 min, $331.50; Room 12 101 min, $235.67.
  - [ ] Tabs so far read Room 1 $123.33, Room 3 $175.67, Room 5 $40.00, Room 7 $210.83, Room 9 $480.00, Room 10 $441.50, Room 12 $305.67 and the VIP room $775.83.
  - [ ] The board counts 8 rooms in use, 3 open, 2 cleaning and 1 out of service, and every tile's words match [Rooms at 10:41 PM](../demo-seed.md#rooms-at-1041-pm).
  - [ ] Moving the simulated clock one minute moves every running clock and total by one minute's billing.
- **Tests:** an end-to-end test that reads every tile against `seed/west4-friday.json` (`rooms`, `sessions`, `checks.expected_at_now`, `counts`).
- **Notes:** [Board](../screens.md#board) notes 3, 4, 15, 16 and 19 now; notes 5, 12, 13 and 17 in M3; 18 and 21 in M4; 20 in M7; 10 and 14 (the footer and banners) in M8.

### M2-30 · Show the board's alerts, most urgent first

- **Status:** todo
- **Size:** S
- **Depends on:** M2-18, M2-22, M2-26, M2-29
- **Spec:** [Board](../screens.md#board) note 3; [Demo seed · Board alerts](../demo-seed.md#board-alerts); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · The board and staff phones
- **Build:** the alerts band, in pink, amber, lime and grey: a room past its end with a booking next ([Text …: please wrap up] [Move a room…]); a room call ([On it]); a room near its end with a booking next ([Text …: please wrap up]); a free room with a waiting party that fits ([Offer Room 11 · 10 min to claim]); rooms that need a wipe while parties wait ([Show]); a guest who texted they're late ([Reply "no problem"] [Check in] [Mark no-show]). Room-order alerts join in M3.
- **Acceptance:**
  - [ ] At 10:41 PM the board shows the seed's alerts in order, less Room 5's order (M3 adds it): pink Room 7, 11 min past, the Parks (8) at 11:00; pink Room 9's call for another mic; amber Room 3, 4 min left, Jae & co. at 11:00; lime Room 11 free all night, Amara B. (7) waited 26 min; grey Rooms 6 and 13 need a wipe, Nadia K. and Chris P. waiting; grey Sam O. running 15 late, held until 10:45.
  - [ ] [Move a room…] opens the move sheet on Room 7, and [Offer Room 11 · 10 min to claim] makes the offer.
  - [ ] The waitlist party is Nadia K. everywhere, never "Priya K.".
- **Tests:** an end-to-end test against `board_alerts` in the seed.
- **Notes:** The spec gives the seed's order but no general rule; cautious reading: by color (pink, amber, lime, grey), then oldest first (flagged).

### M2-31 · Build DeskRoom and the Room phone: the room panel and the running tab

- **Status:** todo
- **Size:** M
- **Depends on:** M2-11, M2-16, M2-17, M2-18, M2-20, M2-21
- **Spec:** [DeskRoom](../screens.md#deskroom); [Room](../screens.md#room); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · The board and staff phones; [Demo seed · Room 9, worked through](../demo-seed.md#room-9-worked-through)
- **Build:**
  - DeskRoom on the desktop and Room on the phone: the clock (minutes and rate), the running tab (room time so far and the check's lines, before tax and gratuity), the deposit that comes off at settle-up, party size, the ID chip, the Move sheet, Report a fault, the damage fee, calls and notes.
  - "Stay on by the minute until we close at 4 AM" when nobody's booked next, and the wrap-up prompt when someone is.
  - The staff phone's "Tab & close out →" opens this screen and never marks a room paid.
  - No quick-add chips and no demo "Bar accepted" control. Adding drinks, comps and voids, and the cut-off come in M3; Present the check, paying and the receipt in M4.
- **Acceptance:**
  - [ ] Room 9 on DeskRoom and on Andy's phone reads 161 min at $2.00 a minute, $322.00; drinks $158.00; tab so far $480.00; deposit $120.00; and the ringing margaritas aren't on the tab.
  - [ ] Room 10 says "Stay on by the minute until we close at 4 AM", and Room 3 shows the wrap-up prompt for Jae & co. at 11:00.
  - [ ] "Tab & close out →" on the phone opens Room 9's tab.
- **Tests:** Playwright on desktop and phone sizes against the seed.
- **Notes:** [DeskRoom](../screens.md#deskroom) notes 3, 5, 6, 10 and 12 and [Room](../screens.md#room) notes 5, 6, 9 and 10 now; the rest in M3, M4 and M7. The ringing margaritas load with the orders in M3.

### M2-32 · Build the staff phone's Tonight, Rooms, Calls and Waitlist tabs

- **Status:** todo
- **Size:** M
- **Depends on:** M2-11, M2-15, M2-20, M2-25, M2-26
- **Spec:** [Staff](../screens.md#staff); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · rule 1, The board and staff phones; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Staff phones; [Demo seed · Bookings tonight](../demo-seed.md#bookings-tonight)
- **Build:**
  - Tonight: a timeline and a list of the 11 bookings, plus a room-by-room view that includes Leo M.'s walk-in, and the counts (8 in room, 3 open, 2 cleaning, 1 out of service).
  - Rooms (each room's tile and tab), Calls (with a push) and Waitlist (the drawer's rows and actions).
  - Each booking's Details sheet offers actions by status: Check in only for a booking not yet seated, Mark no-show only after the grace, the Room ready text only before check-in, and "Let them stay" only when nobody is booked next.
  - Tabs follow the modules and the role: every staff phone gets Calls; runners get check-in and the waitlist only (Runs comes in M3); Approvals (M2-15) shows on managers' and owners' phones only. The phone opens the person signed in, with their role's tabs. Pushes for calls and wrap-up alerts.
- **Acceptance:**
  - [ ] Andy's phone lists the 11 bookings exactly as [Bookings tonight](../demo-seed.md#bookings-tonight), and the room view shows Leo M.'s walk-in in Room 5.
  - [ ] Sam O.'s row offers Check in, and Mark no-show only from 10:45 PM; Marcus T.'s seated booking offers neither.
  - [ ] Turning off Walk-in waitlist removes the Waitlist tab at once.
  - [ ] A runner's phone shows Calls, check-in and the waitlist, and no Approvals.
- **Tests:** Playwright on a phone size for each role.
- **Notes:** [Staff](../screens.md#staff) notes 2, 3, 6, 7, 8, 9, 12, 13, 15, 16 and 19 now, with note 14's call and wrap-up pushes; note 1 and the rest of 14 in M3; 4's Reopen and 5 in M4; 11 in M6; 10 and 17 in M8.

### M2-33 · Build the Calendar on desktop and phone

- **Status:** todo
- **Size:** M
- **Depends on:** M1-12, M2-06
- **Spec:** [DeskCalendar](../screens.md#deskcalendar); [Calendar](../screens.md#calendar); [API](../spec/08-api.md) · Bookings; [Payment flows](../spec/07-payment-flows.md) · Deposit when booking online (steps 6 and 7)
- **Build:**
  - DeskCalendar and Calendar: bookings ahead by day, with "Tonight" from the venue's clock (Fri Sep 25), and tonight's 11 bookings exactly.
  - New staff bookings (M2-06) through a dialog that shows the room and how long it's free, and refuses overlapping or past slots.
  - Blocked and special dates (`closures`), with the list of the bookings a blocked date affects.
  - The hold wording from the spec: an online slot holds a real room for 10 minutes, and a payment link holds it until `pending_until`.
- **Acceptance:**
  - [ ] Both calendars list the seed's 11 bookings for Fri Sep 25, and Leo M. isn't among them.
  - [ ] A new VIP-room booking at 11:00 PM tonight is refused (Bianca L.'s party holds it until 12:30 AM), and so is one at 9:00 PM tonight (already past).
  - [ ] Blocking Sat Sep 26 lists every booking on that date.
- **Tests:** Playwright on desktop and phone sizes.
- **Notes:** [Calendar](../screens.md#calendar) notes 1 and 4 and [DeskCalendar](../screens.md#deskcalendar) notes 1, 4 and 5 now. The big-party payment link and its hold (notes 2 and 3) and "Cancel and refund all" for a blocked date need payments, so they come in M5; the spec doesn't fix the payment-link hold's length.

### M2-34 · Add rates, bands, minimums and limits to Admin → Hours & prices, and build Admin → Alerts & rules

- **Status:** todo
- **Size:** S
- **Depends on:** M1-33, M2-03
- **Spec:** [Admin by milestone](../milestones.md#admin-by-milestone) (Hours & prices, Alerts & rules); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `PriceSettings`, `AlertSettings`; [AdminDesk](../screens.md#admindesk) notes 2, 16, 23 and 24
- **Build:**
  - Hours & prices gets the `prices` key: the rate in the venue's mode (per person, base plus extra, or flat by size), the billing step (1, 15, 30 or 60 minutes) and its rounding (up, nearest or down), minimum guests on weeknights and on Friday and Saturday, the first-hour minimum, time bands in the venue's own mode each with its step and rounding, the VIP rate (its rooms, $250 an hour, from 20 guests), booking limits (minimum and maximum hours, maximum guests, start slots) and the damage fee. Minimum spend shows off; M4 edits it.
  - Alerts & rules: `alerts.roomEndingMin` (10 minutes). No "Ring the bar until someone accepts" toggle.
- **Acceptance:**
  - [ ] West 4's prices read $10 a person an hour, by the minute, at least 3 guests on weeknights and 4 on Friday and Saturday, a first-hour minimum, no bands, the VIP room $250 an hour from 20 guests, and a $150 damage fee.
  - [ ] Adding a band with a 15-minute step saves a new `prices` version, and sessions that start afterwards bill with it.
  - [ ] Setting the room-ending warning to 15 minutes turns tiles amber 15 minutes before the end.
  - [ ] Alerts & rules has no alarm toggle.
- **Tests:** Playwright for each field; an integration test that a new version reaches new sessions only.
- **Notes:** The seed gives West 4 no rounding rule for its 1-minute step; with whole-minute segments it changes nothing, so the loader stores `up` (flagged).

### M2-35 · Finish the M2 part of the demo seed and run its scenarios end to end

- **Status:** todo
- **Size:** M
- **Depends on:** M2-29, M2-30, M2-31, M2-32, M2-33
- **Spec:** [Demo seed · Loading the seed](../demo-seed.md#loading-the-seed), [Things to try](../demo-seed.md#things-to-try); [Testing and operations](../spec/13-testing-operations.md) · The demo seed, Tests (end-to-end browser tests); [west4-friday.json](../../seed/west4-friday.json)
- **Build:**
  - The M2 part of the loader, finished: `guests`, `rooms`, `bookings`, `sessions` with their segments (Room 9's code KX4M7 fixed, the rest made by the loader), `earlier_sessions`, `waitlist`, `waitlist_earlier`, `texts`, `inbox`, the checks and their lines (M2-08), Room 4's fault, Room 6's note, Room 9's call and the `duty_managers` stand-in (Andy).
  - End-to-end tests for the M2 scenarios in the seed's `scenarios`: `sam_check_in`, `sam_no_show`, `offer_room11` and `room7_move`, each from a fresh load, on phone and desktop sizes.
- **Acceptance:**
  - [ ] A fresh load matches [Counts at 10:41 PM](../demo-seed.md#counts-at-1041-pm) for rooms, the waitlist and room tablets.
  - [ ] The four scenarios pass as their `expect` text in the seed says.
  - [ ] Every test starts at 10:41 PM whatever the test before it did.
- **Tests:** the four scenario tests, plus the board test from M2-29, run in CI on every pull request.
- **Notes:** The waitlist page's demo ("3 parties ahead", "Room 2 is ready · 10:00 to claim it") runs in `sam_no_show` and `offer_room11`.

## Coverage

Every item milestones.md lists for M2, and the tickets that build it.

| Item | What milestones.md says | Tickets |
| --- | --- | --- |
| Ships · The board | The 14 tiles and their states, the top alerts, `free_until`, the waitlist drawer; DeskRoom's panel and running tab; the Calendar; the phone's Tonight, Rooms, Calls and Waitlist tabs | M2-05, M2-08, M2-25, M2-29, M2-30, M2-31, M2-32, M2-33 |
| Ships · The room clock | Segments, the first-hour minimum, billable guests by business date, the VIP rate, bands in every rate mode with a billing step and rounding, the soft end and pauses | M2-01, M2-02, M2-03, M2-07, M2-16 |
| Ships · Bookings made by staff | A real room each, room blocks, cleaning time between bookings, no-shows after the grace, `booked_by` | M2-05, M2-06, M2-11 |
| Ships · Check-in | One sheet on the board and the phone: party size, IDs, room, clock start, deposit and a new room code; + Walk-in | M2-11 |
| Ships · The ID check and the headcount | `id_checks` at check-in; the headcount against `safety.occupancyLimit` | M2-12, M2-28 |
| Ships · The waitlist | Entries from staff and the door QR; 10-minute offers with a countdown and a text; "Not delivered · Call"; Seat, expiry, Remove and Text | M2-25, M2-26 |
| Ships · Room move and party size | The move sheet, a new segment and code, the old room to cleaning; party size +/− | M2-17, M2-18 |
| Ships · Room operations | Cleaning, room notes, faults (out of service, pause with approval, comp 15 minutes), the damage fee with a photo, lost and found, room calls | M2-14, M2-16, M2-19, M2-20, M2-21 |
| Ships · Approvals | The approvals table and routing; the Approvals inbox, starting with clock pauses | M2-15, M2-16 |
| Ships · Files | Presigned uploads with type and size limits | M2-13 |
| Ships · Service texts | West 4's subaccount; the 14 texts in `message_templates`; sending, sent, delivered or failed; the two-way inbox; STOP and HELP; staging texts only our phones | M2-09, M2-10, M2-22, M2-23, M2-24 |
| Ships · Public forms | The CAPTCHA and daily limits on the waitlist page and on phone codes | M2-27 |
| Ships · Canvas boards | Board, DeskRoom, DeskCalendar, Calendar, DeskMessages, Messages, Room, Staff and Waitlist | M2-29, M2-30, M2-31, M2-33, M2-22, M2-32, M2-25 |
| Admin · Hours & prices | Rates, bands, minimums, the VIP rate, booking limits and the damage fee (M2 part) | M2-34 |
| Admin · Rooms | Names, sizes, cleaning, on or off | M2-04 |
| Admin · Alerts & rules | When a room's time is ending | M2-34 |
| Admin · Safety | The occupancy limit (M2 part) | M2-28 |
| Admin · Phone & texts | The call number and the number texts come from | M2-10 |
| Admin · Texts | All 14 texts: wording, on or off | M2-10 |
| GA-M3 | Marketing texts: STOP closes in M2 | M2-23 |
| GA-S1 | Pricing breadth: bands mid-session, day rules, the minimum headcount, other rate modes, logged headcount changes, pauses with approval | M2-02, M2-03, M2-07, M2-16, M2-17 |
| GA-S5 | Room operations: cleaning time, the fault log, damage fees with photos | M2-05, M2-16, M2-19, M2-21 |
| GA-S7 | ID checks within §65-b at check-in | M2-12 |
| GA-S8 | The headcount against the posted limit | M2-28 |
| Done when · 1 | Every tile, clock and room time matches the seed to the cent; 8 in use, 3 open, 2 cleaning, 1 out of service | M2-29, M2-07, M2-01, M2-02, M2-35 |
| Done when · 2 | Pricing property tests for bands, steps, party-size changes and both daylight-saving nights | M2-03 |
| Done when · 3 | Checking in Sam O.; [Mark no-show] only after the grace | M2-11 |
| Done when · 4 | Offering Room 11 to Amara B.; "Not delivered · Call"; an expired offer moves on | M2-26 |
| Done when · 5 | The move sheet for Rob & Kim lists Room 11; a move issues a new code and sends Room 7 to cleaning | M2-18 |
| Done when · 6 | Diego's pause request reaches Andy's inbox only; "Waiting for Andy"; Andy's goes to Abhishek | M2-15, M2-16 |
| Done when · 7 | "Limit not set · Admin → Safety" and no number | M2-28 |
| Done when · 8 | "running 15 late" lands on the right booking; STOP stops every text at once | M2-22, M2-23 |
