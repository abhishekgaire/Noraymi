# Phase 1 milestones

Sep 29, 2026 · the build plan engineering follows for phase 1: West 4 Boho Karaoke goes live on a backend built for many venues. The [spec](spec/README.md) says how each piece works; this page says when it's built and how we know it's done. Why each decision was made is in [decisions](decisions.md).

Nine milestones, in build order. Each one works on its own in staging when it's done, and it's done only when every line under "Done when" passes. Staging runs on the [demo seed](demo-seed.md) (Fri Sep 25, 2026, 10:41 PM, New York), so the names and numbers in these checks are the seed's. Board names such as Board or Rail are the design canvas boards in `design/canvas/`. The canvas is frozen at its 27 boards, which predate the Sep 28 decisions, so none of the Sep 28 states are drawn: approvals, training mode, check-in and waitlist offers, faults, cut-offs, bar mode, receipts, Pay my share, the join step and the outage banners among them. Where a board and the spec differ, or a state has no board, build what the spec says ([decisions](decisions.md), D78). Every milestone ships its staff screens in English and Spanish and the Admin sections listed in [Admin by milestone](#admin-by-milestone). Phase 1 ends at [the go-live gate](#the-go-live-gate).

## Estimate

**About 25 to 32 weeks** (6 to 7½ months) from the start of M1 to the end of the gate, for the founder working full time with Claude Code writing most of the code: 21 to 28 weeks of building (the sizes below add up to that), then the gate's 4 weeks of live nights. The blueprint's earlier "3 to 4 months" came before the Sep 28 additions: the Front desk role, approvals on the approver's phone, Pay my share, Same again, bar-mode alerts and the KJ tools, minimum spend, training mode, Spanish staff screens, offline queue mode, receipts, the minimal Console and the rest below.

What moves it inside the range:

