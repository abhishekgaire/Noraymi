# Flow review of the West 4 design canvas

Reviewed Sep 28, 2026, against spec rev 182 and blueprint rev 68. I walked all 27 canvas screens in the live preview, clicking through them with Playwright, and read each file's source where state is hidden. My scripts, text dumps and screenshots are in `review/flows_work/` (see the appendix). No file under `w4/` was changed.

**How to read the severity.** I applied the brief's definitions as follows:

- **Blocker:** the journey can't be finished on the canvas, because a required step has no screen or a control does nothing. Also a Blocker: following the screen as drawn takes the wrong amount of money or skips a required approval.
- **Major:** a real venue would hit it on a normal Friday.
- **Minor:** polish, wording or demo data.

Line numbers point at the `.dc.html` source.

**Demo "now"** is Fri Sep 25, 2026, 10:41 PM. F40 lists the screens that disagree with it.

**Totals:** 55 findings. 12 are Blockers, 27 are Major and 16 are Minor.

---

## 1. Room orders: the status a guest, a bartender and a runner each see

The brief asked for special attention to whether "made", "ready for a runner", "on its way" and "delivered" are consistent. They are not. Each of the four screens has its own vocabulary, and no screen hands an order from the bar to a runner. See F1 and F2.

| Stage (spec `orders.status`) | Bar orders screen (Bar.dc.html) | Bar POS header (Rail.dc.html) | Staff phone, Runs (Staff.dc.html) | Guest phone (Order.dc.html) |
|---|---|---|---|---|
| ringing | "Waiting for you": Accept · print ticket | Card with age: Accept | not shown | "Received · ringing at the bar · you can still cancel" |
| held | Goes into "Making" as "Maya · held". It is never accepted and prints no ticket (F2). | No Hold button | not shown | No state |
| accepted | "Making" | The card disappears. The toast says "on the room's tab", but the Room 9 tab stays at $480. | not shown | "Bar accepted · on your tab · ticket printed, being made" |
| made, ready for a runner (spec `sent`?) | **No state.** The only button, "Sent to room", jumps straight to "Delivered tonight". | **No state** | "4:00 since made · Made by Maya": I've got it | No state |
| on its way (spec `claimed_by`) | The footer says the guest sees "On its way" when the bar taps | none | "You're taking it" (toast: "on its way · their screen says so") | "On its way · coming up to Room 9" |
| delivered | "Delivered tonight", set by the bar | none | "Delivered · on the room's tab" (this implies the charge happens at delivery) | "Delivered", after which the order is hidden |
| returned | No list | No list | "Brought back … The bar counts it as made, and Andy decides the rest" | No state |
| cancelled or declined after 4 AM | No state | "Decline" after 4 AM | none | Cancel only before the bar takes it |

The demo data also contradicts itself. The bar orders screen shows Room 3's margaritas as still in "Making", while Runs shows them "made 4:00 ago".

---

## 2. Journeys, step by step

### J1 · Online booking → deposit → confirmation → change or cancel
1. **Main → "Book a room" → Book section.** "Tonight" means the device's real date (Mon Sep 28), not the demo Friday (F40).
2. **"Pick a date" → Fri Oct 2.** The "−" button stops at 4 guests, so a party of 3 can't be entered (F32). I chose 2 hr at 9:30 PM. The receipt shows $80 room time, $7.10 tax, $16.00 gratuity, $103.10 in total and a $40.00 deposit.
3. **"Pay $40.00 deposit" and "Google Pay · or type a card".** Neither button does anything. The page never asks for a name, mobile number or email, and never shows the card-on-file terms. There is no confirmation screen. **Stuck (F5).**
4. **Manage (reached directly; nothing links to it).** Change party size 7→9: "pay $20.00" → "$20.00 more charged". Down to 4 with "Demo: in 5 hours": deposit kept, and it says so. Cancel: full refund or deposit kept, both clear. Change time works. **OK.** It can't move the booking to another date (F52).
5. **Disagreements.** Manage's Jae & co. (7 guests, 10:00 PM, $70) doesn't match the phone (8 guests, 9:00 PM, Room 6, $80) or the Board (booked 10:45 in Room 3) (F33). DeskCalendar's big-party link double-books the VIP room (F34).

### J2 · Walk-in: waitlist QR → quote → "room ready" text → seated
1. **Waitlist (guest).** Name, party of 4 (minimum on Friday; 3 is refused), phone → Join → "3rd in line, ~20 min". **OK.** "Ahead of you: 2 parties" doesn't match the 3 waiting on the Board and staff phone (F43).
2. **"Demo: your room is ready"** → "Room 4, 10:00 to claim it". Room 4 is off tonight on the Board, the staff phone and Night (F4, F43).
3. **Staff phone → Waitlist → "Text: room ready"** texts Leo "your room is ready" without choosing a room, holding one or starting a countdown. "+ Add a walk-in" does nothing. **Stuck (F4).**
4. **Board.** "Waitlist · 3" and "+ Walk-in" do nothing. Alert a6's "Text" only selects Room 11, and "Seat a walk-in here" does nothing. No screen seats a waitlist party. **Stuck (F4).**
5. **Logic.** Alert a2 asks Room 7 to wrap up because "no other 6–12 room is free", while Room 11 (fits 12–20) is free all night (F22).

### J3 · Check-in → room code → guest orders → bar → runner → delivered
1. **Check-in on the Board.** There is no check-in control. Room 2 (next: Sam O. at 10:30) offers only "Seat a walk-in here", which does nothing. **Stuck (F3).**
2. **Check-in on the staff phone.** Tapping "Check in" on Sam O. is one tap: no ID count, no party-size check (Sam booked 3 on a 4-minimum night), no room code and no clock start (F3).
3. **Guest joins (Order).** No join or code screen exists; Order opens already inside Room 9 (F27).
4. **Order → Beer → Send 1 to the bar.** Received, then Bar accepted after 5 s, On its way after 10 s, Delivered after 20 s, all automatic. "Call staff" says "Room 9 lights up on the bar screen", but no bar screen shows calls (F26).
5. **Bar orders screen.** Accept prints the Room 9 ticket, "accepted by Maya · $26.00 · Nothing charged now". The order moves to "Making", then "Sent to room" puts it straight into "Delivered tonight" (F1). "Hold · text the room" on Room 5 puts the order into Making as "Maya · held", with "Sent to room" still available (F2). The screen has no way back to the app (F35).
6. **Bar POS header.** Accept removes the card, but Room 9's tab stays at $480. There is no Hold, Ready or Delivered step (F1).
7. **Staff → Runs.** I've got it → Delivered → "on the room's tab". Couldn't serve → "Someone looks too drunk" → "Back to the bar · Maya and Andy see why". No bar screen or guest screen shows the return (F1, F20).
8. **Disagreements.** Room 5 is "Kenji W. · party of 5 · ID 4 of 5" on the bar orders screen, "ID 4 of 4" on the bar POS, and "Leo M. · 4" on the Board (F33, F44). The escalation copy doesn't match the spec (F36).

