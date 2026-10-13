# F · Every feature switchable, emailed bookings and the room QR slip

Oct 13, 2026 · the tickets for [D124](../decisions.md): the founder's decisions of Oct 13. Every texting path can be switched off (emails never), every feature a venue might not run is a switch the owner sets in Set up your venue and changes in Admin → Features, approvals become a venue choice, every booking is emailed to the guest, and a room's join QR is printed every time the room starts.

**Goal (usable when done):** an owner opens Set up your venue, starts a plan, and in **Choose your features** ticks what the venue runs (rooms, bar tabs, deposits, Pay my share, cash discount, texting and each text, how approvals are decided, and the rest); Admin → Features changes any of it later; a switched-off feature disappears from the screens and is refused by the server. A guest who books online gets an email with the manage link, and again when the booking changes or is cancelled. Staff starting a room get a printed slip with the room's join QR, and can reprint it.

**Done when:**

- Admin → Features lists every switchable feature (modules and choices) with its needs and its "These turn off with it" confirm; the same list is part of step 2 in Set up your venue.
- The venue-wide Texting switch and every text's own switch work on the server; with texting off nothing goes to Twilio except the STOP and HELP replies a connected number owes the carriers; codes go by email and the order-waiting alert by push.
- Approvals are decided on the manager's phone, by a manager's PIN at the register, or not at all (role permissions only), as the venue chooses; every comp, void and refund is still recorded and in the exceptions report.
- Every online booking is emailed to the guest (confirmed, changed, cancelled), with the manage link; the venue's booking inbox keeps its copy.
- A room start prints the join-QR slip on the receipt printer when Ordering from the room is on; **Reprint QR** on the room reprints the current code.
- Sing Sing's choices are in its venue guide and demo script.

**Depends on:** M1-13, M1-32, O-04, O-06, T-03. **Size:** 8 tickets (3 S, 5 M).

Definition of done: see CLAUDE.md.

## Tickets

### F-01 · Texting can be switched off, venue-wide and text by text

