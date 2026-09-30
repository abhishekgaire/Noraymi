# FIX BRIEF · the final pass before implementation (Sep 28, 2026)

Three reviews found the problems this pass fixes: `review/flows.md` (F1–F55), `review/completeness.md` (C1–C37) and `review/competitive.md` (K1–K21). This brief holds the decisions and the single demo seed that every screen must follow, so that 27 screens built by different people agree with each other. When a finding and this brief disagree, **this brief wins**. When something isn't covered here, follow the spec (`review/spec.md`) and keep it consistent with the rest of this brief.

Read first: `w4/BRIEF.md` (look, format, checking), `w4/type/artifact-type/reference/format.md` (the .dc.html format), then this file.

---

## 1. Demo time

- **"Now" is Fri Sep 25, 2026, 10:41 PM, New York**, on every screen, with no exceptions. Never read the device clock for the demo date or time (`new Date()` only for ticking seconds after mount, anchored to 10:41 PM). Book, Main, Manage, Pin, Waitlist and every "tonight" list use this.
- The **Close the night** screen (Night.dc.html) is the one exception. It is labelled **"Later tonight · Sat 4:12 AM"** (business date Fri Sep 25). Its demo ends with "Night closed · 4:48 AM".
- The Rail's late demo ("Demo: it's 4:02 AM") is Sat 4:02 AM, business date Fri Sep 25. That comes before Night's 4:12 AM, so it doesn't contradict anything.
- Alcohol stops at 4:00 AM. At 4:30 AM (close + 30 min drinking-up), the clear-out check is due and the tab cut-off runs.

## 2. The team tonight and the roles

