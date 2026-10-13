# F · Every feature switchable, emailed bookings and the room QR slip

Oct 13, 2026 · the tickets for [D124](../decisions.md): the founder's decisions of Oct 13. Every texting path can be switched off (emails never), every feature a venue might not run is a switch the owner sets in Set up your venue and changes in Admin → Features, approvals become a venue choice, every booking is emailed to the guest, and a room's join QR is printed every time the room starts.

**Goal (usable when done):** an owner opens Set up your venue, starts a plan, and in **Choose your features** ticks what the venue runs (rooms, bar tabs, deposits, Pay my share, cash discount, texting and each text, how approvals are decided, and the rest); Admin → Features changes any of it later; a switched-off feature disappears from the screens and is refused by the server. A guest who books online gets an email with the manage link, and again when the booking changes or is cancelled. Staff starting a room get a printed slip with the room's join QR, and can reprint it.

**Done when:**

- Admin → Features lists every switchable feature (modules and choices) with its needs and its "These turn off with it" confirm; the same list is part of step 2 in Set up your venue.
- The venue-wide Texting switch and every text's own switch work on the server; with texting off nothing goes to Twilio except the STOP and HELP replies a connected number owes the carriers; codes go by email and the order-waiting alert by push.
- Approvals are decided on the manager's phone, by a manager's PIN at the register, or not at all (role permissions only), as the venue chooses; every comp, void and refund is still recorded and in the exceptions report.
- Every online booking is emailed to the guest (confirmed, changed, cancelled), with the manage link; the venue's booking inbox keeps its copy.
- A room start prints the join-QR slip on the receipt printer when Ordering from the room is on; **Reprint QR** on the room reprints the current code.
- Sing Sing's choices are in its venue guide and demo script, and it can run on its bar computers alone.
- A venue can take cards on its own outside card machine and record them, beside Stripe's readers.

**Always on (the founder's correction, Oct 13):** what a POS needs to work is never a switch: Reports & accounting, Bar tabs & quick sale (the register: ringing sales and tabs), the menu, taking payments (cash and card) and receipts, Close the night and the Z report, team, roles and PINs, moving a bar tab into a room, training mode, offline mode and emails.

**Depends on:** M1-13, M1-32, O-04, O-06, T-03. **Size:** 10 tickets (3 S, 7 M).

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

- **Status:** done
- **Size:** S
- **Depends on:** F-01
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md); [D124](../decisions.md)
- **Build:**
  - `orders.manager_told` (`text` or `push`, null until level 4): written by the escalation when the level-4 alert goes, from what was actually sent.
  - The board's alert reads "texted Andy" only when the text went; "sent to Andy's phone" when it went as a push.
- **Acceptance:**
  - [x] With texts not live (or the order-waiting text off), level 4 records `push` and the board reads "sent to Andy's phone".
  - [x] With texts live, it records `text` and reads "texted Andy".
- **Notes:**
  - Built: migration 0151 adds `orders.manager_told` (`text` or `push`), written by `escalateOrders` from what it actually sent at level 4; the board's alert (`rooms/board.ts`) reads `texted`, `pushed` ("sent to Andy's phone") or `phone` (level 3, or level 4 with no verified phone, when only the level-3 push went). Test: `orders/escalation.int.test.ts` (the order-waiting text switched off, so the last level goes as a push).

### F-03 · New switches: deposits, room tablets, the card behind the bar, Pay my share, cash discount and the ticket choice