- **Status:** done
- **Size:** M
- **Depends on:** T-03
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Texting switch; [D124](../decisions.md)
- **Build:**
  - A new settings key `texting` (owner or manager, Admin): `{ on: boolean, staffCodes: boolean, orderWaiting: boolean, singerCode: boolean, staffReplies: boolean }`, every field `true` by default (a venue with no row keeps today's behaviour).
  - The server checks it before anything goes to Twilio:
    - `texting.on` false: no guest text (`queueText` and `queueOutbound` refuse with `texting_off`), no staff text (`textsLive` answers not live, so codes, PIN-reset links and invites go by email and the order-waiting alert by push), no singer code (staff confirm the singer at the bar), and no staff reply in Messages (`texting_off`). The `message.send` and `text.send` jobs check again when they run, so a text queued before the switch is dropped.
    - Each of the 14 template texts keeps its own on/off in `message_templates.on` (Admin → Texts).
    - `staffCodes` false: sign-in codes, PIN-reset links and invites go by email; a phone-only invite is refused as when texts aren't live.
    - `orderWaiting` false: the manager's order-waiting alert goes as a push.
    - `singerCode` false: the singer's phone code isn't texted; staff confirm the singer at the bar.
    - `staffReplies` false: Messages shows incoming texts but takes no reply (`texting_off`).
  - STOP and HELP: an incoming STOP is always recorded and confirmed, and HELP always answered, while a number is connected, whatever the switches say (the carriers' rule). Admin shows them on and locked: "Always on · carriers require it".
  - Admin → Texts: a **Texting** switch at the top, then every text the app sends (the 12 service texts, the 2 marketing texts, Staff sign-in and invite codes, Order waiting alert to the manager, Singer's phone code, Staff replies in Messages, and STOP and HELP replies, locked), each with its switch. With Texting off the list reads "Texting is off · nothing is texted" and the switches are disabled. Emails have no switch.
  - The booking-confirmed text now waits for the approved campaign like every other text (it passed only the allow list).
- **Acceptance:**
  - [x] With `texting.on` false, no text of any kind is queued or sent; codes and invites go by email; the order-waiting alert goes by push; STOP and HELP are still answered.
  - [x] Each of the four staff switches sends that text's fallback and leaves the others texting.
  - [x] A text queued before the switch went off is dropped by its job.
  - [x] Admin → Texts shows the switch and every text in English and Spanish, with STOP and HELP locked.
  - [x] Only an owner or manager saves `texting`; the route is in the principal and venue-wall suites.
- **Notes:**
  - Built: the `texting` key (`packages/shared/src/settings.ts`, default all on, so a venue that never saved it texts as before; `latestSetting` reads the newest version since the switch is live at once). `apps/api/src/texts/texting.ts` (`textingAllows`) is asked by `textsLive` (with a kind: `staffCodes`, `orderWaiting`, `singerCode`), by `guardSend` (every guest text, `texting_off`), by `sendReply` (`staffReplies`) and again by the `message.send` and `text.send` jobs, which drop a text queued before the switch went off. The singer's code carries `for: "singer"` so its job asks its own switch. Migration 0150 adds `messages.carrier_reply`, set on STOP's confirmation and HELP's answer, the only texts that go while texting is off (HELP now also ignores the Guest texts module, the carriers' rule). Admin → Texts shows `TextingSwitches.tsx` above the 14 templates; Messages hides the reply box with "Staff replies are off · Admin → Texts" (`replies_on` on the thread).
  - Tests: `apps/api/src/texts/texting.int.test.ts`; the Admin → Texts e2e test. `PUT /settings/texting` is the existing settings route, already in the principal and wall suites.
  - Fixed on the way: the booking-confirmed text now passes `requireApprovedCampaign` like every other text.
  - Cautious default: with texting off, STOP is still recorded and confirmed and HELP answered while a number is connected; disconnecting Twilio is the way to stop those too.

### F-02 · The order-waiting alert says how the manager was told

- **Status:** todo
- **Size:** S
- **Depends on:** F-01
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md); [D124](../decisions.md)
- **Build:**
  - `orders.manager_told` (`text` or `push`, null until level 4): written by the escalation when the level-4 alert goes, from what was actually sent.
  - The board's alert reads "texted Andy" only when the text went; "sent to Andy's phone" when it went as a push.
- **Acceptance:**
  - [ ] With texts not live (or the order-waiting text off), level 4 records `push` and the board reads "sent to Andy's phone".
  - [ ] With texts live, it records `text` and reads "texted Andy".
- **Notes:**

### F-03 · New switches: deposits, room tablets, the card behind the bar, Pay my share, cash discount and the ticket choice

- **Status:** todo
- **Size:** M
- **Depends on:** M1-32, O-04
- **Spec:** [Settings](../spec/03-settings-rule-packs-modules.md) · Modules; [D124](../decisions.md)
- **Build:**
  - Five new modules in `venue_modules` (no migration for the id; a backfill migration for venues that exist):
    - **Deposits on bookings** (`deposits`, needs Online booking): off, online bookings take no deposit or card hold and staff can't send a deposit payment link; existing deposits are still refunded and shown. "Online booking & deposits" is renamed **Online booking**.
    - **Room tablets** (`room_tablets`, needs Rooms & room clock): off, a room tablet shows "Room tablets are off" and its routes answer `module_off`; pairing a tablet is refused. Ordering from a tablet needs both Room tablets and Ordering from the room.
    - **Keep the card behind the bar for walk-ins** (`card_behind_bar`, needs Rooms & room clock): off, the walk-in choice "Keep the card behind the bar" can't be saved or used at check-in; turning it off is refused while it's the walk-in choice ("Pick another walk-in choice first") or while a held card hasn't been given back.
    - **Pay my share** (`pay_share`, needs Rooms & room clock): the module is the switch (`pay.payShare.on` is no longer read; Admin → Payments shows the module's state with a link).
    - **Cash discount** (`cash_discount`): off, no discount is taken whatever `pay.cardFee` says, and Admin → Payments shows "Cash discount is off · Admin → Features"; the rate is kept for when it's on.
  - The plans (D121): Bar adds Cash discount; Rooms adds Deposits on bookings, Room tablets, Keep the card behind the bar and Pay my share. A plan switches them on as it does its other modules; the backfill copies today's settings (Pay my share and the cash discount from `pay`, the rest on where Rooms is on).
  - Admin → Features gets a second part, **Choices**: **Drinks rung at the bar print a ticket** (`pos.printBarDrinkTickets`, the same switch as Admin → Bar POS), **Texting** (`texting.on`, F-01) and **Approvals** (F-04). Each writes its own settings key.
- **Acceptance:**
  - [ ] Each new module's routes and rules are refused on the server while it's off, and its screens hide it.
  - [ ] The needs and "These turn off with it" confirms cover the new modules (turning off Rooms lists them; turning off Online booking lists Deposits on bookings).
  - [ ] Turning off Keep the card behind the bar is refused while it's the walk-in choice.
  - [ ] The plans switch the new modules on; the backfill matches today's behaviour for West 4.
  - [ ] Admin → Features shows the modules and the Choices in English and Spanish.
- **Notes:**

### F-04 · Approvals: on the manager's phone, by PIN at the register, or none

- **Status:** todo
- **Size:** M
- **Depends on:** F-03
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Approvals; [D124](../decisions.md)
- **Build:**
  - A settings key `approvals` `{ mode: "phone" | "pin" | "none" }`, default `phone`, owner only. Admin → Features → Choices shows the three: **On the manager's phone** (today), **Manager's PIN at the register**, **No approval (role permissions only)**.
  - `approvals.decided_with` (`phone`, `pin` or `none`); the table's checks keep "never the requester" for phone and PIN, and let a `none` row name the requester.
  - `pin`: a request is made and routed as today (no push to the phone); the requester's waiting strip offers **Manager's PIN**: a manager or owner (never the requester) picks their name and types their PIN on the same register, and approves or declines. `POST /approvals/{id}/pin` checks the PIN with the sign-in lockouts. The phone still decides it too.
  - `none`: the action runs at once if the person's role allows it; an approval row is still written as approved (`decided_with: none`), so the exceptions report and the audit log list it.
  - The changed rule replaces CLAUDE.md's "Approvals are decided on the approver's own phone" with a venue setting; the founder edits CLAUDE.md.
- **Acceptance:**
  - [ ] `phone` behaves exactly as today.
  - [ ] `pin`: a manager's PIN on the requesting register decides it; the requester's own PIN, a wrong PIN or a staff member's PIN is refused; lockouts apply.
  - [ ] `none`: a comp over the limit runs at once, with a row in approvals and the exceptions report.
  - [ ] The new route is in the principal and venue-wall suites; EN and ES strings.
- **Notes:**

### F-05 · Choose your features in Set up your venue

- **Status:** todo
- **Size:** S
- **Depends on:** F-03, F-04
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 2; [D124](../decisions.md)
- **Build:**
  - Step 2, once the plan is active, shows **Choose your features**: Admin → Features' own list (modules in the plan and the Choices), saved through the same routes. Its summary line counts what's on.
  - Finish setup keeps its guest-facing ticks.
- **Acceptance:**
  - [ ] An owner switches features on and off in step 2 and Admin → Features shows the same.
  - [ ] EN and ES; the onboarding e2e test covers it.
- **Notes:**

### F-06 · Every booking is emailed to the guest

- **Status:** todo
- **Size:** M
- **Depends on:** M5 bookings, M1-18
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Booking emails; [D124](../decisions.md)
- **Build:**
  - A new email template `booking_guest` (`confirmed`, `changed`, `cancelled`), in the guest's booking language: the venue, date, time, room hours, party, deposit and its refund terms, the manage link (`/b/{token}`), and the venue's phone. No card data.
  - Sent when a booking is confirmed (online or a deposit paid by link), changed on the manage page or by staff, and cancelled by the guest or the venue; whenever the booking has an email. Texts are unchanged and still follow their switches.
  - The online booking form already requires an email; its line reads "We email your confirmation and text your reminders" (texts only when texting is on).
- **Acceptance:**
  - [ ] Confirm, change and cancel each send one email to the guest with a working manage link; the booking inbox copy still goes.
  - [ ] With texting off the email still goes.
- **Notes:**

### F-07 · The room's join QR is printed when a room starts, and reprinted on demand

- **Status:** todo
- **Size:** M
- **Depends on:** M3-08, M3-13
- **Spec:** [Devices and printing](../spec/09-devices-printing-offline.md); [screens](../screens.md) N3; [D124](../decisions.md)
- **Build:**
  - Print kind `room_qr`: on check-in and a seated walk-in, while Ordering from the room is on, a slip goes to the front desk's receipt printer: the venue, the room, the host's name, a QR of the join link with the room code (`/v/{slug}/room/{roomId}?code=…`), the code in large letters and "Scan to order and see your bill" in the venue's language (English or Spanish).
  - The ESC/POS renderer prints the QR with the printer's own QR command (GS ( k); Star and Epson cloud printers get their own QR markup.
  - **Reprint QR** on the room (DeskRoom, the bar POS's rooms list, the staff phone room): `POST /sessions/{s}/qr-slip` prints the current code again (the new one after a change); audited.
  - The join page fills the code from the link and joins with one tap.
- **Acceptance:**
  - [ ] A check-in and a walk-in each queue one `room_qr` job; none while Ordering from the room is off.
  - [ ] Reprint QR prints the current code; after the code changes it prints the new one.
  - [ ] The ESC/POS bytes carry the QR command with the join link; the join page joins from the link.
  - [ ] The route is in the principal and venue-wall suites; EN and ES.
- **Notes:**

### F-08 · Sing Sing's feature choices

- **Status:** todo
- **Size:** S
- **Depends on:** F-03, F-05
- **Spec:** [Sing Sing venue](../venues/sing-sing/venue.md); [D124](../decisions.md)
- **Build:**
  - `docs/venues/sing-sing/venue.md`: the Choose your features rows: on (Rooms, Bar tabs, Bar screen & tickets, Kitchen & food, Website, Online booking, Ordering from the room, Keep the card behind the bar, Cash discount), off (Deposits on bookings, Bar mode, Song system control, Marketing texts), and the rest left at the module defaults as Still to give.
  - `scripts/demo-sing-sing.mjs` sets the same.
- **Acceptance:**
  - [ ] The demo script leaves Sing Sing with exactly those choices.
- **Notes:**