### J4 · A room running long with a party waiting
1. **Room (phone) → "Demo: party waiting"** → "19 min left · a party is waiting" → "Text: please wrap up by 11:00". The Order screen's "Demo: a party is booked after us" shows the guest's wrap-up message. **OK.**
2. **Board, Room 7 (+9 min, a party of 7 waiting)** → "Text: please wrap up" adds a note. If they don't leave, there's no next step: no move and no escalation (F22).
3. **Room move.** The Board and DeskRoom have none. The staff phone's "Move to Room 5" would put Marcus's 12 guests into a room that fits 3–6, and Room 5 is occupied on the Board and bar screens. No new room code is issued and the guests' phones aren't told (F22).
4. **Staying by the minute.** "Text: stay as long as you like" works on the Board, DeskRoom and Room. The staff phone's "Let them stay" appears even for guests who haven't arrived (F48).
5. **Cleaning.** Close-out → "Room 9 goes to cleaning". On the Board, Room 6 "Needs a wipe" → "Clean · open it up" works. The alert says the rooms have waited "8 min" while the tiles say "Left 9:12 PM" (F49). Party size can't be changed mid-session (F23).

### J5 · Room close-out (desktop and phone)
1. **DeskRoom, Room 9.** Room time 161 min × $2.00 = $322.00, drinks $158, tax $42.60, gratuity $96.00, total $618.60, deposit −$120, left to pay $498.60. This matches the spec's worked example. **OK.**
2. **Tap card** → "Send $498.60 to the front desk reader" → "Paid." at once. There is no waiting state, decline or "status unknown" (F14).
3. **Card on file** → "Ask Marcus to confirm" → "Paid. Marcus confirmed on his phone." No guest screen exists for that confirmation (F15).
4. **Cash** → "Paid in cash · $514.07" (after adding a drink). Nothing records the cash handed over, the change or a cash tip (F16). The ringing 2 × Margarita is still "at the bar and not in this total", and the room goes to cleaning anyway (F13).
5. **Split** 2 ways, even or by item, card or cash per person, in cents that add up. **OK.** "Take 2 cards" then confirms both at once, with no per-card state (F14).
6. **Staff phone list → "Close out"** marks Priya "Done · Closed out, paid at the bar" with no payment (F7). The receipt is always texted (F47).

### J6 · Bar walk-up quick sale, cash then card
1. **Rail → Quick sale → Bud Light → "Pay $8.71" → $10** → "Paid in cash · Change $1.29 · drawer opened · Logged to Maya in the house drawer". "Wrong amount? Fix the change" works. **OK.** Admin puts the only drawer at the front desk (F17). The pay panel's link reads "Back to the tab" on a quick sale (F41).
2. **2 × Modelo → Pay → "Card · on the reader" → 20% ($3.60)** → "Paid · $23.20". **OK.** Admin lists the bar reader as "on order" (F17), and there is no decline state (F14).

### J7 · Bar tab
1. **New tab → "guest dips a Visa"** → the name "Priya" comes with the card → "Open Priya's tab · hold $50". **OK.**
2. **"guest taps a phone"** → no name, pick "Seat 2" → Open. **OK.** "Jess taps the card her tab is already on" → "Already open … nothing new was held". **OK.**
3. **Rounds.** Jameson (rocks by default) → Send → Repeat round → Send → "Hold $50 · $23 left". A $250 bottle → "hold grew to $350". **OK.**
4. **Close → "Close to Mastercard" → 22% ($55)** → "Paid · $327.19" → No receipt. **OK.**
5. **Closed tonight → Reopen** → the chip still reads "Hold $350 (grew)". The pay panel shows "Still to pay $0.00" beside "Close to Mastercard · the guest picks a tip" and cash buttons Exact/$50/$100 (F10).
6. **Split.** Jess P. → Split 2 → share 1 paid with an 18% tip → tap Luis M. → back to Jess P. → Close tab shows the full $32.66 again (F9).
7. **Move to a room.** Moving each of Jess's lines to Room 9 leaves a $0 tab still holding $50. Closing it asks for a $1/$2/$3 tip and ends "Paid · $0.00" (F18). Moving a Modelo onto cut-off Hana K. is allowed without a warning (F19).

### J8 · Bar-style karaoke singer queue
- Bar mode is **on** for West 4 in Admin → Features and in the Console. Setup step 2 says it "adds the phone song queue, Up next TV". Yet no screen has a singer queue, a join page, per-song charges or an Up next display. The homepage says "Buy a drink, get a song". **Not on the canvas (F6).**

### J9 · Comps, voids, refunds and approvals
1. **Rail.** A $18 void → "$25 or less needs only a reason · $63 left this shift". Over $25 → "goes to Andy's phone". This matches the rule. **OK.**
2. **Room (phone).** Six reason-only comps totalling $80 in one shift all pass as "reason only" (F11).
3. **DeskRoom.** An $8 comp → "Ask Andy to approve" (F11).
4. **Approving.** Nowhere: Andy's phone has no approvals list, and on the Room phone the requester is Andy himself (F11).
5. **Refund (staff phone only).** It defaults to $360 against a $120 deposit, with one tap, "Refunded", and no approval (F8). The Board has no comp, void or refund at all. Night's exceptions table reads correctly.

### J10 · A cut-off guest and the 4 AM stop
1. **Rail.** Hana K.'s tab is cut off: alcohol is greyed, repeat round is blocked, and the reason is shown. "Demo: it's 4:02 AM" greys all alcohol, and room orders show "Decline". **OK.**
2. **Gaps.** No control to cut someone off exists anywhere. The Order screen and the bar orders screen have no 4 AM or cut-off state. The Room and DeskRoom quick-add buttons ignore the alcohol window. The runner's "too drunk" return doesn't cut the room off (F20, F21). A drink can be moved onto a cut-off tab (F19).

### J11 · Staff shift
1. **Pin, bar computer.** Diego → 6358 → "Hi, Diego · Staff" → "Clock in · 7:00 PM" → Start break → End break → Clock out. **OK.** Maya's badge → "Open the bar POS". Lockouts, the 10-wrong pause and 6-digit manager PINs match the spec. **OK.**
2. **Gaps.** Clocking out ignores Maya's three open tabs and her cash, and nothing asks for the shift's duty (F29). Diego (role Staff) gets a "Bar POS" link and runs tabs on the Rail (F28). Pin's clock says 7:00 PM (F40).
3. **Pin, staff phone.** Maya's PIN → "Open tonight" → a portal signed in as "Andy · Manager" (F46).
4. **Staff phone, Tonight and Tips.** Timeline and List work. Tips to enter: a tip over 25% goes to Abhishek to approve; My tips shows the 146-2.17 lines. **OK.**
5. **Switching people at the bar** ("Diego taps a badge") works, and each person's unsent drinks are kept. **OK.**

### J12 · The manager's close
1. **Night → "Last call · close 4 tabs"** → one confirmation "Charges 4 held cards $152.43 … Tariq A. waits for Andy's OK" → closed. "Andy OKs Tariq's void" → close 1 tab. **OK.**
2. **House drawer.** A count of 1800 shows "Should be $1,838 · short $38 · needs a note" → note → close. "Demo: a drawer per person" works too, as does the Board's hand-over or change-a-drawer. **OK.**
3. **Tip pool** by hours (Maya 9h20m, Diego 5h30m) with the jar entry works, then "Night closed · 1:20 AM". **OK.**
4. **Gaps.** Night says no paper-slip tips are waiting while the staff phone has 3 (F30). The gratuity total equals 20% of all sales, bar sales included (F31). Several close checks are missing (F30). Reports offer an export without a passkey and show no tax-quarter, payroll or dispute screens (F46, F53).

### J13 · An internet outage
- **Not designed.** The Board reads "Online · synced 4 s ago · works offline". Admin lists the backup router as "TO SET UP". No banner, read-only state, offline code, queue mode, replay review or break-glass screen exists (F12).