- **Status:** done
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
  - **Made permanent (D124's correction):** Reports & accounting and Bar tabs & quick sale become core modules, always on, never listed as switches (a venue row in `off` reads as on; the backfill sets them on). The go-live merchant category check stays a requirement before Ready to open (it no longer holds the module off). Team, roles and PINs were never behind a module; Team, time clock & tips switches only the time clock and the tip pool.
  - Admin → Features gets a second part, **Choices**: **Drinks rung at the bar print a ticket** (`pos.printBarDrinkTickets`, the same switch as Admin → Bar POS), **Texting** (`texting.on`, F-01) and **Approvals** (F-04). Each writes its own settings key.
- **Acceptance:**
  - [x] Each new module's routes and rules are refused on the server while it's off, and its screens hide it.
  - [x] The needs and "These turn off with it" confirms cover the new modules (turning off Rooms lists them; turning off Online booking lists Deposits on bookings).
  - [x] Turning off Keep the card behind the bar is refused while it's the walk-in choice.
  - [x] The plans switch the new modules on; the backfill matches today's behaviour for West 4.
  - [x] Admin → Features shows the modules and the Choices in English and Spanish; Reports & accounting and Bar tabs & quick sale aren't switches.
- **Notes:**
  - Built: five modules in `packages/shared/src/modules.ts` (`deposits`, `room_tablets`, `card_behind_bar`, `pay_share`, `cash_discount`) with names and "what it hides" in both catalogs, and `bar_tabs` and `reports` made core. A new module **inherits** the row of the module it came from until it has its own (`venueModules`: deposits from Online booking, the room ones from Rooms, Cash discount from Payments), so no backfill migration was needed and West 4 (and the founder's demo) keep working as before; `setModuleState` and `setModuleAllowed` keep the inherited values on a first row.
  - Server: `bookings/deposit-rule.ts` (`bookingDepositRule`) gives new online and staff bookings `on: false` while Deposits on bookings is off (a booking that already took a deposit keeps its terms; its payment link still works); room tablets' own routes answer `module_off` (`room_tablets_off`) in `http/conventions.ts`, and pairing a tablet is refused; taking a card behind the bar is its module's route, and `openWorkChecks.card_behind_bar` refuses "off" while it's the walk-in choice or a card is held; saving `deposit.walkIn = cardBehindBar` is refused while it's off; `payShareOn` reads the module; `cashDiscountFor` answers null while Cash discount is off (the rate is kept).
  - Screens: Admin → Features lists the new modules and a **Choices** part (`FeatureChoices.tsx`: drink tickets and Texting); Admin → Payments shows Pay my share's state with a link instead of its old checkbox, and says when the cash discount is off; Admin → Deposits & cancelling says when Deposits on bookings is off and shows the walk-in "card behind the bar" choice only while it's on (or chosen); the room tablet reads "Room tablets are off". Step 7 no longer asks the Pay my share question (`pay.payShare` stays in the schema, unread).
  - Cautious default: the go-live merchant category no longer holds Bar tabs off (it's always on); it stays a requirement before Ready to open. Spec 03 and D124 say so.
  - Tests: `routes/modules.int.test.ts` (D124 block), `pay-my-share`, `go-live`, `reports`, `plan-checkout` and the wall suite (bodies for the tab routes, which now reach their lookups); unit `modules.test.ts`, `navigation.test.ts`; e2e Admin → Features, Card fee, Pay my share, Set up your venue.

### F-04 · Approvals: on the manager's phone, by PIN at the register, or none

- **Status:** done
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
  - [x] `phone` behaves exactly as today.
  - [x] `pin`: a manager's PIN on the requesting register decides it; the requester's own PIN, a wrong PIN or a staff member's PIN is refused; lockouts apply.
  - [x] `none`: a comp over the limit runs at once, with a row in approvals and the exceptions report.
  - [x] The new route is in the principal and venue-wall suites; EN and ES strings.
- **Notes:**
  - Built: the owner-only `approvals` key (`{ mode }`, default `phone`; `settings.ts` refuses it from anyone but the owner); migration 0152 adds `approvals.decided_with` and relaxes the three "never the requester / never the same device" checks only for `pin` (same register) and `none` (the requester's own row). `approvals/service.ts`: `approvalsMode`; with `pin` a request is routed as before with no push; with `none` the row is written and its executor runs just before the transaction commits (`beforeCommit` in `packages/db/src/tenancy.ts`, so the code that asked has written its own rows first: a refund's, a tip's), recorded approved with `decided_with = none`. `decide()` takes `via: "pin"`, which lets any owner or manager but the requester decide on the register that asked. Route `POST /approvals/{id}/pin` checks the PIN with `checkPinOf` (the sign-in lockouts on that device); `GET /approvals` now says the venue's mode and who may type a PIN.
  - Screens: the waiting strip offers **Manager's PIN** (`approvals/PinApproval.tsx`: pick who, their PIN, Approve or Decline) and names who decided; Admin → Features → Choices has the three choices, read-only for a manager.
  - With `none`, a refund or a card-on-file charge goes to Stripe from the worker's job (the executor already queues it), a few seconds later than the phone path's immediate run.
  - Tests: `approvals/modes.int.test.ts` (all three modes, wrong PIN, the requester's own PIN, a staff PIN, owner-only); the principal and wall suites pick up the new route; the Features e2e test switches the choice and back.

### F-05 · Choose your features in Set up your venue

- **Status:** done
- **Size:** S
- **Depends on:** F-03, F-04
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 2; [D124](../decisions.md)
- **Build:**
  - Step 2, once the plan is active, shows **Choose your features**: Admin → Features' own list (modules in the plan and the Choices), saved through the same routes. Its summary line counts what's on.
  - Finish setup keeps its guest-facing ticks.
- **Acceptance:**
  - [x] An owner switches features on and off in step 2 and Admin → Features shows the same.
  - [x] EN and ES; the onboarding e2e test covers it.
- **Notes:**
  - Built: once the plan is active, step 2 (`PlanStep.tsx`) shows **Choose your features**: Admin → Features' own component (`Features embedded`), the modules within the plan and the Choices, each saved as it's switched; its count line reads "N features on". The plans' cards name the always-on register and the new switches.
  - A venue in setup may not have its `pos` key yet, so the drink-ticket choice says it's set in Admin → Bar POS once that's saved; Texting and Approvals work from the start.
  - Step 7 no longer asks about Pay my share (F-03); the onboarding e2e test lost that line and gained the Choose your features checks (turning Deposits on bookings off).

### F-06 · Every booking is emailed to the guest

- **Status:** done
- **Size:** M
- **Depends on:** M5 bookings, M1-18
- **Spec:** [Song systems and texts](../spec/11-song-systems-texts.md) · Booking emails; [D124](../decisions.md)
- **Build:**
  - A new email template `booking_guest` (`confirmed`, `changed`, `cancelled`), in the guest's booking language: the venue, date, time, room hours, party, deposit and its refund terms, the manage link (`/b/{token}`), and the venue's phone. No card data.
  - Sent when a booking is confirmed (online or a deposit paid by link), changed on the manage page or by staff, and cancelled by the guest or the venue; whenever the booking has an email. Texts are unchanged and still follow their switches.
  - The online booking form already requires an email; its line reads "We email your confirmation and text your reminders" (texts only when texting is on).
- **Acceptance:**
  - [x] Confirm, change and cancel each send one email to the guest with a working manage link; the booking inbox copy still goes.
  - [x] With texting off the email still goes.
- **Notes:**
  - Built: `bookings/guest-email.ts` (job `booking.guestEmail`, once per confirmation and cancellation, once per moment for a change) and the email template `booking_guest` (`email/templates.ts`, EN and ES from the guest's own language): the venue, when, room time, guests, the deposit paid, "Free to cancel until …" while it still is, its own manage link (`booking_links.purpose = 'email'`, migration 0153, so the confirmation text's "sent once" check isn't fooled) and the venue's phone; never card data. Queued from `settleDeposit` (online and payment-link bookings), a staff booking confirmed at once, `changeBooking`, `guestCancels` and `venueCancels`. No email means none is sent; texting's switches don't touch it.
  - The booking form already required an email; its line now reads "We email your confirmation and text your reminders to this number." The confirmed page and the payment page say the confirmation was emailed (they no longer promise a text, which may be switched off).
  - Tests: `bookings/guest-email.int.test.ts` (confirmed through `settleDeposit` with texting off, the link opens the booking, once only; changed and cancelled in Spanish; no email, nothing; the rendered copy), the job wall suite (a case for the new job), and the booking e2e tests' new wording.

### F-07 · The room's join QR is printed when a room starts, and reprinted on demand

- **Status:** done
- **Size:** M
- **Depends on:** M3-08, M3-13
- **Spec:** [Devices and printing](../spec/09-devices-printing-offline.md); [screens](../screens.md) N3; [D124](../decisions.md)
- **Build:**
  - Print kind `room_qr`: on check-in and a seated walk-in, while Ordering from the room is on, a slip goes to the front desk's receipt printer: the venue, the room, the host's name, a QR of the join link with the room code (`/v/{slug}/room/{roomId}?code=…`), the code in large letters and "Scan to order and see your bill" in the venue's language (English or Spanish).
  - The ESC/POS renderer prints the QR with the printer's own QR command (GS ( k); Star and Epson cloud printers get their own QR markup.
  - **Reprint QR** on the room (DeskRoom, the bar POS's rooms list, the staff phone room): `POST /sessions/{s}/qr-slip` prints the current code again (the new one after a change); audited.
  - **The host's email (the founder, Oct 13):** when the host's email is known (their booking's, or typed in the walk-in dialog, which gains an optional email field), the room start also emails the host the room's QR code and join link, "Scan to order and see your bill", in English or Spanish, beside the slip and the Room code text. Emails aren't switchable, so it goes whenever there's an email and Ordering from the room is on. Reprint QR, and a code change, offer **Email it again**.
  - The join page fills the code from the link and joins with one tap.
- **Acceptance:**
  - [x] A check-in and a walk-in each queue one `room_qr` job; none while Ordering from the room is off.
  - [x] Reprint QR prints the current code; after the code changes it prints the new one.
  - [x] The ESC/POS bytes carry the QR command with the join link; the join page joins from the link.
  - [x] The host's email gets the QR and link at the room start, and again on Email it again; the walk-in dialog takes an optional email.
  - [x] The route is in the principal and venue-wall suites; EN and ES.
- **Notes:**
  - Built: print kind `room_qr` (migration 0154) with `print/room-qr.ts`: ESC/POS with the printer's own QR command (`GS ( k`, model 2, module 6, level M) on a USB printer, `<symbol type="qrcode_model_2">` in Epson's ePOS-Print XML, and plain text with the link spelled out on Star's CloudPRNT (cautious default: Star's QR markup isn't used until it's tried on a real Star printer). `rooms/room-qr.ts` prints the slip at every check-in and seated walk-in (front desk station, the room's current code from its sealed copy, "Scan to order and see your bill" in each of the venue's staff languages) and emails the host (template `room_qr`, the QR as an inline GIF made by `qrcode-generator`, in the host's language) when an email is known; both only while Ordering from the room is on, and neither ever blocks seating. `POST /sessions/{s}/qr` (`{ print?, email? }`) is Reprint QR and Email it again; every slip is a `print_jobs` row, with `reprint_n` counting the reprints.
  - Screens: the walk-in dialog takes an optional **Host's email**; **Reprint QR** and **Email it again** on the room screen (DeskRoom and the staff phone) and on the bar POS's room header; the join page fills the code from the link's `?code=`.
  - There's no staff "change code" button today: a code changes on ten wrong codes, a move or the host lock, and Reprint QR then prints the new one.
  - Tests: `print/room-qr.test.ts` (the QR bytes, the Epson symbol, the GIF), `rooms/room-qr.int.test.ts` (walk-in slip and email, reprint, the new code after a change, off when Ordering from the room is off), the principal and wall suites; e2e: the check-in sheet test (email, slip, Reprint QR) and the guest join from the link.

### F-08 · Sing Sing's feature choices

- **Status:** todo
- **Size:** S
- **Depends on:** F-03, F-05
- **Spec:** [Sing Sing venue](../venues/sing-sing/venue.md); [D124](../decisions.md)
- **Build:**
  - `docs/venues/sing-sing/venue.md`: the Choose your features rows: on (Rooms, Bar screen & tickets, Kitchen & food, Website, Online booking, Ordering from the room, Keep the card behind the bar, Cash discount), off (Deposits on bookings, Bar mode, Song system control, Marketing texts, Room tablets), Approvals "Manager's PIN at the register", and the rest left at the module defaults as Still to give. (Bar tabs are always on.)
  - The kitchen's allergy notice, the venue's own wording ([D125](../decisions.md)): "Allergen information for menu items is available. Ask an employee for details." and our Spanish for the venue to confirm. Kitchen & food no longer waits on the lawyer.
  - The cash discount is the owner's choice (D125): Sing Sing's is on; the "stays off until the lawyer answers" default goes.
  - `scripts/demo-sing-sing.mjs` sets the same, with the allergy notice in place of the DEMO ONLY one.
- **Acceptance:**
  - [ ] The demo script leaves Sing Sing with exactly those choices.
- **Notes:**

### F-09 · Sing Sing on its bar computers alone

- **Status:** todo
- **Size:** M
- **Depends on:** F-04, F-08
- **Spec:** [Devices and printing](../spec/09-devices-printing-offline.md); [D126](../decisions.md)
- **Build:**
  - A venue can run on its bar computers alone (the desktop app), with no staff phones, room tablets, badge readers or Up next TV, as Sing Sing does today; each stays available to turn on later.
  - Nothing requires a staff phone: approvals (by Manager's PIN at the register, F-04), the order-waiting alert (the bar computer's alarm and banner; with no phone paired the push has nowhere to go and the board says so), the time clock, Close the night, Send to kitchen, tip entry and the incident log each work on the desktop or bar POS; any job only a phone screen does is listed in Notes as a gap.
  - Sing Sing's set in `docs/venues/sing-sing/venue.md`, `scripts/demo-sing-sing.mjs`, `docs/runbooks/hardware-install.md` and `devices:check`: bar computers with the desktop app, a receipt printer and drawer on each, a kitchen network printer, card readers as F-10 allows (none required while the outside card machine is on); no tablets, badge readers or Up next TV, so `devices:check` doesn't ask for them.
- **Acceptance:**
  - [ ] `devices:check` passes Sing Sing's set without phones, tablets, badge readers or a TV.
  - [ ] Each job above is done on the desktop in a test, or named as a gap in Notes.
- **Notes:**

### F-10 · Paid on an outside card machine

- **Status:** todo
- **Size:** M
- **Depends on:** F-03
- **Spec:** [Payment flows](../spec/07-payment-flows.md) · Outside card machine; [D126](../decisions.md)
- **Build:**
  - A new owner-switchable payment option, **Paid on outside card machine** (module `outside_card`, off by default, every plan), in Set up your venue's step 7 and Admin → Features; Stripe's readers stay as they are, and both can be on.
  - Staff charge the card on the venue's own non-Stripe machine, then record it on the check: the amount and the tip (integer cents, entered by staff) and an optional note (last 4 digits and the approval code only: a 13-to-19-digit number is refused, so no full card number reaches our servers). It closes the tab or the room's bill like any tender; no hold, no on-reader tip and no reconciler.
  - Refunds are recorded the same way ("Refunded on outside machine"), approved per the venue's approval setting.
  - Close the night shows an **Outside card machine** total, by drawer and by person, for the manager to match against the machine's own batch report; the Z report, reports, exports and the money audit carry it. A split hands leftover cents out by largest remainder.
  - Audited.
- **Acceptance:**
  - [ ] Recording a payment closes the check with the tip; a full card number in the note is refused.
  - [ ] Close the night, the Z report, the exports and the money audit show the outside-machine total, matching to the cent.
  - [ ] A refund is recorded and approved per the setting.
  - [ ] The module is refused on the server while off; EN and ES.
- **Notes:**