| Person | Role | Tonight | Phone | Badge |
|---|---|---|---|---|
| Abhishek G. | Owner | Not on shift; approves Andy's own requests | own phone | yes |
| Andy C. | Manager (manager on duty) | On since 6:00 PM | own phone, paired (the staff-phone demo is Andy's phone) | yes |
| Maya S. | Bartender | On since 4:00 PM | own phone | yes |
| Diego R. | **Front desk** (was "Staff") | On since 7:00 PM, and covers the bar when Maya is on break | own phone | yes |

Managers and owners use 6-digit PINs. Everyone else uses 4 digits. Demo PINs: Abhishek 915204, Andy 730915, Maya 4071, Diego 6358.

**Default role permissions.** Use these everywhere: Admin → Team, Setup step 6, Pin's home links and the Rail. ✓ = allowed; — = not allowed.

| Action | Owner | Manager | Bartender | Front desk | Staff (runner) |
|---|---|---|---|---|---|
| Take payments (card and cash), room close-out | ✓ | ✓ | ✓ | ✓ | — |
| Bar POS: quick sale and bar tabs | ✓ | ✓ | ✓ | ✓ (when covering the bar; Admin can switch it off) | — |
| Accept room orders at the bar, 86 an item | ✓ | ✓ | ✓ | ✓ (when covering the bar) | — |
| Check in, waitlist, bookings, guest texts | ✓ | ✓ | ✓ | ✓ | check-in and waitlist only |
| Carry runs ("I've got it", Delivered, Couldn't serve) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Comp or void within the reason-only limit | ✓ | ✓ | ✓ | ✓ | — |
| Cut off a tab, a room or a guest | ✓ | ✓ | ✓ | ✓ | — (a runner returns the order with a reason, and a manager decides) |
| Approve (comps and voids over the limit, refunds, clock pauses, tips over 25%, paid-outs, a lower party size after gratuity) | ✓ | ✓ | — | — | — |
| Ask for a refund | ✓ | ✓ | — | — | — |
| Count a drawer | ✓ | ✓ | ✓ (bar drawer) | ✓ (front-desk drawer) | — |
| Admin (needs a passkey; a PIN never opens it) | ✓ | ✓ (no Payments, Team or Console) | — | — | — |
| Shares tips and gratuity | — | — | ✓ | ✓ | ✓ |

- **Approvals.** Comps and voids up to **$25 each and $75 a shift per person** need only a reason. The shift total counts every screen: the Rail, Room, DeskRoom and the Board. Over either limit, a manager approves on **their own phone**, never on the requester's device. Nobody approves their own request, so Andy's requests go to Abhishek. The manager's phone (Staff.dc.html, signed in as Andy) has **Approvals · N**: the line, amount, reason, who asked and when, with Approve and Decline. The requester's screen shows "Waiting for Andy" and then the decision.
- **Pending at 10:41 PM:** one approval, Diego's void of 1 × Large bucket · 10 beers ($70) on Tariq A.'s tab, reason "rang it wrong". It's over $25, so it goes to Andy. Maya has used $12 of her $75 tonight (reason-only); Diego has used $0.
- **Tips over 25%** on a paper slip go to a manager (Andy), or to Abhishek if Andy entered the slip.

## 3. Tonight's seed (every screen shows these same facts)

Venue: West 4 Boho Karaoke, 186 W 4th St. There are 14 rooms, with these sizes (from the Board): Rooms 1–5 fit 3–6, Rooms 6–10 fit 6–12, Rooms 11–13 fit 12–20, and the VIP room fits 20–40.

The rate is $10 a person an hour, with a first-hour minimum and then billing by the minute. On Friday, at least 4 guests are billed. The VIP room is $250 an hour. Tax is 8.875%, and gratuity is 20% on room checks only. The deposit is the first hour.

### 3a. Rooms at 10:41 PM

"Room time so far" = billable guests × $10 / 60 × minutes, never less than the first hour. "Tab so far" = room time + drinks accepted so far, before tax and gratuity.

| Room | State on the Board | Party | Booked | Clock | Room time so far | Drinks so far | Tab so far | Notes |
|---|---|---|---|---|---|---|---|---|
| Room 1 (3–6) | In room · 49 min left | Dana K. · 4 | 9:30–11:30 PM · $40 deposit | 71 min | $47.33 | $76.00 (Small bucket $40 delivered 9:52; 4 × Corona $36, accepted 10:38, ready for a runner) | **$123.33** | ID ✓ 3 of 4 · the runner checks the last ID |
| Room 2 (3–6) | Open · **held for Sam O. until 10:45** | Sam O. · 3 (bills as 4) | 10:30–11:30 PM · $40 deposit | — | — | — | — | He texted "running 15 late" at 10:24. Check in, or Mark no-show at 10:45. |
| Room 3 (3–6) | Wrap up · 4 min left | Priya R. · 5 | 8:45–10:45 PM · $50 deposit | 116 min | $96.67 | $79.00 (2 × Peach soju $40; 2 × Margarita · Peach + 1 × Margarita · Strawberry $39, accepted 10:33, ready since 10:37) | **$175.67** | Next: Jae & co. · 5 at 11:00 PM. ID ✓ 5 of 5 |
| Room 4 (3–6) | **Out of service** | — | — | — | — | — | — | "Mic dead since Tue. Replacement ordered." (fault logged Tue Sep 22) |
| Room 5 (3–6) | In room · 79 min left | Leo M. · 4 (walk-in, seated from the waitlist at 10:00) | walk-in, 2 hr, until 12:00 AM · no deposit | 41 min | $40.00 (first-hour minimum) | $0 | **$40.00** | 4 × Bud Light $32 **ringing 2:11**. ID ✓ 4 of 4 |
| Room 6 (6–12) | Needs a wipe · left 10:33 PM (8 min) | (Ella S. · 8, paid and left) | — | — | — | — | — | Nothing booked tonight. Note: "TV remote goes missing. Check under the couch." |
| Room 7 (6–12) | **Needed now · 11 min past** | Rob & Kim · 7 | 8:30–10:30 PM · $70 deposit | 131 min | $152.83 | $58.00 (Small bucket $40; 2 × Lemon Drop shot $18) | **$210.83** | Next: **The Parks · 8 at 11:00 PM** (booked into Room 7) |
| Room 8 (6–12) | Open · next 11:00 | — | The Nguyens · 6 · 11:00 PM–1:00 AM · $60 deposit | — | — | — | — | Not free for an hour, so no waitlist offer |
| Room 9 (6–12) | In room · 19 min left | **Marcus T. · 12** | 8:00–11:00 PM · $120 deposit (Amex ··1005) | 161 min | $322.00 (161 min × $2.00) | $158.00 (Large bucket $70; 2 × Chamisul Fresh $40; 4 × Jäger Bomb $48) | **$480.00** | 2 × Margarita · Peach $26 **ringing 0:43** (not on the tab). Called staff 2 min ago: "Another mic, please". Code KX4M7, host lock off. Nothing booked next, so he may stay by the minute. ID ✓ 12 of 12 |
| Room 10 (6–12) | Staying · 41 min past | Tanya W. · 9 | 7:00–10:00 PM · $90 deposit | 221 min | $331.50 | $110.00 (Large bucket $70; 2 × Chamisul Fresh $40) | **$441.50** | Nothing booked next, so she stays by the minute. ID ✓ 9 of 9 |
| Room 11 (12–20) | Open · free all night | — | nothing tonight | — | — | — | — | The waitlist offer goes here (see 3c) |
| Room 12 (12–20) | In room · 79 min left | Omar F. · 14 | 9:00 PM–12:00 AM · $140 deposit (Visa ··6630) | 101 min | $235.67 | $70.00 (2 soju + small bucket) | **$305.67** | ID ✓ 14 of 14 |
| Room 13 (12–20) | Needs a wipe · left 10:36 PM (5 min) | (Yuki H. · 12, paid and left) | — | — | — | — | — | Nothing booked tonight |
| VIP room (20–40) | In room · 109 min left | Bianca L. · 22 (birthday) | 9:30 PM–12:30 AM · $250 deposit (Visa ··2290) | 71 min | $295.83 ($250/hr by the minute) | $480.00 (Hennessy · bottle $300; Moët & Chandon · bottle $180) | **$775.83** | "Cake at 11:00, in the fridge behind the bar." ID ✓ 22 of 22 |

**Counts:**

- **Rooms:** 8 in use (1, 3, 5, 7, 9, 10, 12, VIP), 3 open (2 held, 8 booked at 11:00, 11 free), 2 cleaning (6, 13) and 1 out of service (4).
- **People inside now:** 98 in total. 77 are in rooms. The other 21 are at the bar: 5 on bar tabs plus the 16 waitlist guests.
- **Occupancy limit:** West 4 hasn't entered one, so screens show "Limit not set · Admin → Safety". Don't invent a number. The 90% warning appears only in a demo toggle with a made-up limit, labelled "Demo".

### 3b. Bookings tonight (DeskCalendar, the phone's Calendar and Staff → Tonight all list exactly these)

| Time | Guest | Party | Room | Length | Deposit | Status at 10:41 |
|---|---|---|---|---|---|---|
| 7:00 PM | Tanya W. | 9 | Room 10 | 3 hr | $90 | Seated · staying past 10:00 |
| 8:00 PM | Marcus T. | 12 | Room 9 | 3 hr | $120 | Seated |
| 8:30 PM | Rob & Kim | 7 | Room 7 | 2 hr | $70 | Seated · 11 min past, and the Parks are next |
| 8:45 PM | Priya R. | 5 | Room 3 | 2 hr | $50 | Seated |
| 9:00 PM | Omar F. | 14 | Room 12 | 3 hr | $140 | Seated |
| 9:30 PM | Dana K. | 4 | Room 1 | 2 hr | $40 | Seated |
| 9:30 PM | Bianca L. (birthday) | 22 | VIP room | 3 hr | $250 | Seated · big party |
| 10:30 PM | Sam O. | 3 (bills as 4) | Room 2 | 1 hr | $40 | Late · "running 15 late" · held until 10:45 |
| 11:00 PM | Jae & co. | 5 | Room 3 | 2 hr | $50 | Booked |
| 11:00 PM | The Parks | 8 | Room 7 | 2 hr | $80 | Booked |
| 11:00 PM | The Nguyens | 6 | Room 8 | 2 hr | $60 | Booked |

Leo M. (Room 5) is a walk-in, not a booking. Earlier tonight, Ella S. (8, Room 6) and Yuki H. (12, Room 13) came and paid; show them only where earlier sessions are listed. **Manage.dc.html's demo booking is Jae & co.:** 5 guests, Fri Sep 25, 11:00 PM, 2 hr, Room 3 (medium tier), $50 deposit paid Wed.

### 3c. Waitlist at 10:41

| # | Party | Joined | Quoted | Note |
|---|---|---|---|---|
| 1 | Amara B. · 7 | 10:15 PM (26 min) | 25 min | at the bar |
| 2 | Nadia K. · 6 | 10:21 PM (20 min) | 20 min | (renamed from "Priya K." so it can't be confused with Priya R.) |
| 3 | Chris P. · 3 (bills as 4 on Friday) | 10:37 PM (4 min) | 40 min | |

- **Offer suggested now:** Room 11 (12–20) is free all night, and no booking tonight needs it, so it can go to a smaller party. It goes to **Amara B. (7)**, who is first. The offer holds the room for 10 minutes, texts her and shows a countdown. If the text fails: "Not delivered · Call".
- Room 6, once wiped, goes to **Nadia K. (6)**. Room 13, once wiped, goes to **Chris P. (3)**; it's big for them, but nothing else is free for an hour.
- **Guest waitlist page demo:** the guest joins as the 4th party (party of 4), and the page says "3 parties ahead". The "room ready" demo says **"Room 2 is ready · 10:00 to claim it"**, because Sam O. no-showed at 10:45.

### 3d. Board alerts at 10:41, most urgent first

1. **Pink** · Room 7 is 11 min past its time, and the Parks (8) are booked into Room 7 at 11:00. Actions: [Text Rob & Kim: please wrap up] [Move a room…]. The Move sheet lists Room 11 as free all night.
2. **Pink** · Room 9 called for another mic, 2 min ago. Action: [On it].
3. **Amber** · Room 5's order has been ringing 2:11 (4 × Bud Light). Action: [Show]. This is the 2-minute escalation, F36.
4. **Amber** · Room 3: 4 min left, and Jae & co. are booked at 11:00. Action: [Text Priya: please wrap up].
5. **Lime** · Room 11 is free all night, and Amara B. (7) has waited 26 min. Action: [Offer Room 11 · 10 min to claim].
6. **Grey** · Rooms 6 and 13 need a wipe (8 and 5 min), and Nadia K. and Chris P. are waiting. Action: [Show].
7. **Grey** · Sam O. texted "running 15 late" for the 10:30 in Room 2, and it's held until 10:45. Actions: [Reply "no problem"] [Check in] [Mark no-show].

The badge reads **"Bar orders · 2"**, which counts every ringing and asked-to-wait order.

### 3e. Room orders (Bar, Rail, Staff runs, Board and Order all show these)

| Order | Room | Items | Amount | Status at 10:41 | IDs |
|---|---|---|---|---|---|
| o1 | Room 9 | 2 × Margarita · Peach | $26 | Ringing 0:43 | ID ✓ 12 of 12 |
| o2 | Room 5 | 4 × Bud Light | $32 | Ringing 2:11 (amber) | ID ✓ 4 of 4 |
| o3 | Room 3 | 2 × Margarita · Peach, 1 × Margarita · Strawberry | $39 | Ready for a runner · 4:00 (accepted 10:33 by Maya, ready 10:37) | ID ✓ 5 of 5 |
| o4 | Room 1 | 4 × Corona | $36 | Ready for a runner · 1:35 (accepted 10:38 by Maya, ready 10:39) | ID ✓ 3 of 4 · runner checks the last ID |
| earlier | VIP room | Moët & Chandon · bottle | $180 | Delivered 10:05 PM by Andy | |
| earlier | Room 9 | 4 × Jäger Bomb | $48 | Delivered 9:58 PM by Diego | |

Nothing has been returned tonight. Give the Returned list a "Demo: a runner brings one back" control. Anything accepted is on the tab: **the sale happens at Accept**, and Delivered doesn't charge.

### 3f. Bar tabs (Rail, and Night's per-person demo)

The Rail keeps its current five tabs: t4 Hana K. (cut off by Andy at 10:30 PM), t1 Jess P. (Visa ··4417), t2 Luis M. (hold grew to $80), t5 Tariq A. (Diego's, void waiting for Andy) and t3 Seat 6 · blue jacket (Diego's). The Rail also lists these room tabs:

- r9 Room 9: 161 min, $322.00, deposit $120, opened 8:00 PM.
- r12 Room 12: Omar F. · 14, opened **9:00 PM**, 101 min, **$235.67**, deposit $140.
- r14 VIP room: Bianca L. · 22, opened 9:30 PM, 71 min, **$295.83** (in cents, not $296), deposit $250.

The Rail may list more room tabs. If it does, use 3a's numbers.

The staff phone's Tips to enter holds three paper slips: Dev S. (Visa ··3318), Tom W. (Mastercard ··0457) and Ana R. (Amex ··2204). Jess P.'s card number must not appear there. Night lists the same three: "3 slips not entered · tips post to Sat Sep 26".

### 3g. Cash drawers and devices at West 4

- **Two drawers**, each run as a **house drawer** (the manager on duty answers for it):
  - **Bar drawer:** on the bar receipt printer's kick port.
  - **Front-desk drawer:** on the front-desk printer.
- Cash from a sale goes into the drawer at the screen where it's taken. The log names who took it: "Logged to Maya · bar drawer".
- Admin → Cash drawers can switch to **a drawer per person**. The Board and Night keep their demo link for that model.
- Night counts both drawers blind.
- **Devices:**
  - **Bar:** the bar computer (bar POS and bar orders screen), a USB NFC badge reader, a receipt printer with the bar drawer, and a **Stripe Reader S710 (bar), installed and online**.
  - **Front desk:** the desktop app computer (Board, DeskRoom and the rest), a USB NFC badge reader, a receipt printer with the front-desk drawer, and a **Stripe Reader S710 (front desk)**.
  - **Around the venue:** 14 room tablets (13 online; Room 4's is off because the room is out of service), 1 Up next TV at the bar, and a dual-WAN router with a cellular backup (**"Backup internet · on"**).
  - **Badges:** NTAG 424 DNA badges for Abhishek, Andy, Maya and Diego.
- The Console shows the same facts: 13 of 14 room tablets online, both readers online, backup internet on.

### 3h. Bar-mode singer queue at 10:41 (KJ, SingQueue, UpNext and the Rail all show these)

Bar mode started at 9:00 PM, and 23 songs have been sung so far. It's round 3, with a limit of 1 song per singer per round.

- **Now singing:** Luis M. · "Mr. Brightside" · The Killers. Maya started it at 10:39 PM. It used a drink credit, so a $0.00 song line is on his tab (t2).
- **Up next,** in order (the Rail header reads "Song queue · 6"):
  1. Jess P. · "Dancing Queen" · ABBA · tab t1 · 1 credit
  2. Kira · "Valerie" · Amy Winehouse · no tab · 1 credit (she bought a drink at the bar)
  3. **Ben T.** · "Livin' on a Prayer" · Bon Jovi · no tab · 1 credit. **He is the SingQueue phone demo's guest:** "2 singers before you".
  4. Tariq A. · "Sweet Caroline" · Neil Diamond · tab t5 · 2 credits
  5. Hana K. · "Someone Like You" · Adele · tab t4 (cut off from alcohol; singing is fine) · 1 credit
  6. Sofia R. · "Bohemian Rhapsody" · Queen · no tab · 0 credits, flagged "Needs a drink credit"
- The TV never shows phone numbers.

### 3i. Automatic texts (Admin → Texts, DeskMessages and phone Messages all list exactly these 14)

**Service texts (12):**

1. **Booking confirmed** · right away · "Booked. Room for 6 at 9:30 PM, Sat Sep 26. A 20% gratuity is added to room tabs. Deposit $60 paid, comes off your bill. Free to cancel until Fri 9:30 PM: west4karaoke.com/b/…"
2. **Reminder** · afternoon of
3. **Room code** · at check-in
4. **Room ready** · when staff offer a room · "Your room is ready: Room 11. You have 10 minutes to claim it at the front desk."
5. **Offer expiring** · 5 min left
6. **Please wrap up** · someone booked next, 10 min before end
7. **Booked time ending** · 10 min before end · "…Nobody's booked after you, so you can stay on by the minute until we close at 4 AM."
8. **Receipt** · after paying
9. **Deposit refund**
10. **Payment link**
11. **Running late reply**
12. **You're up next** (bar mode) · when 1 singer is ahead · "You're up next at the bar. Come to the stage when this song ends."

**Marketing texts (2), both off until they have their own opt-in:** 13. Review ask, 14. Birthday.

"The bar needs a few minutes" and "On its way" are **room-screen messages**, not texts.

## 4. Canonical flows and words

### 4.1 Room order pipeline (F1, F2): one set of words on every screen

**Staff screens (Bar, Rail, Staff runs, Board):**

1. **Ringing · 0:43.** Buttons: [Accept · print ticket] [Ask the room to wait] [Decline…].
2. **Asked to wait · 1:20.** The order stays in "Waiting for you", keeps aging and still needs Accept. It can never go to Ready or Delivered before it's accepted.
3. **Being made.** "Accepted by Maya · 10:33 · on Room 9's tab · ticket printed". Accept is the sale, and the order joins the check at that moment. Button: [Ready].
4. **Ready for a runner · 4:00.** It appears on every staff phone's Runs, and the runner taps [I've got it].
5. **On its way · Andy.** Buttons: [Delivered] [Couldn't serve…].
6. **Delivered · 10:52 · Andy.**

**Side exits:**

- **Returned.** Shows "Couldn't serve: <reason> · Andy". The bar chooses [Void · not made], [Void · made (waste)] or [Remake]. The manager on duty sees the reason. For "Someone looks too drunk", the return offers [Cut off Room 9?].
- **Cancelled by the guest.** Only while it's ringing or asked to wait. Nothing is charged.
- **Declined by the bar.** A reason is required, and the guest sees it.
- **Cancelled at 4:00 AM.** Covers alcohol orders nobody accepted, cancelled automatically. There is **no Decline button** after 4 AM; the order just shows as cancelled.

**The guest's phone (Order):**

- Main path: **Sent to the bar · you can still cancel** → *(asked to wait)* **The bar needs a few minutes** → **Being made · on your tab** → **On its way to Room 9** → **Delivered**.
- Side messages:
  - "Your server will come by" (returned)
  - "The bar couldn't take this order · nothing charged" (declined)
  - "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged"
  - "Your server has paused alcohol for this room" (cut off)

**Spec names:**

- `orders.status`: `ringing, held, accepted, ready, on_the_way, delivered, returned, cancelled`.
- `cancel_reason`: `guest, staff, declined, alcohol_closed, cut_off`.
- `ready` replaces the old `sent`. `claimed_by` and `claimed_at` go with `on_the_way`.

**Escalation.** Use this exact sentence wherever escalation is described: **"Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup."** The Board gets an alert at 2 min. At 4 min it says "on Andy's phone", and at 6 min "texted Andy".

**Print failure.** "Ticket didn't print · Reprint" on Bar and Rail. The reprint prints "REPRINT 2".

### 4.2 Check-in (F3), on the Board and the phone

The check-in sheet is the same on both surfaces:

1. **Party size**, with the billable minimum shown ("3 guests · Fridays bill at least 4").
2. **IDs checked**: "x of n", plus "The runner checks the rest".
3. **Room**, confirmed or changed.
4. **Start the clock**: now, or at the booked time.
5. **Deposit applied** (−$40).
6. **Room code sent**: a new 5-character code for the room, texted to the host with the join link.

The sheet calls `POST /bookings/{b}/check-in {party_size, ids_checked, room_id, start_at}`.

- On the Board, "Arriving" and "Late" bookings show on their room's tile or in the room panel, with [Check in] and [Mark no-show] (no-show is allowed after the 15-minute grace).
- **Walk-in with no wait:** [+ Walk-in] opens the same sheet with a free room.

### 4.3 Waitlist (F4)

The Board's waitlist drawer opens from "Waitlist · 3". The phone's Waitlist tab has the same content.

1. Each row shows the party size, joined time, quote and wait. [Offer a room] picks the smallest room that fits and is free for an hour. If only a bigger room is free, it can offer that, as long as no booking tonight needs it.
2. The offer holds the room for 10 minutes and texts "Your room is ready: Room 11. Come to the front desk within 10 minutes." It shows a countdown. If the text fails: "Not delivered · Call (212)…".
3. When the party arrives, [Seat] opens check-in (4.2) in the held room.
4. If the offer expires, the room is released and offered to the next party that fits.
5. [Remove] and [Text] are also available on each row.

### 4.4 Room move (F22) and party size (F23)

**Move sheet** (Board, DeskRoom and phone):

- Lists only the rooms that fit the party and are free for the time needed, with their free-until time. Occupied rooms and rooms that are too small are greyed out, with the reason.
- Moving opens a new clock segment in the new room and issues a new room code. The guests' phones show "You've moved to Room 11 · new code …".
- The old room goes to cleaning.

**Party size +/−** (DeskRoom, Room, Board panel and phone):

- Shows the new hourly rate and the billable minimum.
- The change closes the current clock segment.
- Lowering it after gratuity applies needs approval.
- The "ID ✓ x of n" chip updates to the new size.

### 4.5 Room close-out (F13–F16, F47, K2), on DeskRoom and the Room phone

1. **[Present the check].** Finalizes the check (Room 9's is **#1042**) and locks ordering from the room. The guests' phones show "Your bill is ready · ordering is closed", with the bill link.
   - If any order is ringing or asked to wait, it's listed first: "2 × Margarita · Peach is ringing at the bar · accept or cancel it first".
   - A manager can [Reopen the check].
2. **Ways to pay**, which can be mixed:
   - **Tap on a reader.** Pick the reader (Front desk S710 or Bar S710). States: "Waiting for a tap on the front-desk reader · Cancel" → **Paid**, or **Declined · try another card or cash**, or **Checking with Stripe · don't retry** (status unknown), or **Reader offline · use the bar reader**, or **Reader busy**. Room checks carry the 20% gratuity, so the reader skips its tip screen.
   - **Card on file** (Amex ··1005). Shows "Waiting for Marcus to confirm on his phone · Cancel". If the guest has left, "Ask a manager to approve" instead.
   - **Cash.** Use the Rail's cash panel: amount handed over (Exact, next $5, $10, $20, Other), change due in large type, "Wrong amount? Fix the change" and a cash-tip field.
   - **Split,** even or by item. Each share has its own method and state, and shares are kept when you leave the screen. Leftover cents go to the first shares, by largest remainder.
   - **Guests pay their own shares from their phones** ("Pay my share", K2). Payments appear as lines, for example "Paid by a guest · Kevin (share 1 of 12) $41.55", which is $498.60 ÷ 12. The booker's card still guarantees the rest.
3. **"Additional tip (optional)"** line, entered by staff, cash or card. The receipt prints "Gratuity included (20%)".
4. **Paid in full → receipt:** [Text] [Email] [Print] [No receipt]. Then "Room 9 goes to cleaning". This is blocked while any order on the room is ringing, asked to wait or unpaid. An order accepted after the check is paid opens a new check.

**Room 9's worked numbers** (unchanged):

| Line | Amount |
|---|---|
| Room time · 161 min × $2.00 | $322.00 |
| Drinks | $158.00 |
| Tax | $42.60 |
| Gratuity (20%) | $96.00 |
| **Total** | **$618.60** |
| Deposit | −$120.00 |
| **Left to pay** | **$498.60** |

If the ringing 2 × Margarita · Peach is accepted before the check is presented, it adds $26 of drinks, plus its tax and gratuity.

### 4.6 Comps, voids, refunds (F8, F11, C15, C16)

- **Comp, void or move sheet.** It's the Rail's fix panel, used on every screen: Made or not made, a reason, and "$X left this shift". It follows the limits in section 2. A void is labelled **VOID**, and a comp **COMP**.
- **Refund from check.** Pick a paid check, then lines, then which payment to refund, then a reason, then [Send to Abhishek] (because Andy asked). The request shows **Refund pending** until Stripe confirms, then **Refunded**. The amount can never exceed what was captured on that payment minus earlier refunds. Marcus has only his $120 deposit captured tonight, so his cap is $120.
- Refunds are offered on the phone (from the booking), on DeskRoom (a paid check) and on the Rail (Closed tonight).

### 4.7 Cut-off and the 4 AM stop (F19, F20, C4, C5)

- **Where the "Cut off" control lives:** the Rail's tab, and on rooms the Board tile panel, DeskRoom and the Room phone ("No more alcohol for this room"). It records who, the reason and the time, and logs a refusal.
- **How a cut-off shows:**
  - Every screen for that tab or room shows "Cut off by Andy at 10:30 PM".
  - Alcohol is greyed out there.
  - Moves onto a cut-off tab are refused for alcohol, with the reason.
  - Order hides alcohol and shows "Your server has paused alcohol for this room".
- **At 4:00 AM:**
  - Every alcohol button greys out on every screen.
  - Unaccepted alcohol orders are cancelled automatically with a message to the room (no Decline button).
  - Order shows "The bar stopped serving alcohol at 4 AM".
  - The bar orders screen lists "Cancelled at 4:00 AM".
- **Clear-out check at 4:30 AM** (Board and Night): "Walk every room and the bar · no drinks left out" → [Done] records "Clear-out check · Andy · 4:31 AM".

### 4.8 Bar tabs (F9, F10, F18, F19, C14, C30)

- **Opening consent.** The New tab panel shows a line for the bartender to read before the tap: **"We'll hold $50 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader."** Beside it is [Read to guest ✓], which records who read it. The tab slip prints the same line.
- **Split.** A split survives leaving the pay panel and switching tabs. The tab list shows "Partly paid · $16.33 of $32.66", and the next charge is the rest. Amounts are worked in cents: $32.66 ÷ 2 = $16.33 + $16.33 (for an odd amount, the first share gets the extra cent). A share can be paid in cash. [Stop splitting · charge the rest to …] ends the split.
- **Reopening** a captured tab. There's no hold chip ("Paid $272.19 · no hold"), and no "Close to card". New drinks are paid by a new tap, by cash, or by [Charge the saved card], which needs the guest's confirmation or a manager's OK. With $0 due, no pay buttons show.
- **[Move tab to a room].** Pick a room that's in use, and every line moves as a transfer. The tab closes as "Moved to Room 9", and its hold is released once the room has a payment method. The room's check shows "Moved from Jess P.'s bar tab" lines. A move runs the hold-raise check just as a send does, and alcohol can't move onto a cut-off tab.

### 4.9 Offline and vendor outages (F12, C11)

Banners on the Board, Rail and Bar, each shown by a "Demo:" control:

- **Amber:** "On backup internet · card readers may take up to 2 min to switch".
- **Pink:** "Offline · read-only · orders queue with an offline code". In **queue mode**, the Rail marks rounds "queued · not charged".
- **After reconnect:** "Confirm replayed orders (3)", a list where each order lands as asked-to-wait and needs Accept.
- **Vendor banners:** "Stripe is having trouble · card payments may fail" and "Texts are delayed".
- The Board footer reads "Online · synced 4 s ago", not "works offline".
- **Night** gets "Review after outage", listing orders taken offline and their payments. It also gets a one-page **break-glass card**: take cards with Tap to Pay in Stripe's Dashboard app on the manager's phone, and they appear in "Unmatched payments" for matching.

### 4.10 Faults, damage, lost items, help alert, calls (F24–F26, F50, F51)

- **Report a fault** on the Board and DeskRoom. It's logged on the room. Options: mark the room **Out of service**, [Pause the clock] (needs approval) and [Comp 15 min of room time] (a reason-only comp). Open faults show on the tile.
- **Damage fee** ($150). It needs a photo (camera or upload) and a reason before it's added. The line shows the photo thumbnail. Never say "photo attached" unless a photo was taken.
- **Lost and found** (Board): "Found in Room 9 · kept at the bar · claimed by …".
- **Private help alert.**
  - The guest's "Need a manager, privately?" lands only on the managers' phones: room, time, [I'm on it] and notes that go to the incident log.
  - The Board shows a pin, **"Manager needed"**, with no room and no reason.
  - The manager's phone has an incident log.
- **Room calls** ("Another mic, please") go to the Board and to every staff phone's Calls list. The guest's copy: "Staff get it on their phones". Never "the bar screen lights up".

### 4.11 Bar mode (F6, C10, K6)

Bar mode is on at West 4. West 4's offer is **"Buy a drink, get a song"**: each drink bought earns one song credit, which posts as a $0.00 song line when the song starts. West 4 hasn't set a price for a song without a credit, so Admin shows "Song price · not set · songs need a drink credit".

- **Singers** join from their phones or at the bar, with a display name and a phone number confirmed once by a code. Songs rotate round-robin, one song per singer per round (the limit comes from Admin).
- **Staff** mark each song [Started] (this posts the song line to the singer's tab or uses a credit) or [Skip] (free, and a prepaid credit comes back). A staff override (move up or down) is logged with a reason.
- **Alerts** go out by push on the queue page and by service text:
  - "2 singers before you"
  - **"You're up next at the bar · come to the stage"**
- **Up next TV** at the bar shows now singing, the next 5 singers and a QR code to join.
- **KJ songbook:** upload a CSV (title, artist, code). West 4's Playbox catalog comes from Playbox or West 4, never scraped.
- **Send the singer a drink:** a gift order that rings the bar. It checks the alcohol window and the receiving tab, and ID is checked at hand-off.

### 4.12 Guest extras in phase 1 (K2, K16, K4)

- **Pay my share** on the guest's room page: "My items" or "An even share (1 of N)". It shows the guest's share of tax and gratuity, and they pay by Apple Pay, Google Pay or card. It's a venue setting (on at West 4).
- **Same again** on the room page: the room's last delivered rounds. One tap re-orders, and the order still rings the bar.
- **Minimum spend:** set per room size and day in Admin → Hours & prices. **It's off at West 4.** Where a minimum is set, the tile, DeskRoom and the room page show "$84 to your minimum". West 4 screens show nothing for it; Admin shows the off setting.

### 4.13 Clock-in and clock-out (F29)

- **Clock-in** asks for the duty (Bar, Front desk, Runner, Manager). The tip pool uses it.
- **Clock-out checklist:**
  - Hand over open tabs (Maya has 3) and unsent drinks.
  - Cash drop, or count your bank (per-person model only).
  - Declare cash tips.
- The bar POS shows "Maya · on break" while she's on break.

### 4.14 Training mode (F39)

- **Admin → Team → Training mode** (per person, or per device for a new hire).
- When it's on, the Rail, Board and Room show a permanent band, **"TRAINING · not real money"**, and check numbers start with T- ("T-0012").
- Each of those screens has a "Demo: training mode" toggle.

### 4.15 Languages (C9)

- Staff screens launch in **English and Spanish**.
- Each person picks theirs in Admin → Team (a Language column) and on their own Pin sign-in ("English · Español"). Nothing else needs translating on the canvas.
- Korean and Chinese are phase 2.

### 4.16 Modules (F37)

- **Dependencies:**
  - "Ordering from the room" needs "Bar screen & tickets".
  - Turning off "Bar screen & tickets" while "Ordering from the room" is on shows a confirm: "Room orders would have nowhere to ring. Turn off Ordering from the room too?"
- **Effects of switching off** (Admin shows a table of what each module hides):
  - Rail items, staff-phone tabs, website sections and texts.
  - When booking is off, the website hero's "Book a room" becomes "Call to book".

### 4.17 Vocabulary (F41, C24, C25)

| Replace | With |
|---|---|
| "Hold" for a room order | **"Ask the room to wait"** (the chip says "Asked to wait"). "Hold" now means only a card authorization. |
| "Last call" on Night (charging every tab) | **"Charge the remaining tabs"**. "Last call" is only the house last-call time in Admin. |
| "Close out" on the phone list | **"Tab & close out →"**. It opens the room tab and never marks a room paid by itself. |
| "Sent to room" | **"Ready"** (the button) and **"Ready for a runner"** (the column) |
| "Back to the tab" on a quick sale | "Back to the sale" |
| "COMP · void" | "VOID" or "COMP" |
| "Lock the iPad" | "Lock" |
| "their tablet explains" | "their phones explain" |
| "Bar accepted" (guest) | "Being made" |
| "Stay as long as you like" | **"Stay on by the minute until we close at 4 AM"** |
| name-and-PIN wording | **"badge or name and PIN"** |
| "Refunds, cash counts and Admin ask for the PIN again" | "Refunds, cash counts and no-sale ask for the PIN again; Admin needs a passkey" |

Other copy rules:

- Prices on the site read "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour".
- Admin's "Ring the bar until someone accepts" alarm toggle is removed. It's replaced by the aging times, the chime and Mute.

### 4.18 Close the night (F30, F31, F42), in Night.dc.html

**Checks before closing,** each with a link to fix it:

- Staff still on the clock
- Open waitlist entries
- Ringing or asked-to-wait orders
- Pending approvals
- Rooms still cleaning
- Unsent drinks
- The clear-out check (4:30 AM)
- Paper slips not entered: "3 slips not entered · tips post to Sat Sep 26"
- Both drawers counted

**Sales and gratuity on the Z report:**

- Split Drinks into **Room checks** and **Bar tabs**.
- Take the gratuity from room checks only: 20% of (room time + room drinks + packages sold to rooms − room comps and refunds).
- "Print Z report" appears only after the night is closed. Before that it's "Print X report (running)".
- The log is in time order, and it agrees with the Board: Room 4 out of service since Tue.

## 5. New boards (file names, fixed now so everyone can link to them)

| File | Canvas title | Size | Built by | Linked from |
|---|---|---|---|---|
| `SingQueue.dc.html` | A · Bar mode · singer's phone | 390 × 1180 | Worker 9 | Main ("Sing at the bar"), the Up next TV's QR code |
| `UpNext.dc.html` | D · Up next TV at the bar | 1280 × 720 | Worker 9 | KJ |
| `Receipt.dc.html` | M · Receipts · printed and web | 390 × 1400 | Worker 9 | DeskRoom, Room and Rail receipt choices |
| `KJ.dc.html` | D · Desktop app · Song queue (bar mode) | 1280 × 800 | Worker 8 | The Rail's header ("Song queue · 6"), Bar and the desktop side menus |

- The guest's join flow, "Your bill" and Pay my share all live **inside Order.dc.html** as states.
- Book's details, consent, payment and confirmation states live **inside Book.dc.html**.

## 6. Rules for every worker

1. **Edit only your own files.** Never edit canvas.json, never publish, never touch another worker's files. Before your first edit, back up each file to `w4/build/<Name>.before8.html`.
2. **Follow the .dc.html format:**
   - `{{holes}}` are plain lookups: compute everything in `renderVals()`.
   - Use `<sc-if value>` and `<sc-for list as>`.
   - Events are `onClick="{{fn}}"`.
   - Links are plain `<a href="Other.dc.html">`.
   - No imports.
   - Keep the look: colors, fonts and the left rail copied from Board.
   - Desktop screens are 1280 × 800 with a fixed root; scroll inside panels, never the page. Phones are 390 wide and fluid.
   - Every setting a screen reads sits at the top of its script with the comment "// Comes from Admin → <section>. In the app every screen reads the same saved setting."
3. **Real facts only.** Use this brief's seed for demo names and numbers. Anything that is demo-only must say "Demo:" on its control.
4. **Check your work:**
   - Run `cd w4/project && node ../check.js <File>.dc.html` and get it to "ok" with nothing "maybe-missing" that matters.
   - Copy the file into `w4/render/`. The server is at http://127.0.0.1:8765/; if it's down, restart it with `cd w4/render && (setsid nohup python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &)`.
   - Screenshot each new state with `cd w4 && python3 build/shots.py <File>.dc.html W H <scenarios.json>`. Name your screenshot files with your worker prefix, and **look at every one**. Fix overlaps, wrapping buttons, cut-off text, content under sticky bars, and anything that overflows 800 px on desktop or scrolls sideways at 390 px.
   - Run `python3 review/fuzz1.py <File>.dc.html W H 30 40` and get it to 0 runs with errors.
   - Click through every flow you changed, end to end.
5. **Finish with a short report:**
   - Per file: the findings fixed (by ID), with one line each on what now happens.
   - Anything you couldn't do or deliberately left out.
   - Any strings or links another screen must match.
