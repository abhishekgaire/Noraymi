# Completeness and consistency review

Sep 28, 2026 · independent reviewer · sources: blueprint rev 68 (`review/blueprint.md`), spec rev 182 (`review/spec.md`), Gap review (`review/gap_review.md`), and the 27 canvas boards in `w4/project/*.dc.html` (files dated Sep 26). Laws weren't re-checked, as asked.

**How this was checked.** I read all three documents in full and built the checklist in the appendix from the blueprint. For the canvas I extracted every template string and script literal from each board (`review/completeness/text/`), rendered every board's default state (`review/completeness/visible/`), and clicked through the flows that matter with Playwright (`review/completeness/crawl/` and the `*_flow.py` scripts next to it). Every claim below about a screen was checked against the code or the rendered page. Nothing under `w4/` was changed.

**Severity.** *Blocker*: settle before milestone 1 is planned, or the build plan itself is wrong. *Major*: settle before the milestone that ships the item; otherwise engineering builds the wrong thing, a phase-1 screen has no design, or the go-live gate can't be judged. *Minor*: wording, counts, demo data or phase-2 items.

**Summary.** 1 Blocker, 22 Major, 14 Minor. The recent decisions mostly land cleanly in the spec, and the bar POS (Rail), Bar, Pin, Night, Manage and Admin → Card fee & gratuity boards follow them. The problems cluster in five places:

- **The milestone plan.** It leaves out several things West 4 can't open without (C1).
- **Phase-1 screens that were never drawn.** These are bar mode, offline mode, exception states, the booking consent and confirmation steps, receipts, the approver's phone and the bar POS settings (C10–C14, C17, C22).
- **Older screens that missed the decisions.** Staff are shown doing work their role can't, DeskRoom has no reason-only limit, refunds run without approval, and Admin still describes an alarm (C2, C15–C17).
- **Blueprint must-fix items with no home in the spec.** The room cut-off, the clear-out check and the license register are missing (C3–C6).
- **Stale wording and demo data**, which staging will copy (C24–C37).

## Findings