- **Review sets the pace, not typing.** Claude Code writes the code; the founder reads every money path, runs every drill and checks each "Done when" by hand.
- **Outside waits.** Our company entity and Stripe platform account (M4 can't start without them), West 4's Stripe onboarding, delivery of the badges and badge readers, West 4's texting registration, and the lawyer, accountant and PCI sign-offs the gate needs ([Open technical questions](spec/14-open-questions.md)). All of them start now.
- **Hardware at the venue.** Two S710 readers on cellular, two receipt printers with drawers, two USB badge readers, 14 tablets in kiosk mode and the router each need a first install and usually a fix.
- **The staff trial.** A missed target changes the design, not the target (M9).
- **The gate restarts.** The range assumes 4 clean weeks. Each money error adds up to 4 more.

**Bottom-up check (Sep 29).** The [backlog](backlog/README.md) has 233 tickets: 75 small (up to a day), 147 medium (2 to 3 days) and 11 large (4 to 5 days). At those sizes they add up to about 375–570 working days, about 75–115 weeks for one person, against the 21 to 28 weeks of building above. The two agree only if a ticket takes about a quarter of its sized time. That's plausible when Claude Code writes the code, but nobody has measured it yet, so treat 25 to 32 weeks as the target, not the forecast:

- **After M1,** compare the actual days per ticket with the sizes, and re-forecast phase 1 from that ratio.
- **If the re-forecast runs past about 9 months,** cut or defer scope before M2 starts, or add a second developer. The first candidates are the pieces West 4 doesn't use at launch, such as the minimum-spend screens and the card-fee options (both off at West 4).

## At a glance

| # | Milestone | Usable when done | Depends on | Size | Backlog |
| --- | --- | --- | --- | --- | --- |
| M1 | Foundations | The team signs in on paired devices; Admin edits hours, the team and features | — | 2–3 weeks | [37 tickets](backlog/M1-foundations.md) · 47–75 days |
| M2 | Rooms and the board | A staff-run room night in staging: check-in, waitlist, moves, clocks and texts | M1 | 2–3 weeks | [35 tickets](backlog/M2-rooms-and-board.md) · 46–73 days |
| M3 | Room orders and the bar screen | A mock Friday of room orders: they ring, print, get carried, get cut off and stop at 4 AM | M2 | 2–3 weeks | [25 tickets](backlog/M3-room-orders-and-bar-screen.md) · 36.5–57 days |
| M4 | Payments and receipts | Room checks close out by tap, card on file, cash, split and Pay my share, with receipts | M3 | 3–4 weeks | [30 tickets](backlog/M4-payments-and-receipts.md) · 51.5–78 days |
| M5 | Guest site and online booking | West 4's site, booking with a deposit, and manage or cancel | M4 | 2 weeks | [17 tickets](backlog/M5-guest-site-and-booking.md) · 29.5–45 days |
| M6 | Bar POS, tabs and bar mode | The bar runs on card tabs with growing holds, and singers queue from their phones | M4 | 3–4 weeks | [28 tickets](backlog/M6-bar-pos-tabs-and-bar-mode.md) · 50–76 days |
| M7 | Close the night and the books | Drawers counted, tips pooled, the Z report and exports reconciled, training mode | M6 | 2–3 weeks | [20 tickets](backlog/M7-close-the-night-and-books.md) · 42.5–60 days |
| M8 | Offline, safety and operations | The venue gets through an outage; on-call, retention, billing and backups work | M7 | 3–4 weeks | [24 tickets](backlog/M8-offline-safety-and-operations.md) · 50.5–72 days |
| M9 | Cutover and going live | West 4 runs live nights, and the gate's 4 weeks begin | M8 | 2 weeks, then the gate | [17 tickets](backlog/M9-cutover-and-going-live.md) · 22–35 days |

M5 and M6 both need only M4, so they can swap.

## M1 · Foundations

**Ships**

- **Tenancy.** Organizations, venues, users and memberships; row-level security forced on every venue table, the resolver functions, foreign keys that name the venue, grants, and the read-only owner scope ([Tenancy and access](spec/02-tenancy-access.md)).
- **Sign-in.** Owners and managers by email with a passkey or an authenticator app, plus recovery codes; staff by invite with a phone code, then badge or name and PIN (4 digits, 6 for managers and owners, a blocklist, lockouts and the peppered hash); NTAG 424 DNA badges checked by their SUN message through a USB NFC reader; offboarding in one step. The email provider sends invites and account recovery.
- **Roles.** The five default roles (Owner, Manager, Bartender, Front desk, Staff) in `role_permissions`, checked by the API before every write.
- **Devices.** Pairing with one-time codes, signed device keys, heartbeats, clock offsets and revoking; staff phones install the staff app to the home screen and get push.
- **The desktop app shell.** Electron with its security checklist, the encrypted cache and keychain token, start at login, keep awake, the watchdog, updates at the business-day cutover, and the USB badge reader.
- **Settings, the rule pack and modules.** Versioned `venue_settings` checked against the rule pack on every save; the New York County rule pack; business dates in New York time; the `closures` table; `venue_modules` with states, dependencies and `404 module_off`; `venue_flags` ([Settings, rule packs and modules](spec/03-settings-rule-packs-modules.md)).
- **Plumbing.** The jobs table and scheduler, the event relay and WebSockets, idempotency keys, audit triggers with the per-venue hash chain, and the migration linter.
- **Languages.** Every staff string lives in a catalog from the first screen, never in code, in English and Spanish; each person picks theirs on sign-in or in Admin → Team (`memberships.locale`).
- **The minimal Console, part 1.** Our staff sign in with single sign-on and FIDO2 keys; a rule-pack version publishes only with two approvers and a signature; the module allow-list (`venue_modules.allowed`) and venue flags; a read-only venue list with device health.
- **Staging** seeded from the demo seed, and local development on Docker Postgres and Stripe's sandbox.
- **Canvas boards:** Pin, AdminDesk, Admin and Console. The badge column, the language picker and the module effects come from the spec.

**Done when**

- The principal suite calls every route as every principal, and the venue-wall suite calls every endpoint, job and webhook as venue A with venue B's ids. Both pass in CI and block a merge when they fail.
- In staging, Maya takes over the paired bar computer with a badge tap in under 2 seconds, and with name and PIN when her badge is at home. Andy opens Admin with a passkey, and a test shows no PIN session reaches any Admin route.
- A copied badge and a replayed badge read are both refused.
- Five wrong PINs lock that person on that device for 1, then 5, then 15 minutes. Ten wrong tries across names pause PIN sign-in on that device and alert the manager's phone, and the device's alarm channel keeps working.
- A settings save that breaks the rule pack is refused with the reason. A rule-pack version can't publish with one approver, and it applies at the next business-date boundary.
- Turning off Bar screen & tickets while Ordering from the room is on shows "Room orders would have nowhere to ring. Turn off Ordering from the room too?". Every route of a module that's off answers `404 module_off`.
- Killing the desktop app brings it back through the watchdog, and restarting the computer starts it at login, with nobody touching either.
- Diego switches to Español and every M1 staff screen is in Spanish. CI fails a build with a staff string missing in either language.
- Deactivating a membership ends its sessions, device keys, sockets and push subscriptions at once, and keeps its records.
- Each day's last audit hash lands in write-once storage, and changing an audit row breaks the chain check.

**Depends on:** nothing. Start now: order the NTAG 424 DNA badges and the USB NFC readers for the bar computer and the front desk.

**Size:** 2–3 weeks.

## M2 · Rooms and the board

**Ships**

- **The board** (Tonight): the 14 room tiles and their states, the top alerts, each room's `free_until`, and the waitlist drawer; DeskRoom's room panel and running tab (payment comes in M4); the Calendar on desktop and phone; the staff phone's Tonight, Rooms, Calls and Waitlist tabs.
- **The room clock.** Segments, the first-hour minimum, billable guests by business date, the VIP rate, time bands in every rate mode with a billing step and rounding (K13), the soft end ("Stay on by the minute until we close at 4 AM") and pauses ([Money rules](spec/05-money-rules.md) 2–4).
- **Bookings made by staff**, each with a real room, room blocks, cleaning time between bookings, no-shows after the 15-minute grace, and `booked_by` on bookings and sessions (K9). Online booking comes in M5.
- **Check-in**, the same sheet on the board and the phone (`POST /bookings/{b}/check-in`): party size with the billable minimum, IDs checked ("x of n"), the room, when the clock starts, the deposit (shown from the booking; allocated to the check once the payment core lands in M4) and a new room code texted to the host. [+ Walk-in] opens the same sheet with a free room.
- **The ID check and the headcount.** `id_checks` at check-in, and the live headcount from check-ins, walk-ins and the front-desk door counter against `safety.occupancyLimit` ("Limit not set · Admin → Safety" at West 4; a warning at 90% once a limit is set).
- **The waitlist.** Entries from staff and from the guest page behind the door QR; offers that hold a room for 10 minutes with a countdown and a text, and "Not delivered · Call" when the text fails; Seat, expiry, Remove and Text.
- **Room move and party size.** The move sheet lists only rooms that fit and are free for the time needed; a move opens a new segment and a new room code and sends the old room to cleaning. Party size +/− shows the new rate and billable minimum and closes the segment.
- **Room operations.** Cleaning marked done by staff and flagged after 8 minutes; room notes; faults (Out of service, [Pause the clock] with approval, [Comp 15 min of room time] as a reason-only comp); the $150 damage fee with a photo; lost and found; room calls to the board and every staff phone's Calls list.
- **Approvals.** The approvals table and routing, and the Approvals inbox on the approver's phone, starting with room-clock pauses; later milestones add their kinds.
- **Files.** Presigned uploads (`POST /files`) with type and size limits, for damage and lost-item photos first.
- **Service texts.** West 4's Twilio subaccount; the 12 service texts and the 2 marketing texts (off) in `message_templates`; sending as `sending`, then sent, delivered or failed; replies into the two-way inbox (Messages on desktop and phone); STOP and HELP. Staging texts only our own test phones.
- **Public forms.** The server-checked CAPTCHA and daily limits on the waitlist page and on phone codes.
- **Canvas boards:** Board, DeskRoom, DeskCalendar, Calendar, DeskMessages, Messages, Room, Staff and Waitlist. The check-in sheet, waitlist offers, the move sheet, faults, lost and found, the headcount and the Approvals inbox come from the spec.

**Done when**

- On the demo seed at 10:41 PM, every tile, clock and "Room time so far" matches the seed to the cent (Room 9: 161 min, $322.00; VIP room: 71 min, $295.83), and the board counts 8 rooms in use, 3 open, 2 cleaning and 1 out of service.
- Pricing property tests pass for bands in each rate mode, billing steps of 1, 15, 30 and 60 minutes, party-size changes mid-session, and both daylight-saving nights (Nov 1, 2026 and Mar 14, 2027).
- Checking in Sam O. shows "3 guests · Fridays bill at least 4", shows his $40 deposit and texts a new 5-character room code. [Mark no-show] appears only after the 15-minute grace.
- Offering Room 11 to Amara B. holds it for 10 minutes with a countdown and texts her. A failed text shows "Not delivered · Call", and an expired offer releases the room to the next party that fits.
- The move sheet for Rob & Kim lists only rooms that fit 7 and are free long enough (Room 11, free all night). Moving them issues a new code and sends Room 7 to cleaning.
- A clock-pause request from Diego lands in Andy's Approvals inbox and never on Diego's device, and Diego's screen shows "Waiting for Andy". Andy's own request goes to Abhishek.
- With no occupancy limit set, the board shows "Limit not set · Admin → Safety" and no number.
- A guest's reply ("running 15 late") lands in Messages on the right booking, and STOP stops every text to that number at once.

**Depends on:** M1.

**Size:** 2–3 weeks.

## M3 · Room orders and the bar screen

**Ships**

- **The menu.** The editor (items, variants, options, modifier groups, short button names, the alcohol flag, tax categories, out tonight), categories, packages and dated price rules, the promotion checks on every save, and the menu PDF job (HTML to a tagged PDF, made again on every menu change).
- **Room tablets** in kiosk mode ("Room available" between sessions), and **the room page** on guests' phones: joining with the room code, the menu, ordering, live status in the canonical words, call staff, the host lock, the running bill and Same again (K16).
- **The order pipeline**: `ringing, held, accepted, ready, on_the_way, delivered, returned, cancelled`, with Accept as the sale, [Ask the room to wait], [Decline…] with a reason the guest sees, and guest cancel only while an order is ringing or asked to wait.
- **The bar orders screen** (Bar) and room-order alerts on the board, aging and escalating: "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup." Plus Mute, and the alert when no bar device is connected. The aging times run on West 4's defaults until Admin → Bar POS arrives in M6.
- **Tickets.** Print jobs to Star CloudPRNT and Epson Server Direct Print printers, and to USB printers through the desktop app's print host; "Ticket didn't print · Reprint", which prints "REPRINT 2".
- **Runs** on every staff phone: [I've got it], [Delivered] and [Couldn't serve…] with a reason; after a return the bar picks [Void · not made], [Void · made (waste)] or [Remake].
- **Comps and voids** through one fix panel on every screen, labeled COMP or VOID, with the reason-only limit ($25 each and $75 a shift per person, counted across the bar screens, Room, DeskRoom and the board) and approvals above it.
- **Alcohol controls.** The alcohol window from the rule pack and the house last call (`409 alcohol_closed`). Cut-off for a room or one guest (the board's tile panel, DeskRoom and the Room phone), logged in `alcohol_refusals`. At 4:00 AM every alcohol button greys out and alcohol orders nobody accepted cancel themselves with a message to the room, with no Decline button after 4 AM. At 4:30 AM the board asks for the clear-out check (`clear_out_checks`).
- **Accessibility checks** in CI for the room page and tablets (WCAG 2.2 AA).
- **Canvas boards:** Bar, Order, Board, DeskRoom, Room, Staff and AdminDesk. The join step, "Room available", the pipeline's words, Same again, reprints, the cut-off controls and the 4 AM and 4:30 AM states come from the spec.

**Done when**

- A mock Friday in staging, run by two people on the demo seed: every order from a tablet and from a phone rings on Bar and the board, prints on the bar printer (one network printer and one USB), moves through the six steps with the same words on every screen, and joins the right check at Accept. Room 9's drinks read $158.00, and the ringing 2 × Margarita · Peach isn't on the tab until it's accepted.
- On a simulated clock, an order nobody accepts buzzes bar phones at 30 s, shows on the board at 2 min ("on Andy's phone" at 4) and texts Andy at 6.
- Unplugging the bar printer shows "Ticket didn't print · Reprint", and the reprint says "REPRINT 2".
- At 4:00:00 AM (simulated, on a normal night and both daylight-saving nights), every alcohol button greys out, an unaccepted alcohol order cancels itself and the room reads "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged", and every alcohol route answers `409 alcohol_closed`. At 4:30 the board asks for the clear-out check, and [Done] records "Clear-out check · Andy · 4:31 AM".
- Cutting off a room, and cutting off one guest, blocks alcohol from the room page, host orders and staff orders, shows "Cut off by Andy at 10:30 PM" on every screen for that room, and logs each refusal.
- Reason-only comps add up per person across every screen (Maya's $12 so far tonight leaves "$63 left this shift"). A void over $25 goes to Andy's inbox, the requester sees "Waiting for Andy", and Andy decides on his own phone.
- A package or price rule that breaks the promotion checks can't be saved. The menu PDF matches the menu within a minute of a save.
- Same again re-orders the room's last delivered round, and it still rings the bar.

**Depends on:** M2.

**Size:** 2–3 weeks.

## M4 · Payments and receipts

**Ships**

- **Stripe for West 4.** Our platform account (it needs the entity decision), West 4's connected account on Accounts v2 through Stripe's onboarding, the Terminal configuration with cellular on and West 4's tip choices, the Location, and both S710 readers (bar and front desk); restricted keys per service; the webhook endpoints ([Stripe setup](spec/06-stripe-setup.md)).
- **The payment core.** Payments, attempts and allocations, the state machine, safe-to-repeat calls to Stripe, the reconciler for unknown results, and the chaos tests ([Payment flows](spec/07-payment-flows.md)).
- **Checks.** Revisions and finalize ([Present the check] locks ordering, and a manager can [Reopen the check]), tax lines by category, the gratuity on room checks, the card-fee engine (surcharge at the reader or cash discount, off at West 4) and check numbers in order.
- **Room close-out** on DeskRoom and the Room phone: a tap on the chosen reader with every reader state, card on file with the guest's confirmation (or a manager's approval once the guest has left), cash through the cash panel (amount handed over, change due, "Wrong amount? Fix the change", a cash tip), a split evenly or by item with leftover cents by largest remainder, and "Additional tip (optional)".
- **Pay my share (K2)** on the room page: "My items" or "An even share (1 of N)", with the guest's share of tax and gratuity, by Apple Pay, Google Pay or card through the Payment Element on our own payment-page origin. The booker's card still guarantees the rest.
- **Two cash drawers**, both house drawers: the bar drawer on the bar printer's kick port and the front-desk drawer on the front-desk printer. Cash goes into the drawer at the screen where it's taken ("Logged to Maya · bar drawer"). Counts, handovers and the drawer-per-person model come in M7.
- **Minimum spend (K4)** from `prices.minSpend`: "$84 to your minimum" on the tile, DeskRoom and the room page where one is set, and any shortfall as a `min_spend` line at close. It's off at West 4, so West 4's screens show nothing.
- **Refunds** from a paid check (lines, then the payment, then a reason, then [Send to Abhishek] when Andy asks), approved on another manager's or the owner's phone, capped at what that payment captured minus earlier refunds, and "Refund pending" until Stripe confirms. Two more approval kinds: card on file without the guest, and a lower party size after the gratuity applies.
- **Receipts:** print, text, email and the public receipt page, with "Gratuity included (20%)", the tax lines and the check number; receipt PDFs from the PDF job; email through the email provider.
- **Disputes:** the inbox with each deadline and the evidence gathered (the receipt PDF, the clock times, the accepted terms, damage photos).
- **Data-model reservations, no screens:** the prepaid-value ledger (K5: issued, redeemed, expired and refunded, a liability in the journal), and merging two sessions onto one check with their deposits and holds kept (K9).
- **The go-live checklist** that stands in for Setup's West 4 checks until the wizard exists: the merchant category is set before bar tabs turn on, and each manager has a Stripe Dashboard login on West 4's account and a phone that runs Tap to Pay.
- **Canvas boards:** DeskRoom, Room, Order and AdminDesk. The close-out states, "Your bill", Pay my share, confirming card on file, the receipts (printed and web) and the disputes inbox come from the spec.

**Done when**

- The chaos tests pass: the API is killed between Stripe's success and our commit, and the reconciler adopts or cancels the payment, so nobody is charged twice. Timeouts, a reader dropping mid-payment and missing webhooks all end in a known state.
- On the connected sandbox, Room 9 closes out as the seed says ($618.60 total, −$120.00 deposit, $498.60 to pay) three ways: one tap; 12 Pay my share payments of $41.55; and an even split with one share in cash. Every split adds up to the cent. Accepting the ringing margaritas after [Present the check] writes revision 2 with the numbers in [Money rules](spec/05-money-rules.md).
- Small live payments on West 4's own account are captured and refunded on both S710s, with no double charge under forced timeouts.
- A refund Andy asks for waits in Abhishek's inbox, can't go over what was captured (Marcus's cap is $120), and shows "Refunded" only after Stripe confirms.
- A dispute opened in the sandbox shows in the inbox with its evidence already gathered.
- A receipt reads the same printed, texted, emailed and on the public page.
- Tests prove the prepaid-value ledger balances through issue, redeem, expire and refund, and that a merged pair of sessions keeps both deposits and holds on one check.
- The go-live checklist passes for West 4.

**Depends on:** M3; our entity and Stripe platform account; West 4's Stripe onboarding; both S710s registered to West 4's Location.

**Size:** 3–4 weeks.

## M5 · Guest site and online booking

**Ships**

- **The guest site** from `site_versions`, server-rendered: the homepage, rooms, the menu page (HTML first, with the PDF), private parties with the enquiry form (enquiries land in Messages), and the song-search section, which shows only its heading and West 4's song count until a catalog arrives. Prices read "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour", following `website.priceWording`.
- **Online booking** (Book): the full-price summary, the guest's details, the service-text notice and an unticked marketing opt-in, the policy accepted and stored with its version, the deposit on the payment page with the 10-minute hold, and the confirmation. The manage-booking page changes and cancels, with refunds by the refund window in New York time. Payment links for staff and big-party bookings, and `cardHold` for venues that take no deposit.
- **Public forms:** the server-checked CAPTCHA and daily limits on booking and enquiries, and one PaymentIntent per booking.
- **Google Business Profile:** hours pushed on every change once it's connected.
- **Accessibility:** WCAG 2.2 AA with CI checks, and a person's screen-reader pass on booking, manage, the waitlist page and ordering.
- **Canvas boards:** Main, Rooms, Menu, Parties, Book, Manage and AdminDesk. Book's details, consent, payment and confirmation steps come from the spec.

**Done when**

- A guest books Jae & co.'s booking (5 guests, Fri Sep 25, 11:00 PM, 2 hr, small tier) on the sandbox: the summary shows the full price with tax and the 20% gratuity before paying, the accepted policy version is stored, the $50 deposit is paid on our payment origin, and the confirmation text and page agree. Manage then changes the booking and cancels it, with the refund following the 24-hour rule in New York time.
- The payment page passes its header, script and changed-script checks ([Security and data retention](spec/12-security-retention.md) 1).
- With Online booking & deposits off, the hero's "Book a room" reads "Call to book" with West 4's number, and existing bookings' manage links still work.
- The menu page, the PDF and the room page show the same items and prices, and a hidden item is gone from all three.
- The automated accessibility checks pass, and the screen-reader pass finds nothing that blocks a task.

**Depends on:** M4 (the payment core, the payment origin and refunds).

**Size:** 2 weeks.

## M6 · Bar POS, tabs and bar mode

**Ships**

- **The bar POS** (Rail): the fixed grid from published `pos_layouts` (a change starts at the next business date), Quick sale, repeat round and undo, unsent drinks saved on the server, badge takeover, the idle and wipe locks, the room-order cards across the top, and "Maya · on break" ([Staff screens and the bar POS](spec/10-staff-screens-bar-pos.md)).
- **Bar tabs**, card first: the opening consent line read to the guest ("We'll hold $50 on this card and add to it as you order…") with [Read to guest ✓], and the tab slip; one open tab per card; the hold that grows by incremental authorization, and declined raises; tips on the reader, with the paper slip and its "Tips to enter" queue as the fallback (tips over 25% go for approval); splits whose paid shares are kept; reopening a captured tab; paying with a different card; [Move tab to a room]; the tab cut-off; cash always taken.
- **Closing tabs:** "Charge the remaining tabs" at the end of the night, and the 4:30 AM job that charges any tab still open, with walkout and sweeper captures.
- **Bar mode:** singers join from their phones or at the bar with a phone code; round-robin with 1 song per singer per round; [Started] posts the song line or uses a drink credit (West 4's "Buy a drink, get a song"), [Skip] is free, and a staff override is logged with a reason; "2 singers before you" by push and "You're up next at the bar · come to the stage" by push and text; the Up next TV; the KJ's song-queue screen; the songbook CSV upload (title, artist, code); "Send the singer a drink" as a gift order that checks the alcohol window and the receiving tab; the play log.
- **Canvas boards:** Rail, Staff and AdminDesk. The consent line and tab slip, Admin → Bar POS (with the tab settings) and Bar mode, and all of bar mode (the singer's queue page, the Up next TV and the KJ's song-queue screen) come from the spec.

**Done when**

- The timed tasks in Staff screens and the bar POS meet their targets in staging (a walk-up beer in cash under 8 s, another round under 3 s, taking over the terminal under 2 s).
- Every tab path passes on the connected sandbox: a declined raise, a timeout, a cut-off (alcohol greyed out, alcohol moves onto the tab refused), a walkout charged at 4:30 AM, a reopened tab that shows "Paid $272.19 · no hold" and no "Close to card", and $32.66 split into $16.33 + $16.33 that survives leaving the pay panel.
- Moving Jess P.'s tab into Room 9 moves every line as a transfer ("Moved from Jess P.'s bar tab"), releases her hold once the room has a payment method, and refuses alcohol when the room is cut off.
- Diego's void of 1 × Large bucket · 10 beers ($70) on Tariq A.'s tab waits for Andy, and Tariq A.'s tab shows "Waiting for Andy" until he decides.
- The seed's queue plays out: Luis M. is singing, Jess P. is next, Ben T.'s phone reads "2 singers before you" and then gets "You're up next" by push and by text, and Sofia R. shows "Needs a drink credit". The TV never shows a phone number.
- A songbook CSV loads and is searchable from the queue page.
- A gift order to a cut-off tab, or after 4 AM, is refused with the reason.

**Depends on:** M4 (the readers and the payment core) and M3 (orders and cut-offs).

**Size:** 3–4 weeks.

## M7 · Close the night and the books

**Ships**

- **Drawers:** blind counts of both drawers, the handover when the manager on duty changes, drops, paid-outs over the limit sent for approval, no-sale with the PIN, and the drawer-per-person model with trays (a change starts at the next business date).
- **The time clock:** clock-in with the duty (Bar, Front desk, Runner, Manager), breaks, edits with a reason, and the clock-out checklist (hand over open tabs and unsent drinks, drop cash or count your bank, declare cash tips).
- **Tips:** the tip ledger, pools by hours with per-person eligibility and shares by occupation (owners and managers never share), and My tips with the 146-2.17 records.
- **Close the night** (Night): the checks before closing, each with a link to fix it (staff still on the clock, open waitlist entries, ringing or asked-to-wait orders, pending approvals, rooms still cleaning, unsent drinks, the clear-out check, paper slips not entered, both drawers counted); "Print X report (running)" before the close and "Print Z report" only after it; drinks split into room checks and bar tabs, with the gratuity from room checks only; adjustments after the close.
- **The books:** payout matching, "Unmatched payments" for Stripe activity with no check (break-glass payments included), the nightly accounting journal (a file for QuickBooks), the payroll export, the tax-quarter report, and the reports (weekly and 8-week trends, occupancy, bookings, staff actions).
- **Training mode:** Admin → Team → Training mode, per person or per device for a new hire. Practice checks are numbered T-… on their own counter and pay only through Stripe's sandbox, never the live account; every screen shows a permanent "TRAINING · not real money" band; practice checks stay out of the Z report, tax, exports, tip pools and the reason-only totals ([Testing and operations](spec/13-testing-operations.md)).
- **Canvas boards:** Night, DeskReports, Reports, Staff and AdminDesk. Night's checks, the X and Z reports' split, training mode, Unmatched payments and the tax-quarter report come from the spec.

**Done when**

- Two weeks of staging nights on the demo seed reconcile to the cent: every Z report matches the checks, both drawer counts, the tip ledger and Stripe's payouts, including one daylight-saving night.
- Night shows "3 slips not entered · tips post to Sat Sep 26" for the seed's three slips and won't close until every check passes or is fixed. "Print Z report" appears only after the close.
- The Z report's gratuity is 20% of room checks only: room time + room drinks + packages sold to rooms − room comps and refunds.
- A late tip posts to the current business date and points at its night, and a closed night never reopens.
- A training-mode check is numbered T-…, calls only Stripe's sandbox (a test shows a practice request can't reach the live key or a live reader), shows the band on every screen, and is absent from the Z report and every export.
- The accounting journal balances for every night and every payout, and the payroll export splits gratuity (wages) from tips.

**Depends on:** M6 (tabs and tips) and M4.

**Size:** 2–3 weeks.

## M8 · Offline, safety and operations

**Ships**

- **Offline and outages** ([Devices, printing and offline](spec/09-devices-printing-offline.md)): the banners ("On backup internet · card readers may take up to 2 min to switch", "Offline · read-only · orders queue with an offline code", "Stripe is having trouble · card payments may fail", "Texts are delayed") and the board's "Online · synced 4 s ago"; the router as a device reporting the line or LTE; the read-only board and tabs from the desktop cache; queue mode behind an offline code, with rounds marked "queued · not charged"; replay that lands every order as asked to wait ("Confirm replayed orders (3)"); the "Review after outage" list on Night; and the one-page break-glass card (Tap to Pay in Stripe's Dashboard app, matched afterwards in Unmatched payments).
- **Safety:** the private help alert ("Need a manager, privately?") to managers' phones only, with [I'm on it] and notes; the board's "Manager needed" pin with no room and no reason; the incident log, kept 3 years.
- **The license register (C6):** ASCAP, BMI, SESAC, GMR and local licenses with number, holder, expiry, fee, conditions and a copy, and renewal reminders (Admin → Licenses).
- **The minimal Console, part 2:** support grants (a reason, a scope and up to 60 minutes, approved by the venue's owner in Admin → Console, read-only on masked views) and the emergency actions (re-sync a payment, cancel a reader action, requeue a print, close a stuck night), which need a second approver on our side and tell the owner at once.
- **Data jobs:** the nightly retention job, guest erase, destroying each night's ID-scan key after 7 days, and detaching saved cards on schedule ([Security and data retention](spec/12-security-retention.md)).
- **Our plan billing** on Stripe Billing, with the failed-payment banner and read-only Admin after 14 days; the board, rooms, bar and payments never stop.
- **Watching production:** metrics, logs and traces, error tracking with personal data stripped, the public status page, alerts with runbooks, and the synthetic order and reader payment every 5 minutes during opening hours.
- **Backups and load:** the per-venue restore and its monthly drill, and the Friday-night load test.
- **Texts go live** on West 4's registered 10DLC campaign.
- **The one-room mic power trial (K1)**, only with West 4's written approval and after Playbox answers the equipment-warranty question: our own switched outlet on one room's wireless-mic receiver, never on the song player, on at check-in, off at close-out or cleaning, and left on whenever our server can't be reached ([Song systems and texts](spec/11-song-systems-texts.md) · Mic power trial). The trial isn't part of the gate.
- **Canvas boards:** Board, Rail, Bar, Night, Staff, Console and AdminDesk. The outage banners, queue mode, "Review after outage", the help alert, the incident log, Admin → Licenses and support grants come from the spec.

**Done when**

- The outage drills pass at West 4: the internet down with the Wi-Fi up, the access point off, the router's LTE off too, and our cloud down. Each shows its banner; queue mode takes orders behind a code; replay lands them as asked to wait with nothing charged twice; anything that fails the checks is on "Review after outage"; and a break-glass tap on each manager's phone lands in Unmatched payments.
- A help alert from Room 9 reaches only the managers' phones, and the board shows "Manager needed" with no room.
- The restore drill brings one venue back from a scratch copy without touching the others, and its counts match Stripe.
- In the load test (20 venues peaking together), the bar alarm still rings within 3 seconds.
- A support grant opens only after the owner approves it, stays read-only and ends at 60 minutes. An emergency action needs our second approver and tells the owner at once.
- The retention job deletes or pseudonymizes what's past its time and logs it. Erasing a guest blanks their details, detaches their saved cards and keeps the opt-out as a hash.
- A license inside its reminder window sends the reminder.
- A failed plan payment on our test venue shows the banner, and 14 days later on a simulated clock Admin is read-only while the board, rooms, bar and payments keep working.
- A second responder is on call, and a page nobody acknowledges in 10 minutes reaches them.

**Depends on:** M7 (Night's review list and Unmatched payments) and M5 (guests to erase); West 4's 10DLC approval.

**Size:** 3–4 weeks.

## M9 · Cutover and going live

**Ships**

- **Imports:** West 4's future bookings with their deposits, guests with their consent evidence, and the menu. From the team, **people and roles only**, never PINs.
- **Everyone's own sign-in:** invites so each person sets a new PIN on their own phone and pairs their badge.
- **The domain move** of west4karaoke.com, with a redirect from every old page.
- **Hardware installed and paired:** both S710s, both printers and drawers, both badge readers, the 14 tablets, the Up next TV and the router, with a cellular signal check at every pay point.
- **Training and the timed staff trial:** staff learn in training mode, then three bartenders new to the system and a front-desk person run the scripted 20-minute rush in the venue, music on and hands wet (Testing and operations).
- **A Spanish review:** a fluent Spanish speaker checks every staff screen.
- **Live nights** at West 4, with on-call covering every opening hour.

**Done when**

- An import dry run loses nothing: bookings, deposits and consents match West 4's old system in count and to the cent.
- Before the first live night, everyone on West 4's team has set a new PIN on their own phone and paired a badge (Admin → Team shows nobody waiting), and no imported PIN exists anywhere.
- The cellular signal check passes at both pay points.
- The staff trial meets its targets, or the design changed and the trial ran again.
- Every old west4karaoke.com page redirects, and bookings made on the old site before the move are on the board.
- The go-live gate below is met.

**Depends on:** M8 and everything before it.

**Size:** 2 weeks, then the 4-week gate.

## Admin by milestone

Section names follow the canvas where it has them; Bar POS, Licenses and Console are new.

| Admin section | What it edits | Milestone |
| --- | --- | --- |
| Team | People, roles, invites, badges and each person's language; tip eligibility and training mode come in M7 | M1 |
| Features | Modules within the plan, their dependencies and what each hides | M1 |
| Hours & prices | Weekly hours, the house last call and special dates (M1); rates, bands, minimums, the VIP rate, booking limits and the damage fee (M2); minimum spend (M4) | M1 |
| Printers & devices | Pairing and revoking (M1); printers (M3); drawers and readers (M4); the router (M8) | M1 |
| Rooms | Names, sizes, cleaning, on or off | M2 |
| Alerts & rules | When a room's time is ending | M2 |
| Safety | The occupancy limit (M2); the help alert and incidents (M8) | M2 |
| Phone & texts | The call number and the number texts come from | M2 |
| Texts | All 14 texts: wording, on or off | M2 |
| Menu | Items, options, button names, the alcohol flag, tax categories, out tonight, packages and specials | M3 |
| Card fee & gratuity | The card fee (off at West 4), gratuity, the reader's tip screen, tip review and Pay my share | M4 |
| Payments (owner only) | The Stripe account and payouts; our plan (M8) | M4 |
| Connections | Stripe, Twilio and email; Google Business Profile (M5); the accounting export (M7) | M4 |
| Deposits & cancelling | The deposit rule, big parties, the refund window and the policy guests accept | M5 |
| Website | Words, photos, which sections show, and how prices are worded; styles, section order and domains wait for the builder in phase 2 | M5 |
| Bar POS | The `pos` and `tabs` keys: layouts per station, reason-only limits, idle and wipe locks, the bar-tab tip path, order aging, the chime and Mute, the opening hold, the large-tab flag and the tab cut-off | M6 |
| Bar mode | Song price ("Song price · not set · songs need a drink credit" at West 4), drink credits, songs per round, free nights, singer alerts and the songbook upload | M6 |
| Cash drawers | The drawer model, starting bank, note limit, second counter and paid-out approval | M7 |
| Licenses | Performance and local licenses and their renewals | M8 |
| Console (owner only) | Support-access requests from our staff | M8 |

## The go-live gate

Phase 1 is done when all of these are true:

1. Every must-fix item in [the table below](#must-fix-items-and-where-they-close) is closed: the milestone in its "Closed by" column has passed its "Done when".
2. The sign-offs marked "gate" in [Open technical questions](spec/14-open-questions.md) are in, from the lawyer, the accountant and the PCI assessor.
3. West 4's future bookings, deposits and guests are imported with nothing lost (M9).
4. The outage drill has passed (M8).
5. Then West 4 runs **4 weeks of live nights without a money error**.

A **money error** is any amount charged, refunded, tipped, taxed, paid out or reported that differs by any amount from what the [money rules](spec/05-money-rules.md) give: a double or missed charge; a wrong line, tax, gratuity or tip; a refund over its cap; or a Z report, drawer count or payout that doesn't reconcile to the cent. When one happens, it's fixed and the 4 weeks start again.

## Must-fix items and where they close

The GA- codes are the items of the earlier [Karaoke bar POS gap analysis](archive/research/karaoke-bar-pos-gap-analysis.md): GA-M for must-fix, GA-S for should-have and GA-N for nice-to-have. The analysis calls them M1–M11, S1… and N1…; the prefix keeps them apart from the milestones on this page and from the older gap review's codes.

| Code | Must-fix item | Where the spec covers it | Closed by |
| --- | --- | --- | --- |
| GA-M1 | The card fee: a capped, credit-only surcharge or a cash discount, never over the caps (off at West 4) | [Settings](spec/03-settings-rule-packs-modules.md) (`CardFee`, the rule pack), [Money rules](spec/05-money-rules.md) 10, [Payment flows](spec/07-payment-flows.md) (card fee at the reader) | M4 |
| GA-M2 | Gratuity and the tip pool: one label everywhere, all of it to eligible staff by duties, 6-year records, and the payroll split | Settings (`pay`), Money rules 9, [Data model](spec/04-data-model.md) (tip ledger and pools), [API](spec/08-api.md) (My tips, payroll export) | M7 |
| GA-M3 | Marketing texts: their own unticked opt-in with proof, sent only 8 AM–9 PM, opt-outs honored at once, and 10DLC | [Song systems and texts](spec/11-song-systems-texts.md) (consent and timing), Data model (`consents`) | M8 (STOP in M2, the opt-in in M5, West 4's campaign live in M8) |
| GA-M4 | Tax on each line by category, check numbers in order that can't be edited, dated Z reports, no deletes | Money rules 8, Data model (the money core), [Security](spec/12-security-retention.md) 4 | M7 (tax lines and check numbers in M4) |
| GA-M5 | Booking shows the whole price and stores the accepted terms; refund cut-offs in New York time; ready for all-in prices | Payment flows (deposit when booking online), Settings (`deposit`, `website`) | M5 |
| GA-M6 | A hard 4 AM stop for alcohol on every channel, the 4:30 AM clear-out check, and cut-offs on the wall clock through daylight saving | Settings (the alcohol window), Money rules 5, Data model (`clear_out_checks`) | M3 |
| GA-M7 | Cut-off for a room, one guest or a tab; refusing at delivery; a refusal log; alcohol never accepted automatically | Money rules 5, Data model (`room_sessions`, `room_guests`, `tabs`, `alcohol_refusals`), [Staff screens](spec/10-staff-screens-bar-pos.md) | M6 (rooms and guests in M3) |
| GA-M8 | Offline mode: a plan and a drill, a read-only view, orders queued and checked again on replay | [Devices, printing and offline](spec/09-devices-printing-offline.md), [Scope and architecture](spec/01-scope-architecture.md) | M8 |
| GA-M9 | The security and PCI baseline | [Security and data retention](spec/12-security-retention.md) | M8 (sign-in in M1, the payment page in M4) |
| GA-M10 | Music licensing: the license register with renewals, and the play log | Data model (`licenses`, `song_plays`), Song systems | M8 (the play log in M6) |
| GA-M11 | Bar-mode guardrails: the card fee on growing holds, no new tabs offline, cash always taken, the 4:30 AM charge told when a tab opens, song lines taxed, the play log, per-singer limits and alerts, gift orders checked for cut-offs (text reminders for unpaid tabs aren't adopted) | Payment flows (bar tabs, songs), Song systems (bar mode queue), Staff screens | M6 |

The should-have and nice-to-have items the blueprint cites:

| Code | Item | Where the spec covers it | In phase 1 |
| --- | --- | --- | --- |
| GA-S1 | Pricing breadth: bands mid-session, day rules, the minimum headcount, other rate modes, logged headcount changes, pauses with approval | Settings (`prices`), Money rules 3 | M2; holiday rules are phase 2 |
| GA-S2 | Specials and packages with liquor-law checks | Settings (promotion checks), Data model (`packages`, `price_rules`) | M3; headcount tiers and packages sold in the booking are phase 2 |
| GA-S3 | The running bill on the room page, the draft check, and each share's tax and gratuity | Staff screens, Payment flows (room close-out) | M3 and M4 |
| GA-S4 | Song-system control of the room | Song systems | Phase 2 through adapters, KaraFun first; phase 1 runs as `none` and runs the mic power trial (M8) |
| GA-S5 | Room operations: cleaning time, the fault log, damage fees with photos | Data model (`room_faults`, `room_notes`, `lost_items`) | M2; the signed cleaning checklist is phase 2 |
| GA-S6 | The discreet help alert and the incident log | Devices (safety), Data model (`incidents`) | M8; welfare timers are phase 2 |
| GA-S7 | ID checks within §65-b: four fields, never shared, a count per room | Data model (`id_checks`), Security 6 and retention | M2 (at check-in) and M8 (destroying the keys) |
| GA-S8 | Occupancy and license records: the headcount against the posted limit, and the license register | Settings (`safety`), Devices (safety), Data model (`door_counts`, `licenses`) | M2 (headcount) and M8 (licenses) |
| GA-S10 | The dispute inbox with its evidence | [Stripe setup](spec/06-stripe-setup.md) 9 | M4 |
| GA-S12 | Reporting by sales-tax quarter | API (reports) | M7; the $300,000 alert, revenue per room-hour, ticket times and labor share are phase 2 |
| GA-N1 | Event sales | — | The enquiry form and big-party booking in M5; the rest is phase 2 and 3 |
| GA-N2 | Prepaid value | Data model (`prepaid_ledger`) | The ledger in M4; gift cards in phase 2, stored value in phase 3 |
| GA-N3 | Guest CRM | — | Phase 2 |

## Not in phase 1

The [blueprint's build plan](blueprint.md#build-plan) lists each later phase in full. In short:

- **Phase 2:** multi-location owner accounts, the setup wizard, the website builder (styles, section order, own domains) and the full control panel; rule packs for other counties and the multi-venue settings; the kitchen module (K14); song-system adapters, KaraFun first; Korean and Chinese screens; packages sold in the booking (K3); inventory counts (K7); the native-app decision for offline cards (K10), and with it one handheld for the order and the card (K15); booking conversion (K12); guests extending or moving themselves (K17); gift cards (K5) and guest profiles (K11); tips to the KJ and paid priority (K6); and the items marked phase 2 in the blueprint, such as holiday price rules, minimum spend credited against the room fee, allergen fields, room welfare timers, the signed cleaning checklist, the per-room volume cap, package headcount tiers and the $300,000 sales-tax alert.
- **Phase 3, before the pilots:** noraebang readiness (K8); the Flushing items (K9: the commission report, WeChat Pay, and bottle keep only after the lawyer approves it); stored value, loyalty and campaigns; and events and ticketing (K18). K19 to K21 come later.