### J14 · A new venue: setup → modules → website builder → our control panel
1. **Setup, 10 steps.** The address sets the New York rule pack; "What you run" turns on 13 of 19 modules; then rooms, menu import, songs (Playbox has no API), team, payments (Stripe not connected), devices (2 to order), website style and test night. **OK as a walk.** The hardware list has no badge readers or badges (F38).
2. **Admin → Features.** Turning off "Bar screen & tickets" at 10:41 PM is instant, with no dependency warning (F37). Modules with live sessions show a "stopping" state. **OK.**
3. **Website builder, Booking module Off.** The Booking section greys out and the nav "Book" link disappears. The hero button still says "Book a room" and scrolls to Find us (F37).
4. **Console.** It shows allowed and in-use modules per venue, and support access with a reason. It says West 4 is "10 of 10 · 7/7 devices online", while Admin and Setup disagree (F38).
5. **Does turning a module off remove it from other screens?** Only from Admin's own menu and the builder's Book section. Every other screen is hard-coded (F37).

### J15 · Guest safety
- **Order → "Need a manager, privately?" → "I feel unsafe"** → "Sent to the managers". No manager's phone or Board screen receives it (F25).
- **Headcount.** The Board shows "Inside now: 100 people" with no limit set; there's no warning state and no door counter (F51).
- **ID checks.** Chips such as "ID ✓ 12 of 12" appear, but no screen records an ID check (F3).

### J16 · A damage fee, a lost item, a room fault
- **Damage.** "Add damage fee $150 + photo" toggles the fee, and DeskRoom shows "photo attached" when no photo was taken (F24).
- **Lost item.** No lost-item log exists (F50).
- **Room fault.** The guest's "TV or song isn't working" call → staff tap "On it" → nothing further. There's no fault log, no clock pause and no way to comp room time. The only remedy on the canvas is Night's refund afterwards (F24).

### Navigation and demo "now"
- The desktop side menus match on Board, DeskRoom, DeskCalendar, DeskMessages, DeskReports, Night and AdminDesk.
- The Rail has no side menu (F54). The bar orders screen has no links at all (F35).
- The "Bar orders" badge shows 1 while 2 orders are waiting (F36). The phone's Reports links to the desktop Night screen.
- The demo "now" is off on Pin (7:00 PM), Night (≈1:20 AM), Book and Main (the device clock) and Manage (F40).

---

## 3. Findings

### Blockers

**F1 · Blocker · J3 · The bar never hands a room order to a runner, and the four screens disagree on its status**
- **Screens:**
  - Bar.dc.html l.71: the "Sent to room" button sets `status: "done"` (l.210).
  - Bar.dc.html l.113: the footer reads "Received → Accepted → On its way as you tap".
  - Rail.dc.html l.555: Accept removes the card.
  - Staff.dc.html l.103–117 and l.282–283: "since made", "I've got it", "Delivered · on the room's tab".
  - Order.dc.html l.296–297: STEPS and NOTES.
  - Spec: `orders.status` (ringing, held, accepted, sent, delivered, returned, cancelled) and the "Room orders" paragraph.