| ID | Severity | Where | What | Fix |
| --- | --- | --- | --- | --- |
| C1 | Blocker | Spec · Phase 1 milestones; blueprint · Build plan, phase 1 | None of the seven milestones ships several phase-1 deliverables the spec describes. **Guest site:** homepage, rooms, menu page, menu PDF, private parties and enquiries, and the song-search section. Only booking (M2) and the domain move (M7) appear. **Admin:** every settings screen (hours, prices, deposits, menu editor, rooms, team, texts, phone, connections, features and module states). **Desktop app:** the Electron shell itself, the USB print host and the watchdog, plus its offline queue mode with offline codes, replay and the "Review after outage" list. Only the outage drills (M6) imply these. **Everything else:** receipts (print, text, email and the public receipt page) with the email provider, files and the PDF job; the Console support-grant and emergency tools that on-call needs during the 4-week gate; the ID check at check-in with the headcount and door counter; room notes and faults; packages, price rules and the promotion checks; plan billing; retention jobs and guest erase. Nothing has an owner or an estimate, and the spec defers re-estimating until after M1. | Assign each to a milestone with a done-when, for example: <br>**M1:** the Admin screens for the keys it ships, and the desktop app shell. <br>**M2:** guest site pages and the menu PDF job, room join, ID check at check-in, packages and promotion checks. <br>**M3:** receipts, email, files and uploads, and the dispute inbox screen. <br>**M5:** the tax-quarter report. <br>**M6:** offline queue mode, codes, replay and review list; retention and erase jobs; Console support grants and emergency actions. <br>Then re-estimate phase 1 now, not after M1. |
| C2 | Major | Spec · Tenancy and access (Roles table); canvas AdminDesk Team, Setup step 6, Pin, Rail, Night, Staff | In the default role table, Staff can't take payments, run bar tabs or quick sale, or use the bar POS. It also has no row for comps and voids under the reason-only limit. The canvas's front-desk person, Diego R., has the Staff role in Admin and Setup ("check-ins, walk-ins, texts"). Yet on the canvas he: <br>• opens and owns two bar tabs on the Rail ("Front desk · covering the bar") <br>• takes "Cash sales · 2 tabs" into the front-desk drawer (Night, per-person demo) <br>• comps a Jäger Bomb "reason only" (Night log) <br>• "made" a run (Staff) <br>Pin also offers him a "Bar POS" link. Closing out rooms at the front desk (DeskRoom) needs payment rights too. M1 builds `role_permissions` and the "every route as every principal" test suite on these defaults. | Decide the front-desk role before M1. Either add a Front desk default role, or make Diego a Bartender and say payments need Bartender or above. Add a row "Comp or void under the reason-only limit" (Owner, Manager and Bartender ✓; Staff to be decided). Make Pin's home and alternate links follow the table. |
| C3 | Major | Blueprint · Build plan (phase 1 "fixes for must-fix items M1–M11"; gate "M1–M11 closed"), Every module codes; spec (no mapping) | The codes point to the earlier *Karaoke bar POS gap analysis* (`/home/claude/reports`), which isn't one of the three sources of truth. The spec never maps them, and its own Gap review uses M1–M23 for *Medium* items, so "M1–M11 closed" reads as a different list that is already closed. Two must-fix items have no spec coverage at all: M7's room- or guest-level "no more alcohol" cut-off (C5) and M10's license register (C6). | Rename the blueprint codes (GA-M1…GA-M11, GA-S1…, GA-N1…). Add a table to the spec mapping each must-fix item to its section and milestone, and state the gate against that table. |
| C4 | Major | Spec · Money rules 5, Staff screens (Room orders); canvas Board, Night, Rail | **Clear-out check.** The 30-minute clear-out check is one sentence ("the board asks for a clear-out check and records who did it"). It has no column, table, route, event or job, and no canvas state on Board or Night; no canvas version ever had one. **After-4 AM orders.** Money rule 5 cancels unaccepted alcohol orders automatically at the close (the B1 fix), but the bar POS section and Rail's 4:02 AM demo show a manual Decline button instead. | Add `night_closes.clear_out_at` and `clear_out_by` (or a `clear_out_checks` row), `POST /nights/{date}/clear-out`, a job that raises it at close + `drinkingUpMin`, and a Board and Night prompt. Pick one rule for unaccepted alcohol orders. Auto-cancel matches B1; with it, the Rail shows "Cancelled at 4:00 AM" and the room screen explains why. |
| C5 | Major | Spec · Data model (`tabs.cut_off_at` only), Money rules 5; canvas Room, DeskRoom, Board, Order | Staff can cut off a bar tab, but not a room or one guest in a room. `room_sessions` has no cut-off field, and no room screen has a "No more alcohol" control. A runner's "Couldn't serve" returns one order but doesn't stop the host's next order. This is must-fix M7. | Add `room_sessions.alcohol_cut_off_at`, `_by` and `_reason` (and optionally a per-guest entry). Enforce it with the alcohol-window checks on room, host and gift orders. Add the control to Room, DeskRoom and the Board tile, and log each refusal to `alcohol_refusals`. |
| C6 | Major | Blueprint · Same everywhere (Music licensing), Local licenses; spec (no mention of "license"); canvas Setup step 10 only | The blueprint's license register has no table, route or Admin screen in phase 1: ASCAP, BMI, SESAC and GMR numbers and renewals, plus local licenses with expiry and conditions. Only the phase-2 Setup wizard asks for it. This is must-fix M10's system part. | Add a `licenses` table (kind, number, holder, `expires_on`, fee, conditions, `file_id`), `GET`/`POST`/`PATCH /licenses`, a renewal-reminder job and an Admin → Licenses section, in M1 or M6. |
| C7 | Major | Spec · Phase 1 milestones (M7) vs Tenancy and access (PINs) | M7 imports "the team and PINs". Under the PIN rules, each person chooses their PIN on their own phone and nobody else sets or sees it; managers use 6 digits; common PINs are refused. Imported PINs break all of these. | Import people and roles only. Send invites so everyone sets a new PIN and pairs a badge before the first live night, and add that to M7's done-when. |
| C8 | Major | Spec · Scope ("our control panel … follow in phase 2"), Tenancy (Support access), Settings (rule packs), Testing (On call), Stripe setup 3; blueprint · phase 2 | Phase 1 relies on Console and Setup functions that both documents put in phase 2: <br>• support-grant requests and the emergency path, which on-call needs from the start of the 4-week gate <br>• two-person rule-pack publishing <br>• the `venue_modules.allowed` list <br>• Setup's check of the merchant category before bar tabs turn on <br>• the setup check of each manager's Stripe Dashboard login and Tap to Pay phone | Ship a minimal internal Console in M1 or M6 (support grants, emergency actions, rule-pack publishing, module allow-list). Turn Setup's West 4 checks into an M3 go-live checklist. |
| C9 | Major | Spec · Staff screens rule 11; blueprint · Settings (Languages), Open decisions (Launch languages), Build plan phase 2 | The spec ships four staff languages in phase 1 (English, Spanish, Chinese and Korean, via `memberships.locale`). The blueprint leaves launch languages to the founder and puts Korean and Chinese screens in phase 2. No milestone ships translations, and no canvas board has a language picker. | Phase 1 externalizes strings and stores `locale`, but ships English (plus Spanish if West 4's staff need it). Korean and Chinese follow the founder's decision in phase 2. Reword rule 11 to match. |
| C10 | Major | Canvas (no board); blueprint · Every module (Bar mode "Designed"); spec · Song systems (Bar mode queue), milestone 4 | Bar mode is on at West 4 and ships in M4, but no canvas board shows: <br>• the singer's phone queue <br>• the Up next TV <br>• staff Start and Skip controls, or overrides <br>• "send the singer a drink" <br>• prepaid song credit | Add boards for the guest queue page (join, name and phone code, my songs, up next) and the Up next display, plus a song-queue panel on the Rail (start, skip, logged override) and the gift-order flow. Otherwise move bar mode out of phase 1. |
| C11 | Major | Canvas (Board footer "works offline"); spec · Devices ("When the venue is offline"), Scope; blueprint · Platform (Offline and uptime) | No canvas state shows: <br>• "On backup internet" <br>• the read-only offline board <br>• the offline-code prompt and queue mode <br>• replayed orders landing as `held` <br>• the "Review after outage" list <br>• the break-glass Tap to Pay path <br>The Board's "works offline" promises more than the spec allows. | Draw these states on Board and Rail, with the review list on Night. Reword the footer: "Offline: read-only; queue orders with a code". |
| C12 | Major | Canvas (every staff board); spec · Payment flows, Devices, Tenancy (Approvals), API errors | The spec defines exception states that staff will meet on a live night, but none is drawn: <br>• "Status unknown, don't retry" <br>• a declined hold raise ("new orders need approval until another card") <br>• `capture_failed` <br>• "Ticket didn't print · Reprint" <br>• "Refund pending" <br>• "Not delivered · Call" on the waitlist <br>• vendor-health banners <br>• the managers' "Manager needed" incident alert <br>• the approver's own phone view for comps, refunds, pauses, tips and paid-outs; boards only show "Demo: Andy approves" shortcuts | Add these states to Rail, DeskRoom and Room, Bar, Staff (a manager's view with an approvals inbox) and Board. |
| C13 | Major | Canvas Book (the prototype ends at Pay), AdminDesk Deposits ("What guests read"), Manage; spec · Payment flows (Deposit when booking online, step 2); gap H9 | Book stops at the Pay button. There is no step for the guest's name and phone, no service-text notice, no unticked marketing opt-in, no payment page, no hold timer and no confirmation page. The spec requires the policy above the pay button to name the later charges the saved card may carry (H9's fix). The wording guests read everywhere (Book, Manage, Admin) never mentions a saved card or the rest of the tab. | Add the details, payment and confirmation states to Book. Extend the policy text in Admin → Deposits, which Book and Manage both read, to name remaining-tab charges on the saved card. |
| C14 | Major | Canvas Rail (New tab); spec · Payment flows (Bar tab step 1), Data model (`tabs.consent_text_version`, `consent_read_by`) | The spec has the bar POS show a consent line for the bartender to read out before the tap; the tab slip repeats it, and the consent is stored. Rail's New tab flow has no consent line and no slip, and no canvas version ever had one. | Add the consent line to the New tab panel, with a "Read to guest" tap that records `consent_read_by`, and draw the tab slip. |
| C15 | Major | Canvas DeskRoom (the comp or void panel), against Rail, Room, AdminDesk and the spec | DeskRoom says "Comps and voids need a reason and a manager's OK, given on their own phone" and always sends to Andy. That contradicts the decision that comps and voids up to $25 each and $75 a shift need only a reason, which Rail and Room already follow. | Port Room's reason-only logic and copy to DeskRoom, including the $75-a-shift check. Room also checks only the $25 item limit, so add the shift check there too. |
| C16 | Major | Canvas Staff (booking Details → Refund a charge); spec · Tenancy (Approvals), Payment flows (Refunds), Money rules 12 and 14 | The staff phone refunds instantly, with no second approver. It shows "Refunded" rather than "Refund pending", and offers a $360.00 "Full" refund on Marcus's booking, where only the $120 deposit was charged. | Cap the amount at what was captured. Send every refund to another manager's or the owner's phone before it runs, and show "Refund pending" until `refund.updated` arrives. |
| C17 | Major | Canvas AdminDesk (no Bar POS section; Alerts & rules; Menu); spec · Settings (`pos`, `tabs`), Data model (`pos_layouts`, `menu_items.button_name`); blueprint · Settings (Bar POS) | **No settings screen.** No Admin section edits the `pos` settings: the grid layout per station and its publishing, the reason-only limits, the idle and wipe locks, whether bar-tab tips go on the reader or a slip, and order aging and escalation. The `tabs` settings have no screen either: the $50 opening hold and the 4:30 AM cut-off (no canvas text mentions 4:30 at all); only the $600 flag appears, under Alerts. **Stale alarm toggle.** Admin → Alerts & rules still offers "Ring the bar until someone accepts · Room orders sound the alarm on the bar screen", a setting the spec doesn't have. **Menu editor.** It has no short button name and no alcohol flag. | Add Admin → Bar POS: a 25-slot layout editor per station ("starts next business date"), the limits, the locks, the tip path and the aging times. Add the tab settings. Replace the alarm toggle with the aging times, chime and Mute. Add button-name and alcohol columns to Admin → Menu. |
| C18 | Major | Canvas AdminDesk Team and Printers & devices, Setup steps 6 and 8; spec · Tenancy (Badges), Devices (Supported hardware) | Badges are paired and switched off "in Admin → Team" (spec and Pin), but Team has no badge column, pairing or switch-off. The device list and Setup's hardware step leave out the USB NFC readers and NTAG 424 DNA badges the spec lists. | Add a Badges column to Team, with "Pair (tap the reader)" and "Switch off" for each person. List the bar and front-desk NFC readers under Printers & devices, and add readers and badges to Setup step 8. |
| C19 | Major | Canvas AdminDesk Printers & devices (one drawer, at the front desk), Board, Rail (cash "opens the drawer"), Night and Board per-person demos (a "Bar · Maya S." drawer); spec · Devices (Cash drawer), Money rules 15; blueprint · Cash drawers ("to confirm with West 4") | West 4 runs one house drawer at the front desk, and the bar printer has no drawer. Even so, the bar POS's one-tap cash "opens the drawer", and the per-person demos invent a bar drawer. The spec never says where bar cash goes at West 4. | Settle it with West 4. Either add a drawer on the bar printer's kick port (then say how the house model covers two physical drawers), or send bar cash into the bartender's `staff_banks` row, dropped at the front desk. Update Admin's device list, the Rail's wording and the spec to match. |
| C20 | Major | Spec · Settings, rule packs and modules | **Missing types.** Eight keys have none: `tabs`, `ordering`, `rooms`, `barMode`, `alerts`, `phone`, `website`, `messages`, though M1 validates every save against the rule pack. **Data in two places.** Special dates sit in both `hours.closures` and the `closures` table, where H9 asked for one list. Text wording sits in both the `messages` key and `message_templates`. Site content sits in both the `website` key and `site_versions`. **Missing fields.** `PaySettings.tipScreen` can't hold the $1/$2/$3 amounts or the $10 threshold that the Terminal configuration uses, and `PosSettings.orderAging` has no field for the 30-second phone buzz. | Add the eight types. Keep closures, templates and site content in their tables and drop the duplicate keys (or the other way round). Add `fixedCents: [100, 200, 300]` and `smartThresholdCents: 1000` to `tipScreen`, and `phonesSec: 30` to `orderAging`. |
| C21 | Major | Spec · API (Phase 1 endpoints, Live events); gap M21 | M21 is still partly open. **Missing routes:** file upload (damage, slip and paid-out photos); create, edit or archive rooms; menu categories; support grants; the clear-out check; device revoke. **Missing list reads:** tabs, bar orders and runs, approvals (the manager's inbox), incidents, "Tips to enter". **Missing events:** `approval.requested` and `approval.decided`, `order.returned`, `order.cancelled` and `order.claimed`. The Rail's "Waiting for Andy" badge and the runs list depend on these events. | Add `POST /files` (presigned, with type and size limits), `POST` and `PATCH /rooms`, `/menu/categories`, `/support-grants` with approve and revoke, `POST /devices/{d}/revoke`, `GET /tabs`, `GET /orders?status=`, `GET /approvals?status=pending` and `GET /incidents`, and the five events. |
| C22 | Major | Canvas (no receipt board); spec · Money rules 9–10, API (Receipts); blueprint · Settings (Gratuity: "same text on site, confirmation, screen and receipt") | No board shows the printed receipt or the public receipt page. The spec places several lines there: "Gratuity included", "Additional tip (optional)", the "Credit card surcharge" line, tax lines and the check number. The booking confirmation text also has no gratuity line. | Add a receipt board (printed and web) for a room check and a bar tab. Add the gratuity sentence to the confirmation text. |
| C23 | Major | Blueprint · Every module (Status column) | "Built" is never defined, and 8 pieces carry it. They include the bar POS with its growing holds and 4:30 AM capture, and four phase-2 pieces (website builder, module switches, setup wizard, control panel). No production code exists: "Built" means a working canvas prototype. Bar mode is "Designed" but has no canvas board (C10). | Define the terms, or rename them "Prototyped (canvas)", "Specified, no screen" and "Not started". Mark Bar mode "Specified, no screen". |
| C24 | Minor | Canvas Bar footer, AdminDesk Features and Alerts, Setup step 2 and test night, Console; spec · Devices; gap H14 | **Escalation wording.** Bar says that at 4 minutes "the front desk and Andy get a text". The spec has the manager on duty's phone notified at 4 minutes and a text or call at 6. The blueprint doesn't mention the 30-second phone buzz. **Module text.** Descriptions still read "Orders ring the bar until accepted", and Setup's test night says "It has to ring the bar". **Gap review.** H14's fix text still says 90 seconds and 3 minutes. | Use one sentence everywhere: "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup." Add a dated note to H14. |
| C25 | Minor | Spec · API (Time clock "after name and PIN"), Security item 3; canvas desktop rail "Lock · PIN", Pin, Setup step 6; blueprint · Every module (Checks) | **Badge-era drift.** The spec's API table and security item 3 mention only name and PIN, not badges. **Pin contradicts Admin.** Pin says "Refunds, cash counts and Admin ask for the PIN again", while Admin says "Admin … need a passkey. A PIN never opens them." **Older wording.** Setup says "Everyone gets their own PIN"; the blueprint's Checks row says comps and voids need a "reason and PIN". | Say "badge or name and PIN" in the API table, security item 3, the rail's Lock label and Setup. Change Pin's line to "refunds, cash counts and no-sale ask for the PIN; Admin needs a passkey". Reword the Checks row. |
| C26 | Minor | Blueprint | These passages still describe older states: <br>• The Platform section's setup steps (1 Business and license, 2 Address) differ from the module row and the canvas (1 Your venue, 2 What you run). <br>• Phase 2 lists "module switches, settings and NY rule pack", but the spec needs all three in phase 1: M1 ships settings and the New York rule pack, and `venue_modules` is phase-1 data. <br>• "Two-way texts and eight automatic texts"; there are now 11 service and 2 marketing texts. <br>• "venues attest with SAQ C or SAQ A"; the spec enrolls readers in P2PE. <br>• "tell a venue of a breach immediately, within 30 days"; the spec's DPA commits to 72 hours. <br>• "Fingerprint clock-in stays optional"; the spec has no fingerprint readers. <br>• The header date is Sep 25, while the content was decided Sep 26. | Update each passage to the current decision. For the phase 2 row, say "rule packs for other counties and the multi-venue settings". |
| C27 | Minor | Spec · Open technical questions; blueprint · Open decisions; gap review · status line | **Counts.** The spec's intro counts 19 of its 21 questions and leaves out the founder's native-app question and the Playbox question. **Missing questions.** The spec's table lacks drinking-up timing, debit under a cash discount, and whether junk-fee rules cover the automatic gratuity, though its own settings text says those are with the lawyer. It also omits the blueprint's entity decision, which M3 needs for the Stripe platform account. **Stripe row.** The blueprint's Stripe row has 6 of the spec's 8 questions. **Offer name.** The spec asks about "West 4's 'buy a song, get a drink'", but Main advertises "Buy a drink, get a song". **Snapshot.** The gap review still cites 11 plus 6 open items and revisions 139, 37 and 50. | Make the two lists match. Name the offer West 4 actually runs. Add "entity and platform account before M3". Date-stamp the gap review's status line. |
| C28 | Minor | Canvas demo data (L1's class of problem reappeared) | These screens disagree at the same 10:41 PM on Sep 25. **Room 12 and VIP.** Board shows Room 12 at $330 and the VIP room at $745; the Rail shows $392 (Room 12 opened at 8:23 PM) and $776, and the calendar and Night put Room 12's start at 9:00. **Jae & co.** Four versions: Board says Room 3 at 10:45; Manage says 10:00, 7 guests, medium room; Staff says 9:00, 8 guests, Room 6; DeskCalendar doesn't list them. **Priya R.** She is booked 7–9 PM yet has "4 min left" on the Board. **Room counts.** Staff shows "2 in room / 11 open", Board "8 in room / 3 open", and Admin Features "9 rooms in use". **Orders.** Rail's Room 5 order has "ID ✓ 4 of 4", Bar's "4 of 5". The rail badge says "Bar orders 1" while 2 are waiting. Staff shows a Room 1 run the Bar doesn't have. **Cleaning.** "Rooms 6 and 13 have needed a wipe for 8 min", but their tiles say the parties left at 9:12 and 9:20. **Devices.** Console shows "7/7 online"; Admin shows 13 of 14 tablets online. **Waitlist.** Board says Priya K. (6) is next; Staff lists Leo, Amara and Chris. **Staff phone.** It offers "Move to Room 5" (fits 3–6, occupied) for a party of 12 and "Check in" for a seated party. Tips to enter uses Visa ··4417, which is Jess P.'s card. **Reports.** "Reviews from the morning text 19", though that text is off. | Generate the demo data once from the Room 9 story and staging's seed, then copy it into every board. |
| C29 | Minor | Canvas Night (Sales, Tips) | The $2,122.65 gratuity equals 20% of every sale except damage fees and kept deposits: ($4,318.33 + $5,266.00 + $1,240.00 − $118.00 − $93.12) × 20%. That includes bar-tab drinks, but West 4's gratuity is on room tabs only, and bar tabs tip on the reader ($186.40 in card tips on 11 bar tabs). | Split Drinks into room tabs and bar tabs, and take the gratuity on the room-tab lines only. |
| C30 | Minor | Canvas Rail (Split) | Splitting $32.66 two ways gives $16.32 and $16.34 instead of $16.33 each. The code floors a floating-point share (`Math.floor(payTotN * 100 / ways) / 100`) and gives the rest to the last share. The spec works in integer cents and hands leftover cents out by largest remainder. | Compute in cents: `Math.floor(3266 / 2)`, then hand the remainder out one cent at a time from the first share. |
| C31 | Minor | Canvas Menu (header), AdminDesk Hours & prices ("Happy hour line"); spec · Settings (`price_rules`); gap H30 | The public menu hard-codes a "Happy hour · [Days and hours] · [Deals]" banner that's always visible. Admin keeps a free-text happy-hour line ("leave empty to hide it everywhere") instead of dated `price_rules`, so the site could advertise a price the POS doesn't charge. | Render the banner from `price_rules` and hide it when there are none. Replace the free-text line with a price-rule editor, or remove it. |
| C32 | Minor | Canvas Rooms, Messages, DeskMessages, Board, Room, DeskRoom, Order, AdminDesk Texts; spec · Money rules 4 | **Prices.** Rooms says "$80 an hour, plus tax" but leaves out the 20% gratuity that Book shows, and "VIP room $250 per hour and up" contradicts a flat VIP rate. **"Stay as long as you like".** This appears in the booked-time-ending text and on seven screens (Board, Room, DeskRoom, Order, Staff, Messages, DeskMessages), yet the spec ends every stay at close and stops offers to stay 30 minutes before it. | Say "plus tax and a 20% gratuity" and "$250 an hour". Change the stay wording to "stay on by the minute until we close at 4 AM". |
| C33 | Minor | Spec | **Tab states.** `tabs.state` lists 7 states, while the lifecycle diagram's caption says 8. **Close rules.** Night close and the 4:30 AM job cover `open` and `awaiting_tip` but not `tipping` or `capture_failed`. **Tax categories.** `check_lines.tax_category` allows only `room_time`, `drink` and `food`, but rule 8 taxes damage fees, and songs and fees also need a category. **Voids.** "Not made goes back in stock" implies inventory the spec doesn't model. **ID checks.** `id_checks` references only a room session, not a bar tab, and says nothing about the scan method or hardware; M13's "read IDs on the device, with no vendor cloud" has dropped out. | Reconcile the state count. Define how night close and the cut-off job treat `tipping` and `capture_failed`. Add `song`, `damage`, `fee` and `surcharge` categories. Say that "made" is a waste flag, not a stock movement. Add `check_id` and `method` (visual or scan) to `id_checks`, and restore M13's on-device rule. |
| C34 | Minor | Spec · Song systems and texts (Templates); canvas AdminDesk Texts and Alerts, DeskMessages, Messages, Bar | **Dropped text.** H29's fix added a "you're up next" text, but neither the spec's template list nor Admin → Texts has it. **Text lists differ.** DeskMessages lists 8 automatic texts and phone Messages 7, while Admin lists 13. **Texts with no template.** Admin → Alerts offers "Text the guest when it is on its way", and Bar's "Hold · text the room" ("Give us five minutes"). | Add an "Up next" template, plus "on its way" and "held" if they are texts rather than room-screen messages. Show the same list on all three screens. |
| C35 | Minor | Blueprint · Every module and Settings, against the spec | Some blueprint module contents have no spec coverage. On modules that are on at West 4: room welfare timers (Safety), the signed cleaning checklist (Room operations), and allergen fields and the allergy notice (Guest ordering; Menu and stations). In Reports: the $300,000 sales-tax alert, revenue per room-hour, ticket times and labor share. For later venues: package headcount tiers, the volume-cap log, holiday price rules, minimum spend credited against the room fee, and per-night or dated closes in the `RulePack` type. | Mark each "phase 2" in the blueprint, or add the table and fields to the spec: `room_sessions.welfare_check_every_min`, `cleaning_checks`, `menu_items.allergens`, report metrics, `packages.tiers`, `volume_cap_log`, and dated closes in `RulePack`. |
| C36 | Minor | Canvas AdminDesk Connections; blueprint · Integrations; spec · `integrations` | **Connections nobody specified.** Admin offers "Yelp reservations · Pull Yelp bookings onto the board" and "Homebase · Shifts". **QuickBooks.** Admin offers "QuickBooks · Nightly totals to the books · Connect", but the spec defines only a journal export; the OAuth connection, account mapping and push job aren't specified. Integrations must go through partner programs. | Remove Yelp and Homebase until a partner program is chosen, or add them to the blueprint as partner integrations. Either specify the QuickBooks push or label it "Export for QuickBooks". |
| C37 | Minor | Canvas, various | **Not on the canvas:** the tax-quarter report, the dispute inbox, payout matching and the unlinked Stripe activity inbox, check numbers, training mode, the room-tablet kiosk view with "Room available", and the guest join step. **Other screen gaps:** <br>• Room's cash close-out "opens drawer" from a phone and records no amount handed over, change or cash tip. <br>• Admin → Deposits lacks the spec's `cardHold` mode, and Hours & prices lacks booking limits. <br>• The big-party link holds the room only after payment, and `bookings.pending_until` is undefined. <br>• The Parties enquiry takes "phone or email", but the inbox is SMS-only. <br>• DeskCalendar says "a room is held the second a deposit clears"; the spec holds it for 10 minutes from slot choice. <br>• Admin's surcharge preview adds no tax on the surcharge, though the rule pack says it's taxable. <br>• The phone Admin board says Admin lives on "the office computer", though the spec allows web Admin with a passkey and West 4 has no office PC. | Draw or reword each as named. Define `pending_until` for payment links (for example 24 h, with a hold block) and say how an email-only enquiry is answered. |

## Appendix: coverage checklist

Status key: **Covered** means concrete enough to build (tables, routes, events, settings, rules, tests, milestone). **Partly** means something is missing, named in the row. **Missing** means not in the document. **Deferred** means the blueprint puts it after phase 1, and the spec says so. For the canvas: **Shown**, **Partly**, **Missing**, or n/a (not phase 1 or not user-facing).

### A. Every module (28 pieces: 8 Built, 1 Designed, 19 To build; count verified)

| # | Module | Spec | Canvas (phase 1 for West 4) | Milestone |
| --- | --- | --- | --- | --- |
| 1 | Guest website and booking | Partly. Booking, availability, manage, pay link, enquiries, public menu, song catalog, menu PDF job and `site_versions` are specified; no milestone ships the non-booking pages (C1) | Partly. Main, Rooms, Book, Menu, Manage, Parties. Book stops at Pay (C13); Menu has a hard-coded happy hour (C31); price wording (C32) | M2 (booking only), M7 (domain) |
| 2 | Website builder | Deferred (phase 2); `site_versions`, `domains` and WCAG rules are in place | n/a (SiteBuilder exists) | none (phase 2) |
| 3 | Deposits and cancellations | Covered: `DepositRule`, flows, fixed refund cut-off, big party, venue cancel, payment link, `cardHold` | Shown: Book, Manage (party size and late cancel checked), Admin Deposits, both calendars. No `cardHold` option (C37) | M2, M3 |
| 4 | Tonight board, staff phone and waitlist | Covered: board with `free_until`, sessions, move, no-show, refunds, waitlist offers and 10-minute hold; how the wait estimate is worked out isn't given | Shown: Board (top 3 plus "show all"), Staff, Waitlist. Demo mismatches (C28) | M2 |
| 5 | Room clock and time billing | Partly. Segments, per person, VIP from 20, minimums 3/4, first hour, pause and resume; holiday rules and minimum spend credited against the fee are missing (C35) | Partly: Room, DeskRoom, Order. Pause and resume aren't drawn | M2 |
| 6 | Room operations | Partly. `room_states`, cleaning minutes and blocks, damage line with `file_id`, `room_faults` linked to comps; no signed checklist (C35), no upload route (C21) | Partly: Board states, "Add damage fee $150 + photo", room notes | none named (C1) |
| 7 | Guest phone ordering | Partly. Join, orders, calls, host lock, help, running total, "pay cash to staff" rule; no allergy notice (C35) | Partly. Order has the running bill before tax, call staff, lock and help; the join step and tablet view are missing (C37) | M2 |
| 8 | Bar screen and tickets | Covered: aging 2/4 min, chime backup, 1-minute Mute, print jobs with `jobToken`, "sent", out tonight, runs | Shown: Bar, Rail, Staff runs. Admin still describes an alarm (C17); escalation wording (C24) | M2 |
| 9 | Kitchen display and food | Deferred (phase 2); `menu_items.station` only | n/a | none |
| 10 | Bar POS, tabs and quick sale | Covered: layouts, drafts, badges, growing hold, one tab per card, tips on the reader, cash buttons, reopen, last call, 4:30 AM cut-off | Shown: Rail (all states work). Missing consent line (C14), split rounding (C30), drawer location (C19) | M2 (POS), M4 (tabs) |
| 11 | Bar mode | Covered: `singers`, `song_queue`, `barMode`, Up next device, gift order, prepaid credit. The up-next text was dropped (C34) | Missing (C10) | M4 |
| 12 | Song system control | Covered as adapter design, phase 2; no volume-cap log (C35) | n/a (off at West 4; Setup step 5 and Admin show "Needs Playbox link") | phase 2 |
| 13 | Packages and specials | Partly. `packages`, `price_rules` and promotion checks exist; no headcount tiers; no milestone (C1) | Partly. Packages are sold (Order, Menu, Parties, Night); there's no builder, and the happy hour is free text (C31) | none |
| 14 | Payments and surcharge engine | Covered: Connect, Accounts v2, readers with cellular, close-out ways, card fee at the reader, disputes | Partly. Close-out (Room, DeskRoom, Rail), Admin card fee and Setup step 7 are shown; no dispute inbox or payouts (C37) | M3 |
| 15 | Checks, tax categories and records | Covered: revisions, tax lines, counters, trigger audit, Z report, exceptions report. The tax category list is incomplete (C33) | Partly. Night shows the Z report and "Every action"; no check numbers and no receipt (C22, C37) | M3, M5 |
| 16 | Team, roles, time clock and tip pool | Partly. Roles, badges, 4/6-digit PINs, punches, shifts, ledger, pools, My tips, payroll export. Role table conflict (C2); PIN import (C7) | Partly: Pin, Admin Team (no badges, C18), Staff Tips and My tips, Night pool | M1, M5 |
| 17 | Messages and marketing consent | Covered: subaccount per venue, templates, inbox, consents, quiet hours in the recipient's time zone, opt-outs | Partly. Messages, DeskMessages and Admin Texts are shown; no opt-in capture or one-tap opt-out; the lists differ (C34) | M6 |
| 18 | Safety, ID and incident records | Partly. Help, incidents kept 3 years, `id_checks` with four fields, headcount at 90%; no welfare timers (C35), no scan method (C33), banned list waits for the lawyer | Partly. Order help and Board headcount are shown; no manager alert or incident log (C12) | M6 |
| 19 | Alcohol controls | Partly. `alcohol_window`, `409 alcohol_closed`, refusals and tab cut-off exist; clear-out has no storage (C4); no room cut-off (C5) | Partly: Rail at 4:02 AM, Admin last call; no clear-out and no room cut-off | M2 |
| 20 | Reports and accounting export | Partly. Sales, occupancy, bookings, staff actions and tax-quarter routes, plus the journal export; blueprint metrics missing (C35) | Partly. Reports and DeskReports show week and 8-week views; no tax-quarter screen (C37) | M5 |
| 21 | Devices, printers and offline | Covered: devices, pairing, printers, drawer kick, router, heartbeats, lockouts, offline codes and replay | Partly. Admin devices is shown; offline states are missing (C11); NFC readers aren't listed (C18) | M2 (printing), M6 (drills); offline mode unassigned (C1) |
| 22 | Admin settings | Partly: 14 keys, 8 of them untyped (C20); no milestone for the screens (C1) | Partly. AdminDesk has 14 sections; no Bar POS or tab settings (C17), badges (C18) or licenses (C6) | none (C1) |
| 23 | Module switches and plans | Covered: `venue_modules` with on/stopping/off, dependencies, `venue_flags`, `venue_subscriptions` and dunning | Shown: Admin Features (confirm lists 4 modules), Console | none (C1, C8) |
| 24 | Venue setup wizard | Deferred; steps 7 and 8 and the setup checks are referenced | n/a (Setup exists; its step list differs from the blueprint's, C26) | phase 2 |
| 25 | Multi-location and owner accounts | Deferred; organizations, `owner_venues()` and `org_read` are in place | n/a | phase 2 |
| 26 | Vendor control panel | Partly: support grants, emergency path, two-person rule packs, subscriptions; needed in phase 1 (C8) | n/a (Console exists) | none (C8) |
| 27 | Guest CRM, loyalty and gift cards | Deferred (`guests` only) | n/a | later |
| 28 | Event sales | Deferred (`enquiries` only) | n/a (Parties has the estimator and enquiry form) | later |

### B. Settings each venue controls (21 groups; count verified)

| # | Setting | Spec | Canvas | Status |
| --- | --- | --- | --- | --- |
| 1 | Modules | `venue_modules` (not a settings key) | Admin Features: 13 of 19 on, 4 core; Console: 15 allowed | Covered |
| 2 | Pricing model | `PriceSettings.rate` (3 modes), `vip` ($250 from 20) | Admin Hours & prices; Book, Parties, Rooms | Covered |
| 3 | Time bands | `bands` by weekday, in minutes from the start of the business date; no holiday rules | none (one rate at West 4) | Partly (C35) |
| 4 | Minimums | `minGuests` weeknight 3 / Fri–Sat 4, `firstHourMinimum`, `bigParty.minSpendCents`; no per-day headcount; spend only added, never credited | Admin shows both minimums; Book and Manage show the rule | Partly |
| 5 | Deposit rule | `DepositRule` (5 modes, `refundHours`, `late`, `noShow`, `graceMin`, `bigParty`) | Admin Deposits, Book, Manage, calendars | Covered (Admin has no `cardHold`) |
| 6 | Gratuity rule and label | `PaySettings.gratuity`, `tipScreen`, `tipReview`, gratuity basis, receipt wording | Admin Card fee & gratuity, Setup step 7, Book, Room, Night | Partly: type (C20), receipt and confirmation (C22) |
| 7 | Card fee | `CardFee` modes, cap 2.7%/3%, `noticeSentOn`, reader flow | Admin (off by default, surcharge and discount previews), Setup step 7 | Covered |
| 8 | Cash drawers | `CashSettings` and the drawer tables; changes start the next business date | Admin Cash drawers, Board, Night (both models) | Covered (bar cash question, C19) |
| 9 | Tax jurisdiction | Rule pack `salesTax`, tax line fields | Setup step 1 (8.875%), Night | Partly: category list (C33) |
| 10 | Closing hour and last call | `hours.lastCall`, `alcohol.lastSale`, `drinkingUpMin` | Admin Last call; Rail at 4:02 AM | Partly: clear-out (C4) |
| 11 | Rooms and capacities | `rooms` table, `rooms` key, `venues.max_occupancy` | Admin Rooms (limit empty, so the Board asks for it) | Partly: no rooms routes (C21) |
| 12 | Song system | `song_systems` (system, kind, control) | Setup step 5, Admin Connections | Covered |
| 13 | Menu and stations | Menu tables, `modifier_groups`, `out_until`; no allergens | Admin Menu: 127 items in 15 categories | Partly (C17, C35) |
| 14 | Bar POS | `PosSettings`, `pos_layouts` | none | Partly (C17, C20) |
| 15 | Packages | `packages` with rule-pack check | Packages category only | Partly |
| 16 | Roles and permissions | `role_permissions`, approvals on the approver's own phone, reason-only limit, 2-step sign-in | Admin Team (4 roles), Pin | Partly (C2) |
| 17 | Tip pool eligibility and shares | `tip_eligible`, `occupation_code`, `tip_pool_occupations`, hours from punches | Admin Team ("In tip pool" / "Can't share"), Night by hours | Covered (shares per occupation not drawn) |
| 18 | Texts and consent | `message_templates.on`, `consents`, quiet hours | Admin Texts (13), marketing off | Covered (no opt-in capture drawn) |
| 19 | Languages | `memberships.locale`, `guests.locale` | none for staff; guest languages in SiteBuilder (phase 2) | Partly (C9) |
| 20 | Website | `website` key, `site_versions`, `domains` | Admin Website, SiteBuilder | Covered (duplicate store, C20) |
| 21 | Devices | `devices` kinds, pairing, router, readers with cellular | Admin Printers & devices; bar S710 "on order" | Partly: NFC readers (C18) |

### C. Integrations (11 kinds across 15 rows; count verified)

| Row | Spec | Status |
| --- | --- | --- |
| Playbox | `playbox` adapter only once Playbox signs a written agreement; `none` until then; catalog from the vendor's file | Covered (partnership only) |
| KaraFun | First phase-2 adapter; the staff tap stays until song-start events are documented | Covered (phase 2) |
| Singa | Only through a partner deal | Covered (phase 2) |
| KJ software | OpenKJ second; Karaoki and kJams manual | Covered (phase 2) |
| Korean, Japanese and Chinese systems | `none`; clock and billing run beside the player | Covered |
| Card readers | S710 at every pay point, S700 and WisePOS E labeled "no cellular backup", no M2, server-driven, cellular on | Covered (M3) |
| Payments platform | Direct charges, Accounts v2, one Location per venue, restricted keys | Covered (M3) |
| Texting | Twilio subaccount per venue, 10DLC | Covered (M6) |
| Payroll and scheduling | Payroll CSV export only | Partly: no connections; canvas shows Homebase (C36) |
| Accounting | One balanced journal per night plus one per payout; export route | Partly: no QuickBooks or Xero push (C36) |
| Reservation channels | Not in the spec | Deferred; canvas shows Yelp (C36) |
| ID scanners | Four fields kept, per-venue key per business date, 7 days | Partly: no scanner, SDK or on-device rule (C33) |
| Printers and cash drawers | CloudPRNT, Server Direct Print, USB through the desktop host, drawer kick | Covered (M2) |
| Kitchen screens | Phase 2 | Deferred |
| Chinese and Korean channels | WeChat link not in the spec | Deferred |

### D. Platform

| Item | Spec | Status |
| --- | --- | --- |
| Accounts and data | Row-level security with `FORCE`, resolvers, composite foreign keys, organizations → venues, Stripe account per organization, Location per venue | Covered (M1) |
| Setup wizard | Steps 7 and 8 referenced; wizard in phase 2 | Deferred (step names, C26) |
| Module switches | `venue_modules` states, dependencies, core always on | Covered (the Console part, C8) |
| Website builder | Phase 2 | Deferred |
| Payments (decided Sep 26) | `fees_collector` and `losses_collector` set to Stripe; Stripe files the 1099-K | Covered |
| Security and compliance | SAQ A page on its own origin, P2PE readers, restricted keys, audit hash chain, DPA | Covered (blueprint wording, C26) |
| Offline and uptime | Dual WAN, one writer, queue mode, Tap to Pay break-glass, 99.9%, RPO and RTO | Partly (C1, C11) |
| Support | Second responder before the 4-week gate; time-boxed support actions | Covered |
| Data ownership (proposed) | Accounting and payroll exports only; no CSV of bookings, guests or hours; no retention after cancellation | Partly |
| Vendor control panel | Support access: off by default, reason, 60 minutes, both identities logged | Covered (phase, C8) |

### E. Build plan, phase 1

| Item | Where in the spec | Status |
| --- | --- | --- |
| Real backend, multi-tenant from day one | M1 | Covered |
| Stripe Connect and card readers | M3 | Covered |
| Fixes for must-fix items M1–M11 | See the next table | Partly (C3) |
| The bar POS with bar tabs and bar mode | M2 and M4 | Covered in the spec; bar mode has no screens (C10) |
| Offline design | Devices, printing and offline | Partly: milestone (C1), canvas (C11) |
| Texting registration | M6 | Covered |
| Gate: M1–M11 closed | none | Missing mapping (C3) |
| Gate: lawyer and accountant sign-offs | Open technical questions | Partly (C27) |
| Gate: future bookings, deposits and guests imported | M7 | Covered (PIN import, C7) |
| Gate: outage drill passed | M6 and Testing | Covered |
| Gate: 4 weeks of live nights without a money error | M7 | Covered |
| Start now: surcharge notice | `CardFee.noticeSentOn` (off at West 4) | Covered |
| Start now: 10DLC | M6 | Covered |
| Start now: performance licenses | Outside the product; no register | Partly (C6) |
| Start now: Playbox talks | Open question | Covered |
| Start now: Stripe pricing and confirmations | 8 Stripe questions | Covered |
| Start now: lawyer, accountant and PCI | Open questions | Covered |
| Start now: badges, USB NFC reader, staff trial | Badges, trial | Covered. Also add the bar S710, which Admin shows "on order" |

Must-fix items from the earlier gap analysis:

| Item | Spec | Status |
| --- | --- | --- |
| M1 Card fee | `CardFee`, card fee at the reader, off at West 4 | Closed |
| M2 Gratuity and tip pool | `pay`, ledger, pools, My tips, payroll export | Closed (lawyer questions still open) |
| M3 Marketing texts | `consents`, quiet hours, opt-outs, 10DLC; marketing off | Closed in the spec; opt-in capture not drawn |
| M4 Tax | Tax lines, check counters, no deletes | Closed (categories, C33) |
| M5 Booking and deposit flow | Full price on Book, accepted policy stored, cut-off in NY time | Partly (C13) |
| M6 4 AM stop | `alcohol_window`, 409, sale time at acceptance | Partly: clear-out (C4) |
| M7 In-room cut-off | Tab cut-off, runner "Couldn't serve", `alcohol_refusals` | Partly: no room or guest cut-off (C5) |
| M8 Offline mode | Specified | Closed in the spec; canvas missing (C11) |
| M9 Security and PCI baseline | Security and data retention | Closed |
| M10 Music licensing | Play log (bar mode only) | Partly: no register (C6) |
| M11 Bar mode guardrails | Fresh tap when a surcharge is on, gift-order cut-off check, song credit as a zero-price line | Closed in the spec ("text reminders for unpaid tabs" not adopted); canvas missing (C10) |

### F. Open decisions (16) and Decided (5)

| Decision | Spec | Status |
| --- | --- | --- |
| Product name and entity | Not listed; M3 needs the platform account | Partly (C27) |
| Plan prices; support hours; SOC 2 timing | Not engineering questions; on-call and SOC 2 are consistent | Consistent |
| Launch languages | The spec presumes four staff languages | Contradiction (C9) |
| Song systems first; Playbox relationship; native app for offline | Adapter order, Playbox question, native-app question | Consistent |
| Card fee and gratuity guardrails (lawyer) | Mentioned in the settings text, missing from the questions table | Partly (C27) |
| Alcohol and licensing (lawyer) | Private function ✓; drinking-up missing; offer named in reverse | Partly (C27) |
| Staff and messages (lawyer) | All four questions present | Consistent |
| Data and food (lawyer) | ID and breach questions ✓; PHL §1356 is phase 2 | Consistent |
| Tax on fees and room time (accountant) | Three questions present | Consistent |
| Food supervision (DOHMH) | Phase 2 (kitchen) | n/a |
| Payment page and PCI | Present | Consistent |
| Stripe confirmations | 8 in the spec against 6 in the blueprint | Partly (C27) |
| Decided: card fee | `CardFee`; Admin → Card fee & gratuity; Setup step 7 | Covered |
| Decided: gratuity | `pay.gratuity`, label, pool; Admin, Setup and Night | Covered |
| Decided: Stripe's fees | Accounts v2 with Stripe collecting fees and losses | Covered |
| Decided: build on Stripe | The whole POS on Connect and Terminal; "Square instead of Stripe" is gone | Covered |
| Decided: staff-first bar POS | Staff screens section; Rail, Bar, Pin, Staff runs and Night | Covered, except DeskRoom (C15), Admin (C17, C18), the refund flow (C16) and roles (C2) |

### G. The reverse check

**In the spec but not the blueprint.** Google Business Profile hours push; transactional email; training mode; the `cardHold` deposit and `roomHold` modes; tip-review thresholds (25%, $50, 2 hours); pooling by room server; plan-billing dunning (read-only after 14 days); the support emergency path; signed rule packs approved by two people; WCAG 2.2 AA; RPO and RTO with restore drills; the 20-venue load test; payout matching and "unlinked Stripe activity"; the 72-hour DPA commitment (the blueprint says 30 days, C26). None of these conflicts with a blueprint decision; worth a line each in the blueprint.

**In the spec but in no milestone.** See C1: the guest site pages, Admin screens, desktop app shell and offline queue mode, receipts, email and files, Console support tools, ID checks and headcount, packages and promotion checks, room notes and faults, plan billing, retention and erase, the enquiries inbox, Google push and accessibility checks.

**On the canvas with no basis in either document.** Yelp and Homebase connections (C36), "Text the guest when it is on its way" and "Hold · text the room" (C34), the free-text happy-hour line (C31), and the "Room orders sound the alarm" toggle (C17).

### H. The 65 gaps from the Gap review, re-checked against the current spec and canvas

"Resolved" means the fix is still in the spec, and in the canvas where the Gap review said it was fixed there. "Partly reopened" means a later change, or a leftover, undoes part of the fix.

| Gap | Status now | Evidence |
| --- | --- | --- |
| B1 alcohol stop | Partly reopened | `alcohol_window`, 409, sale time at acceptance, booking caps, Rail at 4:02 AM and Admin last call are all in place. The clear-out check has no storage or screen, and Decline contradicts auto-cancel (C4) |
| B2 unknown results | Resolved (spec) | `payment_attempts`, unfinished-attempt index, `payment_unknown`, 2-second polling. Not drawn (C12) |
| B3 allocations | Resolved | `payment_allocations`; balance computed with the check locked |
| B4 open tabs and awaiting_tip | Resolved, with drift | The new `tipping` state isn't in the close and cut-off rules (C33). Staff Tips to enter and Night are shown |
| B5 internet fallbacks | Resolved | Cellular on, router device, three drill cases; Admin "Backup internet · to set up"; Setup router |
| B6 offline writers | Resolved (spec) | One writer, queue mode, `held` on replay. Canvas never drew it (C11) |
| B7 recovery | Resolved | Targets, two zones, second region, break-glass |
| B8 PINs | Resolved, with badges added | Pin shows name then PIN, lockouts and badges; Admin Team lacks badges (C18) |
| H1 Stripe inside transactions | Resolved | Three steps; check-number counter in its own transaction |
| H2 webhooks | Resolved | Connect endpoints, forward-only states, `livemode` check |
| H3 holds | Resolved | Card saved from the tap, increments within 8 of 10, overcapture, transfers |
| H4 deposit counted twice | Resolved | Deposit is a payment only; Night's "Held for future nights" |
| H5 revisions | Resolved | `check_revisions`, `version` |
| H6 segments | Resolved | `session_segments`, resume |
| H7 refunds | Resolved | Reversing lines; Night's refund includes tax and gratuity |
| H8 card on file | Resolved | Room's card-on-file close-out texts Marcus to confirm first |
| H9 booking terms | Partly reopened | Policy versions, payment link, running late and enquiries are in place. Saved-card wording is missing (C13); two closures stores (C20); payment-link hold (C37) |
| H10 tip pool | Resolved | Punches, eligibility, ledger, My tips, one role list. New role conflict (C2) |
| H11 business date and DST | Resolved | Business date, Temporal, both DST dates tested |
| H12 live events | Resolved | `venue_events` relay; a few event types missing (C21) |
| H13 jobs | Resolved | `jobs` with `SKIP LOCKED`, dead letters |
| H14 silent alarm | Resolved, with drift | Device channel, awake, presence, 15-second poll. Timings are now 30 s / 2 / 4 / 6 min; wording (C24); type (C20) |
| H15 graceful degradation | Resolved (spec) | Booking return path, Twilio status, vendor banners. Not drawn (C12) |
| H16 on-call | Resolved | Targets, runbooks, second responder |
| H17 no-venue requests | Resolved | Resolvers (`resolve_room_session` instead of `resolve_room_code`) |
| H18 append-only | Resolved | Grants, composite foreign keys, trigger audit |
| H19 scopes | Resolved | Principals, filtered channels, kiosk |
| H20 codes and links | Resolved | Join route with cookie, 128-bit links; KX4M7 without the room number |
| H21 approvals and offboarding | Resolved | Approvals on the approver's own phone. DeskRoom and the refund flow contradict it (C15, C16) |
| H22 keys | Resolved | Restricted keys, IP allow-list, 7-day rotation |
| H23 PCI | Resolved | Own origin, CSP and SRI, P2PE |
| H24 bots | Resolved | CAPTCHA, 10-minute holds, caps |
| H25 support and rule packs | Resolved | Grants approved in Admin (Console and Admin Team); two-person rule packs. Phase issue (C8) |
| H26 texting | Resolved (spec) | Recipient's time zone, opt-out wording, HELP, subaccounts. No "mark opt-out" drawn |
| H27 availability | Resolved | `room_blocks` exclusion. DeskCalendar wording (C37) |
| H28 inbox | Resolved | `conversations`, 11 service templates in Admin. The lists differ (C34) |
| H29 bar mode | Partly reopened | The up-next text was dropped (C34); no screens (C10) |
| H30 prices and big party | Partly reopened | `PriceSettings` and one `bigParty` rule; both calendars match. The happy hour is still text and a hard-coded banner (C31) |
| H31 files and receipts | Partly | Files, PDF job and receipt routes are in place; no upload route (C21); no receipt screen (C22) |
| H32 module off and billing | Resolved | Stopping state; Admin confirm lists live records |
| H33 cutover and training | Resolved | M7 and the training flag. PIN import (C7) |
| M1 late money and journal | Resolved | `adjusts_business_date`, named journal accounts |
| M2 card-fee math | Resolved | Written at confirmation, cash discount. Admin preview omits tax (C37) |
| M3 tax records | Resolved | Tax line fields, fee checks, tax-quarter route. Category list (C33) |
| M4 cash handling | Resolved | Drawer sessions, blind counts. Bar cash question (C19) |
| M5 gratuity rules | Resolved (spec) | Basis, reversal with approval, one line across splits. Receipt not drawn (C22) |
| M6 one account per organization | Resolved | Resolver-based payout matching |
| M7 printers | Resolved | USB host at the front desk, `jobToken`, polling within 5 s |
| M8 device clocks | Resolved | `server_time`, skew alerts |
| M9 per-venue restore | Resolved | Scratch restore, re-sync, drill |
| M10 deploys | Resolved | Expand and contract, linter, audited backfill role |
| M11 load test | Resolved | 20 venues, mocked Stripe latency |
| M12 M2 reader | Resolved | Setup offers S710, S700 and WisePOS E only |
| M13 ID scans | Partly reopened | Key per venue and business date, 7 days. The on-device, no-vendor-cloud rule was dropped (C33) |
| M14 breach and retention | Resolved | DPA 72 hours; the retention table covers every copy |
| M15 promotions | Resolved | Promotion checker; Main no longer shows a refused promotion |
| M16 accessibility | Resolved | WCAG 2.2 AA |
| M17 waitlist offers | Resolved | Offer holds and expiry |
| M18 room states and moves | Resolved | `room_states`, notes, faults, move with a new code |
| M19 room screen API | Resolved | Room-session routes; offline-tablet beta removed from the Console |
| M20 safety | Resolved (spec) | Help route, incidents, headcount. Manager alert not drawn (C12) |
| M21 undefined pieces | Partly open | Missing routes and events (C21); untyped keys (C20) |
| M22 song search | Resolved | Main hides search until `catalog` is set; SiteBuilder explains why |
| M23 Google and phase-2 room | Resolved | `integrations` Google, `site_versions`, `domains`, `locale` |
| L1 numbers and labels | The listed values are fixed; the same class of problem has reappeared | 113,000 everywhere, 13 of 19, tap first, no Square, bar reader on order. New mismatches (C28, C29) |

### I. Numbers checked and consistent across the three sources

- **Room 9:** $322.00 + $158.00 = $480.00; tax $42.60; gratuity $96.00; total $618.60; −$120 deposit leaves $498.60. Split two ways, $249.30 each; three ways, $166.20. Revision 2: $652.11. Surcharge: $13.46.
- **Prices and minimums:** $10 a person an hour; VIP $250 from 20 guests; minimum 3 on weeknights and 4 on Friday and Saturday; first-hour minimum; damage fee $150; 15-minute grace; deposit is the first hour, refundable 24 hours ahead; the big-party deposit is a flat $250.
- **Bar tabs:** opening hold $50; $600 flag; 4:30 AM cut-off (spec only); tips 18, 20 and 22% (or $1, $2, $3 under $10) in the spec, Terminal configuration, Admin and Rail; tip review at 25%, $50 or 2 hours; comps and voids at $25 each and $75 a shift (spec, blueprint, Admin, Rail, Room, Night).
- **Timings and locks:** aging at 120 and 240 seconds in both Rail and Bar code; idle lock 3 minutes; wipe lock 10 seconds; PINs of 4 and 6 digits; lockouts of 1, 5 and 15 minutes with a pause after 10 wrong tries; starting bank $300; note over $20; waitlist offer 10 minutes; wrap-up notice 10 minutes; cleaning flag after 8 minutes; headcount warning at 90%; support access up to 60 minutes.
- **Counts:** 28 pieces (8 Built, 1 Designed, 19 To build); 21 settings groups; 16 open decisions and 5 decided; 21 open technical questions; 11 integration kinds; 167 sources; 13 of 19 modules on with 4 core; $417 a month; 127 menu items in 15 categories; 14 rooms; 88 tables ("about 80"); 7 milestones.