- **Now:** Nothing on the bar puts an order into "ready for a runner". The only button after Accept marks the order delivered, which skips Runs. The Rail has no step after Accept. "On its way" is set by the bar on one screen and by the runner on another. The staff phone implies the charge happens at delivery. Section 1 has the full table.
- **Should:** one pipeline with the same words on every screen:
  - Ringing → (Held) → Being made → Ready for a runner (spec `sent`) → On its way (a runner claimed it) → Delivered (by the runner).
  - Side exits: Returned (the runner couldn't serve) and Cancelled or Declined.
- **Fix:**
  - Bar.dc.html: rename "Sent to room" to "Ready for a runner" and add a "Ready · N" column fed by it. Fill "Delivered tonight" only from the runner's Delivered, and add a "Returned" list with Void or Remake.
  - Rail: give accepted room orders the same "Ready" tap, or state that room orders are finished only on the bar orders screen.
  - Order: use Received · Being made · On its way · Delivered, plus Held, Couldn't be served and Declined.
  - Staff: change the done line to "Delivered" (the sale was at accept).
  - Spec: define `sent` as "made, waiting for a runner" and `claimed_at` as "on its way".

**F2 · Blocker · J3 · "Hold · text the room" moves an order into Making without accepting it, so it can be delivered unpaid**
- **Screens:** Bar.dc.html l.59 (the button) and l.208 (`hold: () => upd(o.id, { status: "making", by: "Maya · held" })`); Order.dc.html has no held state; Rail has no Hold.
- **Now (clicked):** Room 5's 4 × Bud Light moved to "Making · Maya · held" with a "Sent to room" button. No ticket printed, nothing went on the tab, and there's no Accept button left. "Sent to room" then lists it under "Delivered tonight".
- **Should:** a held order stays under "Waiting for you" with a "Held · 4:10" chip. It keeps aging and needs Accept (the sale plus the ticket) before any runner step. The guest sees "The bar needs about five minutes".
- **Fix:** keep held orders in Waiting with Accept. Never offer Ready or Delivered on an order that hasn't been accepted. Add the held state to Order and to the Rail's room-order cards.

**F3 · Blocker · J3, J15 · Check-in isn't designed: no ID check, party count, room code or clock start**
- **Screens:**
  - Board.dc.html l.132–135: the open-room panel's only control, "Seat a walk-in here", does nothing.
  - Board.dc.html l.113–131: the in-use panel has no check-in or no-show.
  - Staff.dc.html l.329–335: one tap → "Checked in by Andy".
  - DeskRoom l.93: "ID checked at the door by Diego".
  - Bar and Order: "ID ✓ 12 of 12".
  - Spec: Devices, Safety ("Check-in records the ID check in `id_checks`") and `POST /bookings/{b}/check-in`.
- **Now:** The desktop board can't check a booking in at all. The phone flips the status in one tap: nobody confirms the party size, counts IDs, confirms the room, sends the room code or starts the clock at a chosen time. The "ID ✓ 4 of 5 · runner checks the last ID" chips that bartenders and runners rely on have no screen that records them.
- **Should:** one check-in sheet on both surfaces:
  - Confirm the party size, with the billable minimum shown.
  - Count IDs: "x of n checked, the runner checks the rest".
  - Confirm or change the room.
  - Start the clock now or at the booked time.
  - Send the room code and apply the deposit.
- **Fix:** add Check in to the Board, both for "Arriving" and "Late" tiles and for the "Next booking" of an open room, and to the phone's Details sheet. Both should call `/bookings/{b}/check-in` with `{party_size, ids_checked, room_id, start_at}`. Show arriving and late bookings on the Board, with "Mark no-show" beside them.

**F4 · Blocker · J2 · A walk-in can join the waitlist but can't be offered a room or seated**
- **Screens:**
  - Board.dc.html: l.64 "Waitlist · 3" and l.65 "+ Walk-in" (neither has a click handler), l.134 "Seat a walk-in here" (no handler), l.271 alert a6 "Text" (only selects Room 11).
  - Staff.dc.html: l.96 "+ Add a walk-in" (no handler), l.354 "Text: room ready" (texts with no room and no hold).
  - Waitlist.dc.html l.156: the ready screen names "Room 4" for a small party.
  - Spec: Room assignment (offers go only to rooms free for an hour, and an unclaimed offer expires after 10 minutes) and `POST /waitlist/{w}/offer`.
- **Now:** The guest side works. On the staff side the desktop has no waitlist view, and the phone texts "your room is ready" without choosing or holding a room. Nothing seats the party afterwards. The guest is sent to Room 4, which is off tonight.
- **Should:** a waitlist panel on the Board and the phone listing each party's size, quote and wait. From there:
  - "Offer a room" picks the smallest room that fits and is free for an hour, places a 10-minute hold, sends the text and shows the countdown, with "Not delivered · Call" if the text fails.
  - "Seat" at the door starts check-in (F3) in the held room.
  - An expired offer releases the room to the next party.
- **Fix:** design the Board's waitlist drawer, opened from "Waitlist · 3". Make each phone Waitlist row open an Offer sheet, and wire alert a6 to that sheet. "+ Walk-in" (no wait) should go straight to check-in in a free room. The guest's ready screen should name the offered room.

**F5 · Blocker · J1 · Online booking stops at the deposit button: no guest details, no card-on-file consent, no confirmation**
- **Screens:**
  - Book.dc.html l.101–102: "Pay $X deposit" and "Google Pay · or type a card" have no click handler.
  - Book.dc.html l.97: the policy text.
  - Book.dc.html l.103: "Instant confirmation by text", with no phone field.
  - Spec: Payment flows, "Deposit when booking online", steps 1–3.
- **Now:** The page never asks for a name, mobile or email. It never shows the terms that let later charges go on the saved card (the rest of the tab and a no-show charge), which the Room and DeskRoom "Card on file" close-outs depend on. There's no hold countdown, payment step, success, failure, or "room gone, refunded" state.
- **Should:** details (name, mobile, email) → the policy line above Pay that names the later charges → a payment page on its own origin → Confirmed (tier, time, deposit, refund cut-off, "text sent", link to Manage). Failure states: declined, hold expired, room gone.
- **Fix:** add those four Book states and link Manage from the confirmation.

**F6 · Blocker · J8 · Bar mode is on at West 4, but no screen has the singer queue**
- **Screens:**
  - AdminDesk.dc.html l.747: `barMode: true`. The Console shows "Bar mode · In plan · On".
  - Setup step 2 ("adds the phone song queue, Up next TV") and step 5 l.1014 ("Bar song queue · staff mark each song as it starts").
  - Main.dc.html l.265–266: "Sing at the bar · Buy a drink, get a song".
  - Spec: "Bar mode queue", the `song-queue` and public queue routes, and the Up next display.
- **Now:** Nothing exists for a singer to join (display name plus a phone code), for staff to call the next singer, to mark a song started (which posts the per-song charge) or skipped (free), to open a singer's tab or prepaid song credit, or to show the Up next TV.
- **Fix:** before milestone 4, design the public queue page, a Queue panel on the bar POS (up next, rotation, Started, Skip, logged overrides), the Up next display and song lines on singer tabs. Until then, switch Bar mode off for West 4 in Admin and the Console.

**F7 · Blocker · J5 · The staff phone's "Close out" marks a room paid without taking a payment**
- **Screen:** Staff.dc.html l.329–332: `update(r.id, { status: "done" }, "Closed out, paid at the bar")`.
- **Now (clicked):** List → Priya R. → Close out → "DONE · Closed out, paid at the bar". No amount and no payment. "Reopen" then sets the booking back to Confirmed rather than reopening the check.
- **Should:** Close out opens that room's tab (Room.dc.html). The booking is done only when payments cover the amount due, and then the room goes to cleaning.
- **Fix:** relabel the button "Tab & close out →" and link it to the room tab. Remove the one-tap Done, and make Reopen reopen the check.

**F8 · Blocker · J9 · The only refund screen refunds more than was paid, instantly and without approval**
- **Screens:** Staff.dc.html l.345 (`full = party × 10 × hours`) and l.459 (`doRefund`). Spec: Tenancy, "Approvals" (a refund needs approval from someone other than the requester); "Refunds" (reversing lines; "Refund pending" until Stripe finishes); Money rules 14.
- **Now (clicked):** Marcus T., who paid a $120 deposit → Refund a charge → prefilled $360.00 → one tap → "Refunded $360.00 to Amex · 1005 · Stripe re_8Kz…". There's no line choice, no approval and no pending state. The Board, DeskRoom and the bar POS have no refund at all.
- **Should:** pick lines from a paid check. The amount can't exceed what was captured minus earlier refunds, split by payment. Record a reason, get approval from another manager on their phone, and show "Refund pending" until Stripe confirms.
- **Fix:** replace the sheet with "Refund from check": check → lines → payments → reason → "Sent to Abhishek" → Pending → Refunded. Offer it on DeskRoom and under the Rail's Closed tonight.

**F9 · Blocker · J7 · A paid split share is forgotten once the bartender leaves the pay panel**
- **Screens:** Rail.dc.html l.537 (switching tabs keeps the pay state, but l.763–767 `openPay` resets it with `freshPay`), l.830 and l.834 (the split lock). Spec: check status `partly_paid`; Money rules 12.
- **Now (clicked):** Jess P. → Close tab → Split 2 → share 1 on the held card, 18% tip ("Share 1 of 2 paid") → tap Luis M. → back to Jess P. → Close tab shows "Total $32.66", with no share paid and no badge. Paying again charges $32.66 on top of $16.32. Screenshot: `rail_split_lost.png`.
- **Should:** "Partly paid · $16.32 of $32.66" as a badge in the tab list and a line in pay, and the next charge is $16.34. A share can be paid in cash. If the second guest leaves, there's a "Stop splitting, charge the rest to …" path.
- **Fix:** rebuild the pay panel from the check's amount due (server allocations), add the badge, and add cash and stop-splitting options to the split.

**F10 · Blocker · J7 · A reopened tab still offers "Close to [card]" on a hold already captured**
- **Screens:** Rail.dc.html l.715 (hold chip), l.806 (`hasHeld: !!tab`), l.811 (note), l.664 (cash choices). Spec: card on file needs the guest's confirmation or an approval.
- **Now (clicked):** Seat 2 closed at $272.19 plus a $55 tip → Reopen → the chip reads "Hold $350 (grew) · $77 left". Close tab shows "Still to pay $0.00" with "Close to Mastercard ··3342 · The guest picks a tip on the bar reader", cash buttons Exact/$50/$100, and the note "releases the hold". Screenshot: `rail_reopen_close_to_card.png`.
- **Should:** after capture there's no hold; the chip reads "Paid $272.19 · no hold". A new drink is paid by a new tap, by cash, or by "Charge the saved card", which needs the guest's confirmation or a manager's approval. With nothing due, no pay buttons appear.
- **Fix:** on reopen, drop the hold chip and "Close to card". Offer Tap, Cash and Saved card (with OK), and hide payment while $0 is due.

**F11 · Blocker · J9 · The comp and void limit works three different ways, and no screen lets a manager approve**
- **Screens:**
  - Rail.dc.html l.364–365 and l.677–679: correct, tracking each person's shift total.
  - Room.dc.html l.282–289: checks only that each comp is $25 or less, never the shift total.
  - DeskRoom.dc.html l.173 and l.317–319: every comp needs Andy.
  - Staff.dc.html (Andy's phone): no approvals list.
  - Spec: Approvals and `pos.reasonOnly`. AdminDesk Hours & prices: "Nobody approves their own".
- **Now:** The Room phone passed six reason-only comps totalling $80 in one shift (tested with `room_comp.py`). DeskRoom asks Andy to approve an $8 comp. All three screens send approvals "to Andy's phone", but the phone signed in as Andy has no approvals inbox, and on the Room phone the requester is Andy himself. Only "Demo: Andy approves" buttons exist.
- **Should:** the Rail's Void/Comp/Move sheet (made or not, reason, "$X left this shift") on every screen, with the shift total counted across screens per person. Requests go to a manager other than the requester. The manager's phone has an Approvals list: line, amount, reason, who asked, Approve or Decline.
- **Fix:** reuse the Rail's fix panel in Room and DeskRoom, add "Approvals · N" to Staff.dc.html with a push, and route Andy's own requests to Abhishek.

**F12 · Blocker · J13 · The internet outage has no screens**
- **Screens:** Board.dc.html l.313 ("Online · synced 4 s ago · works offline"); Rail l.56 ("● online"); AdminDesk Printers & devices ("Backup internet · TO SET UP"). Spec: "When the venue's internet drops" 1–4, "When our cloud is down", and Devices, "When the venue is offline".
- **Now:** None of the spec's outage states exist:
  - an "On backup internet" banner or a notice that card readers may fail for up to 2 minutes while they switch;
  - an "Offline" read-only board and tabs;
  - offline-code entry and queue mode;
  - replayed orders held for the bartender to confirm, or the manager's "Review after outage" list;
  - the break-glass path (Tap to Pay in Stripe's Dashboard app on a manager's phone) and the unmatched-payment inbox;
  - a "Stripe or Twilio is down" banner.

  The Board says "works offline", which the spec rules out for anything that writes.
- **Fix:** add banner states to the Board and Rail, and a Rail queue mode with visible "queued · not charged" rounds. After reconnect, add a "Confirm replayed orders" list and the manager's review. Add a one-page break-glass card under Night or Admin.

### Majors

**F13 · Major · J5 · Close-out sends the room to cleaning with an order still ringing, and nothing stops ordering during payment**
- **Screens:** Room.dc.html l.74 and l.169; DeskRoom l.162 and l.331; Order.dc.html has no "bill ready" state. Spec: Money rules 6.
- **Now (clicked):** DeskRoom → Cash → "Paid. Room 9 goes to cleaning" while 2 × Margarita · Peach is still ringing. There's no step that presents or finalizes the check, so guests can keep ordering during close-out.
- **Fix:** start close-out with "Present the check", which finalizes it and locks ordering; Order then shows "Your bill is on its way · ordering is closed". List any open orders ("accept or cancel first"). Block Paid → cleaning while an unpaid or accepted order exists; an order accepted after payment opens a new check.

**F14 · Major · J5, J6, J7 · No screen shows a declined card, a timeout, a declined hold raise or an offline reader**
- **Screens:** Rail.dc.html `takeTip`/`finish` go straight to paid; Room.dc.html l.308 and DeskRoom l.331 (`confirmPay`). Spec: "How every card payment runs" step 4 ("Status unknown, don't retry"); Bar tab 3–4; API errors `payment_unknown`, `reader_busy`, `reader_offline`.
- **Now:** Every card path lands on "Paid". Bar tabs can show "Over the hold" but never "raise declined · new orders need OK". The room split confirms both cards at once.
- **Fix:** add these states to the Rail's pay panel, the Room and DeskRoom close-out and each split share: waiting for tap; declined (try another card or cash); unknown ("Checking with Stripe, don't retry"); reader offline or busy; hold raise declined.

**F15 · Major · J5 · "Card on file" needs the guest to confirm, but no guest screen shows the bill, the confirmation or "pay cash to staff"**
- **Screens:** Room.dc.html l.298; DeskRoom l.314; Order.dc.html ("Tonight so far" is before tax and gratuity, and there's no pay). Spec: Room close-out table and "every guest flow also offers 'Pay cash to staff'".
- **Fix:** add a guest "Your bill" page, reachable from the room session and the booking link: itemized total, deposit, gratuity, "Pay with Amex ··1005", "Pay another way", "Pay cash to staff". Add "Waiting for Marcus to confirm · Cancel" on Room and DeskRoom.

**F16 · Major · J5 · Room cash close-out doesn't record the cash handed over, the change or a cash tip**
- **Screens:** Room.dc.html l.299 and DeskRoom l.293/l.312 ("The drawer opens when you mark it paid"), compared with the Rail at l.664. Spec: Room close-out, Cash.
- **Fix:** reuse the Rail's cash panel (Exact, next $5/$10/$20, Other; change in large type; fix the change) and add a cash-tip field.

**F17 · Major · J6, J7 · The bar POS assumes a bar card reader and a drawer at the bar, but Admin has neither**
- **Screens:** AdminDesk.dc.html l.862 ("Cash drawer · on the receipt printer · Front desk · Opens on cash close-out") and l.867 ("Card reader · bar · S710, on order"); Setup step 8 ("On the list: 1 × S710"); Rail l.175 ("The bar reader is waiting"), l.218 ("tap what they hand you and the drawer opens"), l.838 ("Logged to Maya in the house drawer").
- **Now:** On the same night, the Rail shows five card-first tabs opened on the bar reader between 9:10 and 10:20 PM and opens a drawer at the bar for cash. Admin says the bar reader hasn't arrived and the only drawer is at the front desk.
- **Fix:** either make a bar reader and a bar drawer go-live prerequisites and show them ready, or design the fallback. For cards, add a reader picker (front desk or handheld). For cash, show "Drawer is at the front desk" or record it to a staff bank. Add a bar reader and drawer check to the Setup test night.

**F18 · Major · J7 · Moving a bar tab into a room isn't designed**
- **Screens:** Rail.dc.html l.277–281, l.698–706 (single-line Move) and l.856. Spec: "Songs, and moving a tab into a room"; `/tabs/{t}/move-to-room`; `transfer_in`/`transfer_out` lines.
- **Now (clicked):** Moving Jess P.'s two lines to Room 9 one at a time left a $0 tab still holding $50. Closing it asks for a $1/$2/$3 tip on $0 and ends "Paid · $0.00". The moved drinks show on the room as plain "Round 4" lines, gratuity is added, and no transfer line or hold hand-over appears.
- **Fix:** add "Move tab to a room" on the tab: pick the room, move all lines as transfers, release the tab's hold once the room has a payment method, and close the tab as "Moved to Room 9". The spec also needs to say what replaces "the room opens its own hold" when room holds are off, as they are at West 4.

**F19 · Major · J7, J10 · A drink can be moved onto a cut-off tab, and moves never raise the hold**
- **Screens:** Rail.dc.html l.856 (`moveTargets` lists every tab) and l.698–706. Spec: Money rules 5 ("drinks sent from another tab included").
- **Now (clicked):** 2 × Modelo moved onto Hana K. ("Cut off by Andy at 10:30 PM") with no warning. Her tab reached $58 before tax on a $50 hold, and the chip says "grows when sent", but a move never sends. Screenshot: `rail_move_to_cutoff.png`.
- **Fix:** grey out cut-off tabs as targets for alcohol, with the reason. Run the hold raise on a move, just as on a send.

**F20 · Major · J10 · Cutting a guest off and the 4 AM stop exist only on the bar POS**
- **Screens:** Rail.dc.html l.377 (the cut-off is seeded data; no screen has a Cut off control), l.440 and l.727 (the 4 AM demo); Bar.dc.html (no late or cut-off state); Order.dc.html (no alcohol-closed or refused state); Staff Runs "too drunk" has no follow-up. Spec: Money rules 5; `409 alcohol_closed`; `alcohol_refusals`.
- **Now:** No screen can cut a guest off. At 4:02 AM the Rail offers "Decline" on room orders, while the spec auto-cancels them. Its toast says "their tablet explains", but the Order screen has no such message, and the bar orders screen still shows Accept.
- **Fix:** add a "Cut off" action to tabs and room sessions (who, reason, logged as a refusal), shown on every screen for that tab or room. Order hides alcohol after the window and shows "The bar has stopped serving alcohol tonight" or "Your server has paused alcohol for this room". The bar orders screen lists declined and auto-cancelled orders. A runner's "too drunk" return offers "Cut off Room X?".

**F21 · Major · J3, J10 · Room and DeskRoom put generic drinks straight on the tab, bypassing the bar**
- **Screens:** Room.dc.html l.229 ("+ Cocktail $12", "+ Shot $9"…); DeskRoom.dc.html l.212 (quick adds, including "Margarita $13" with no flavor). Spec: menu items and variants; staff orders go ring → accept → ticket.
- **Now:** One tap adds "1 × Cocktail · $12" to Room 9's tab. It isn't a menu item: no flavor, no ticket, no 86 check, no alcohol window, and the bar never hears about it.
- **Fix:** replace the chips with a menu search that creates an accepted staff order and prints a ticket, or open the Rail with that room's tab selected.

**F22 · Major · J4 · A room running long has no way out on desktop, and the phone's room move ignores size and code**
- **Screens:** Board.dc.html l.113–126 (the in-use panel has no Move), l.267 (alert a2), l.271 (alert a6); Staff.dc.html l.388 and l.448–449; Order has no "moved" state. Spec: Room assignment; `/sessions/{s}/move` ("checks the target room, issues a new room code").
- **Now:** Alert a2 asks Room 7 (+9 min) to wrap up because "no other 6–12 room is free for an hour", while Room 11 (fits 12–20) is free all night and alert a6 offers it to a party of 6. The phone's "Move to Room 5" moves 12 guests into a 3–6 room that the Board and bar screens show as occupied, with no new code and nothing sent to the guests.
- **Fix:** add a Move sheet to the Board, DeskRoom and phone listing rooms that fit and are free for the time needed. It opens a new clock segment, issues a new code, rotates the guest token, and shows the guests "Moved to Room 11 · new code …". The wrap-up alert should offer "Seat the waiting party in Room 11 instead".

**F23 · Major · J4, J5 · Party size can't be changed once a room is running**
- **Screens:** DeskRoom l.52, Room.dc.html l.31, Staff Details and the Board all show the party size read-only. Spec: Money rules 3 (a party-size change closes a segment) and 9 (lowering it after gratuity applies needs approval).
- **Fix:** add a Party size control (+/−) showing the new hourly rate and billable minimum, with approval when lowering after gratuity applies. Update the "IDs x of n" chip to match.

**F24 · Major · J16 · A mic failing mid-session can't be handled, and the damage fee has no photo**
- **Screens:** Order.dc.html l.318 ("TV or song isn't working"); Board l.118 ("On it" clears it); Room.dc.html l.277 and DeskRoom l.110/l.308 ("Damage fee · photo attached", with no photo step); Night l.238 (the only remedy shown is a later refund). Spec: `room_faults`, `session_segments.paused` (needs approval), `check_lines.file_id`.
- **Fix:** add "Report a fault" on the Board and DeskRoom: log it on the room, "Out of service", "Pause the clock" (with approval) and "Comp X minutes of room time". Take the photo (camera or upload) and a reason before a damage fee is added. Show open faults on the Board tile.

**F25 · Major · J15 · The private help alert reaches no screen**
- **Screens:** Order.dc.html l.176–195 ("Sent to the managers"); Staff.dc.html (Andy's phone has no incidents); the Board has no "Manager needed" pin. Spec: `/room-session/help`; `incident.opened` (managers' phones only; the Board pins "Manager needed" with no room or reason); `incidents`.
- **Fix:** add an alert on the manager's phone (room, time, "I'm on it", notes that go into the incident log) and the Board's "Manager needed" pin. Add an incident-log view.

**F26 · Major · J3 · Room calls reach only the desktop, and the guest is told the bar screen lights up**
- **Screens:** Order.dc.html l.167 ("Room 9 lights up on the bar screen with your reason"); Bar and Rail show no calls; Board l.118 and DeskRoom l.73–79 do show calls; Staff.dc.html has no calls list. Spec: `room.call` goes to the Board and staff phones.
- **Fix:** add a Calls list and push to the staff phone, and change the guest copy to "Staff get it on their phones".

**F27 · Major · J3 · Guests can't join a room: there's no code-entry screen**
- **Screens:** Order.dc.html opens already joined (header "Code KX4M7"); Admin → Texts ("scan the code on the wall and enter room code KX4M7"). Spec: the join route; ten wrong codes rotate the code and alert staff.
- **Fix:** design the join flow: scan → enter code → joined as host or friend, plus wrong code, too many tries, room closed, and moved room (new code). Add the room-tablet kiosk variant ("Room available" between sessions, no help link).

**F28 · Major · J11 · Diego has the Staff role, but he works the bar POS, owns tabs and takes cash**
- **Screens:** Pin.dc.html l.124 (role Staff) and l.259 (a "Bar POS" link); AdminDesk Team (DR: "Staff · check-ins, walk-ins, texts"); Rail l.362 ("Front desk · covering the bar") and l.380–381 (tabs t5 and t3 are Diego's); Night l.286 (in the drawer-per-person demo, his own drawer with 2 cash tabs). Spec: Roles (Staff can't take payments, run tabs or quick sale, or use the bar POS).
- **Fix:** make Diego a Bartender everywhere, or change the role table. Also decide whether the front desk takes cash.

**F29 · Major · J11 · Clocking out ignores open tabs, cash and duty**
- **Screens:** Pin.dc.html l.189–209. Spec: `shifts.duty`, `staff_banks`, drawer swap and pull, tip eligibility by duties worked.
- **Now:** Maya clocks out with three open tabs ("Mine 3") and unsent drinks, and nothing asks her to hand them over, drop cash or pull a tray. Clock-in never asks for the duty the tip pool uses.
- **Fix:** add a clock-out checklist (hand over tabs, unsent drinks, cash drop, tray pull, cash tips declared) and a duty picker at clock-in. Show "on break" on the bar POS.

**F30 · Major · J12 · Close the night says no slip tips are waiting while the phone shows three, and other close checks are missing**
- **Screens:** Night.dc.html l.134 ("Bar tips were picked on the reader, so none are waiting to be typed in") and l.303 (`canClose` checks only rooms, tabs and the drawer); Staff.dc.html l.274–278 (Dev S., Tom W. and Ana R. are waiting in Tips to enter). Spec: Bar tab 7 (the close allows awaiting-tip tabs; a late tip posts to the next business date).
- **Fix:** list awaiting-tip tabs on Night ("3 slips not entered · tips post to Sat") with a link. Also check, before closing:
  - staff still on the clock;
  - open waitlist entries;
  - ringing or held orders;
  - pending approvals;
  - rooms still cleaning;
  - unsent drinks;
  - the 30-minute clear-out check.

**F31 · Major · J12 · The Z report's gratuity is 20% of all sales, bar sales included**
- **Screens:** Night.dc.html l.97–107. The report also shows "Card tips · 11 bar tabs" and "Cash sales · 8 tabs". West 4's gratuity rule applies to room tabs only.
- **Now:** (4,318.33 room time + 5,266 drinks + 1,240 packages − 118 comps − 93.12 refund) × 20% = $2,122.64, against $2,122.65 shown. The figure treats every drink, bar tabs included, as carrying gratuity.
- **Fix:** split drinks into rooms and bar on the Z report and take gratuity from room checks only.

**F32 · Major · J1, J2 · A party of 3 can't be entered on Fri or Sat, though the minimum is meant to be a billing rule**
- **Screens:** Book.dc.html l.121 and l.176 (`guests = max(min, …)`); Waitlist l.168; Manage l.196 and l.285. Compare Setup step 3 ("Smaller groups pay for the minimum"), Staff l.291 (Sam O., party of 3, "$40 deposit paid (Friday minimum of 4)") and spec Money rules 3 (billable guests is the larger of the party and the minimum).
- **Fix:** allow a party of 3 with the note "Fri & Sat bill at least 4 · you pay for 4". Keep the party size and the billable guests separate everywhere.

**F33 · Major · all journeys · The phone and the desktop show different nights at 10:41 PM**
- **Screens:** Staff.dc.html l.285–298 and Calendar.dc.html (phone); Board l.207–222; DeskCalendar l.170–175; Bar l.125–131; Rail l.376–389; Night l.222–224; Messages and DeskMessages; Manage l.180–182; Waitlist.
- **Why this is Major:** the phone lists bookings, not rooms, so walk-in rooms don't exist there. It shows 2 rooms in use and 11 open, while the Board shows 8 and 3. The spec also seeds staging with this story "so the design and the build can be checked against each other", which these screens can't support.

| Party or room | Staff phone and phone Calendar | Board | DeskCalendar | Elsewhere |
|---|---|---|---|---|
| Dana K., Room 1 | 8:30, 1 hr, **Late, not arrived** | In room, 28 min left, $86 | 8:30, 2 hr, Seated | Runs: Room 1 · 4 × Corona made by Diego; phone Messages: "running 15 late" |
| Priya R., Room 3 | 7:00, 2 hr (ended 9:00) | 4 min left, "Jae & co. booked 10:45" | 7:00, 2 hr | Bar: Room 3 in "Making"; Runs: "made 4:00 ago" |
| Jae & co. | 9:00, **8**, Room 6, Confirmed | Booked 10:45 in **Room 3** (fits 3–6) | Not listed | Manage: **7**, **10:00 PM**, $70; Board: Room 6 needs a wipe since 9:12 |
| Leo | Waitlist, party of 4, 22 min | Leo M. in Room 5, 51 min left | 9:00, Room 5, Seated | Bar: Room 5 is **Kenji W. · party of 5** |
| Bianca L., VIP | 9:30, 3 hr, **Confirmed (arriving)** | In the VIP room, 140 min left, $745 | 9:30, 3 hr | Rail: opened 9:30, 71 min, **$776** |
| Sam O., Room 2 | **10:00**, 1 hr | **10:30**, "running 15 late" | 10:30, Late | DeskMessages: running late (the phone thread says Dana) |
| Omar F., Room 12 | Not listed | 102 min left, **$330** | 9:00, 3 hr | Rail: opened **8:23**, 138 min, **$392**; Night: since 9:00 |
| Tanya W., Room 10 | Not listed | Staying, +12 min, $96 | Not listed | phone Messages: "**Paid · left 9:10**" |
| Waitlist | Leo 4, Amara 7, Chris 3 | 3 waiting, incl. **Priya K. 6** and a party of 7 | none | DeskMessages: Priya K. 6; Waitlist page: "**2** ahead" |
| Open bar tabs, rooms in use | none | 8 rooms in use | none | Rail 5 tabs; Night 5 tabs; Admin Features "**4** open tabs · **9** rooms in use" |

- **Fix:** use one seed for tonight on every screen (the Board's rooms plus DeskCalendar's bookings). Make the phone's Tonight a room board as well as a bookings list.

**F34 · Major · J1 · The big-party link can double-book the VIP room**
- **Screens:** DeskCalendar.dc.html l.111–135, l.227–231 and l.259; phone Calendar.dc.html likewise. Spec: every booking has a real room; `room_blocks` can't overlap.
- **Now (clicked):** Fri Sep 25, 24 guests, 9:00 PM, 3 hr → "VIP room · $250/hr" → Text the host → "LINK SENT", while Bianca's party of 22 holds the VIP room from 9:30 PM to 12:30 AM. A 9:00 PM start is also already past.
- **Fix:** show the room and how long it's free in the dialog, refuse overlapping or past slots, and place a pending hold that expires when the link goes out.

**F35 · Major · J3, navigation · The bar orders screen is a dead end and shows no signed-in person**
- **Screens:** Bar.dc.html l.32–40 (the header has no links), while seven desktop side menus link to it; l.207 stamps every accept "Maya".
- **Fix:** add the W4/back and Lock controls the Rail has, show who is signed in, and accept orders under the badge session.

**F36 · Major · J3 · Order escalation and print failures don't match the spec**
- **Screens:** Bar.dc.html l.206 ("Waiting 4+ min · front desk and Andy texted") and l.113; Rail l.551; Board (no alert for the 2:11 Room 5 order; its "Bar orders" badge says 1 while 2 are waiting). Spec: escalation (bar phones at 30 s, the Board at 2 min, the manager's phone at 4 min, a text or call at 6) and "Ticket didn't print" with Reprint.
- **Fix:** add a Board alert at 2 min, show "on Andy's phone" at 4 and "texted" at 6, count every ringing order in the badge, and add "Ticket didn't print · Reprint" (with "REPRINT 2") to the Bar and Rail screens.

**F37 · Major · J14 · Turning a module off is shown only in Admin's own menu and the site's Book section**
- **Screens:** AdminDesk l.38–45 and l.1357; SiteBuilder l.1318–1321 and l.1510 (the hero keeps "Book a room" and scrolls to Find us); the menus on Board, Night, DeskRoom, DeskCalendar, DeskMessages and DeskReports are hard-coded; Board l.64–65; the phone's Waitlist and Runs tabs; Main l.278. Spec: Modules.
- **Now:** Switching off "Bar screen & tickets" mid-service was allowed at once (12 of 19 on), with no warning that room orders would then have nowhere to ring. No other screen reacts to any module.
- **Fix:** publish a module-to-element table (menu items, tabs, buttons, site sections, texts) and add "Ordering from the room needs Bar screen & tickets" to the dependencies. Give the hero button a fallback label when booking is off.

**F38 · Major · J11, J14 · Setup lists no badge readers or badges, and Setup, the Console and Admin disagree about West 4**
- **Screens:** Setup.dc.html l.1058–1066 (no NFC reader, NTAG badges or Up next TV), while Pin and Rail depend on badges; AdminDesk Team (no pair or switch-off badge control); Console l.495 ("7/7 online", 10 of 10 steps) against Admin (bar reader on order, 13 of 14 tablets online, backup router to set up) and Setup (Stripe not connected, 0 of 10).
- **Fix:** add a USB NFC reader for each shared screen, NTAG 424 badges and the Up next display to Setup step 8. Add Pair and Switch off badge to Admin → Team. Make the Console read the same device and setup status as Admin.

**F39 · Major · J11 · Training mode has no screen**
- Spec: Testing, Training mode ("New hires learn on the real screens").
- **Fix:** add a training switch, a permanent "TRAINING · not real money" band on the Rail, Board and Room screens, and practice check numbers.

### Minors

**F40 · Minor · navigation and time · The demo "now" disagrees across screens.**
- Pin says 7:00 PM (l.101, l.183), and Maya has "3h 00m so far".
- Night says about 1:20 AM (l.304, l.351). The phone's Reports says the night closes at 4 AM.
- Book (l.115) and Main (l.374) use the device clock: Book showed Mon Sep 28 with the weeknight minimum of 3.
- Manage treats a 10:00 PM Sep 25 booking as upcoming ("in 3 days", "in 5 hours").
- The Rail's late demo is Sat 4:02 AM, after Night has closed the night at 1:20 AM.
- **Fix:** pin one demo time, 2026-09-25 22:41 New York, in every file, and label Night's scene "later tonight".

**F41 · Minor · J3, J7, J12 · Some words mean two things to a first-shift bartender.**
- "Hold" means asking a room to wait (Bar) and a card authorization (Rail).
- "Last call" means the alcohol cutoff (Admin) and charging every open tab (Night).
- "Close out" means marking a room done (phone list) and taking payment (DeskRoom).
- "Sent to room" means delivered.
- "Back to the tab" appears on a quick sale.
- A void is labelled "COMP · void" (Room l.68 and l.287).
- The phone's lock button says "Lock the iPad" (Staff l.53).
- The Rail says "their tablet explains" when guests use their phones (l.555).
- The guest sees "Bar accepted" where the bar's copy says "Accepted".
- **Fix:** rename "Ask the room to wait", "Charge the remaining tabs", "Open tab", "Ready for a runner" and "Done", and align the rest.

**F42 · Minor · J12 · The Night screen has small errors.**
- "Sales · 26 rooms closed, 8 still open" counts bar tabs as rooms (l.338).
- A 10:39 PM log line is listed after 9:14 PM (l.264).
- "Turned Room 4 off at 11:30 PM · TV out" (l.257) contradicts "Mic dead since Tue" on the 10:41 PM Board.
- "Print Z report" is offered before the night is closed, when it would still be a running (X) report.

**F43 · Minor · J2 · Waitlist details.**
- "2 ahead" against 3 waiting elsewhere.
- No CAPTCHA.
- No "Not delivered · Call" state when a room-ready text fails.
- The ready room (l.156) is Room 4, which is off, for small parties and Room 8, booked at 11:00, for medium ones.

**F44 · Minor · J3 · The two bar screens disagree on Room 5.** The Bar screen shows "ID 4 of 5 · runner checks the last ID"; the Rail shows "ID 4 of 4". Demo orders call Room 3's party "Walk-in", though Room 3 is Priya R.'s booking.

**F45 · Minor · amounts.**
- The Rail shows VIP room time as $296 (l.384, whole dollars) where per-minute billing gives $295.83.
- The Board's tabs (Room 12 $330, VIP $745) don't match the Rail ($392, $776).
- The Rooms section's "$80 an hour, plus tax" leaves out the 20% gratuity that Book and Parties add.

**F46 · Minor · J11, J12 · Sign-in inconsistencies.**
- Maya's phone opens a portal signed in as "Andy · Manager" (Pin l.89 → Staff l.38).
- Pin says Admin asks for the PIN again (l.267), while AdminDesk says a PIN never opens Admin; AdminDesk matches the spec.
- DeskReports' "Email CSV" export works from the shared computer with no passkey.

**F47 · Minor · J5 · Room close-out details.**
- Room and DeskRoom always text the receipt; there's no Print, Email or No receipt choice.
- There's no "Additional tip (optional)" line and no cash-tip entry.
- DeskRoom's "Bar accepted" (l.88) is a demo control that isn't marked "Demo:".

**F48 · Minor · J4 · The staff phone's Details sheet offers the wrong actions.**
- "Let them stay" appears even for guests who haven't arrived, and without checking for a next booking.
- "Text guest" sends "Your room is ready when you are" to guests already seated.
- "Mark no-show" appears on seated bookings.

**F49 · Minor · J4, J16 · Cleaning details on the Board.**
- The tiles say "Left 9:12 PM" and "Left 9:20 PM" while the alert says "8 min".
- "Clean · open it up" sets Room 6's next booking to "nothing tonight", though the phone has Jae & co. booked there.
- Room 3 has no cleaning gap between Priya's end and Jae's 10:45 start.

**F50 · Minor · J16 · There's no lost-item log.** Only room notes exist ("TV remote goes missing"). Add "found in Room 9 · kept at the bar · claimed by …".

**F51 · Minor · J15 · The occupancy warning isn't designed.** The Board shows 100 inside with no limit set; the 90% warning state and the front-desk door counter have no screen.

**F52 · Minor · J1 · Booking changes are limited.**
- Manage can only change the time on the same night, not the date.
- Blocking a date says affected bookings "stay until you move or cancel them", but offers no cancel-and-refund-all step, which the spec requires.

**F53 · Minor · spec flows with no screen.**
- Disputes inbox with its evidence.
- Unlinked Stripe activity and payout matching.
- Accounting, payroll and tax-quarter exports.
- Admin → Bar POS layout editor and publish.
- Tabs whose capture failed.
- A photo of each paper slip under "Tips to enter".
- The alert when no bar device is connected.

**F54 · Minor · navigation.** The Rail has no side menu, so Messages, Calendar and Night take two taps via the Board. The Rail can't mark an item out (86 it); only the bar orders screen and Admin can.

**F55 · Minor · J9 · Messages and reports copy.**
- The phone Messages thread shows staff typing a booking link as free text ("We do. Booking link: west4karaoke.com/book"), which the spec blocks.
- Reports count "Reviews from the morning text · 19" while that text is switched off.

---

## 4. Journeys that work end to end on the canvas
- **J6 · Bar quick sale, cash and card:** ring → Pay → the amount handed over → change → receipt; card → tip on the reader → paid. This works, apart from F14 (no failure states) and F17 (bar reader and drawer).
- **J7, single-card tab:** New tab (dip brings the name; tap needs a label; a duplicate card opens the existing tab) → rounds → Repeat round → hold grows → Close to card with the tip on the reader → receipt. Split (F9), Reopen (F10) and move to a room (F18) don't work.
- **J11 · Shift basics:** badge or PIN sign-in with lockouts → clock in, break, clock out; badge takeover at the bar with unsent drinks kept; the phone's Tips to enter and My tips. Caveats: F28 and F29.
- **J12 · Manager's close:** last call with one confirmation and the approval wait → blind house-drawer count with a note → drawer-per-person demo and hand-over → tip pool by hours → Night closed. Caveats: F30 and F31.
- **J1, change and cancel part:** Manage → change time, change party size (up and down, before and after the refund cut-off), running late, cancel with or without a refund. Booking itself doesn't work (F5).
- **J2, guest part:** Waitlist → join → place in line → room ready → 10-minute countdown → give it away. The staff side doesn't work (F4).
- **J5, as a demo:** DeskRoom and Room close-out by tap, cash and split (even or by item, card or cash per person), with the worked Room 9 figures ($618.60, $498.60 due). Caveats: F13–F16.
- **J14, as a demo walk:** Setup's 10 steps → Admin → Features → the builder greys the Book section when booking is off → the Console shows allowed and in-use modules. Caveats: F37 and F38.

**Journeys that don't work end to end:** J1 booking (F5), J2 staff side (F4), J3 (F1–F3, F27), J4 room move (F22), J8 (F6), J9 approvals and refunds (F8, F11), J10 on room ordering and the bar orders screen (F20), J13 (F12), J15 help alert (F25) and J16 faults (F24).

---

## Appendix · evidence (under `review/flows_work/`)
- `pw.py` is the Playwright driver. `admin_dump.py`, `admin_dump2.py` and `setup_dump.py` dump the Admin sections and Setup steps into `ex/*.txt`. `room_comp.py` runs the $80 comp test.
- Screenshots in `shots/`:
  - `bar_held_in_making.png`: F2
  - `rail_split_lost.png`: F9
  - `rail_reopen_close_to_card.png`: F10
  - `rail_move_to_cutoff.png`: F19
  - `staff_refund_360.png`: F8
  - `room_comps.png`: F11
  - `waitlist_ready.png`: F4 (Room 4)
  - `book_pay.png`: F5
  - `rail_quick_cash_done.png`, `rail_late.png`, `board_0.png`, `night_0.png`, `night_closed.png`
