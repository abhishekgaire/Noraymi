# Demo seed

The one Friday that every screen, every staging environment and every end-to-end test shows: West 4 Boho Karaoke, 186 W 4th St, New York, at **10:41 PM on Fri Sep 25, 2026**. The [milestones](milestones.md) and the [spec](spec/README.md) use its names and amounts in their checks, so a screen or a test that shows anything else is wrong.

- **Two files hold it as data.** [`seed/west4-friday.json`](../seed/west4-friday.json) is the whole Friday: staging loads it, and the end-to-end tests use it as their fixture. [`seed/money-cases.json`](../seed/money-cases.json) is 104 test vectors for the pricing module, worked from this Friday. This page tells the story. The page and the two files must say the same thing, so change them together.
- **Where it came from.** Sections 3 and 4.5 of the Sep 28 [fix brief](archive/fix-brief-sep28.md) (kept as history), cleaned up and checked against [Money rules](spec/05-money-rules.md). Where the brief and the spec differ, the spec wins.
- **The boards are frozen, and some show older numbers.** [Where the frozen canvas differs](#where-the-frozen-canvas-differs) lists them, and [screens](screens.md) says what to build on each board.

On this page: [Now](#now) · [Counts](#counts-at-1041-pm) · [West 4 and its rules](#west-4-and-its-rules) · [The team](#the-team-tonight) · [Rooms](#rooms-at-1041-pm) · [Bookings](#bookings-tonight) · [Waitlist](#waitlist) · [Board alerts](#board-alerts) · [Room orders](#room-orders) · [Bar tabs](#bar-tabs-room-tabs-and-paper-slips) · [Drawers and devices](#cash-drawers-and-devices) · [Singer queue](#the-singer-queue) · [Texts](#texts-and-the-inbox) · [Room 9](#room-9-worked-through) · [Later tonight](#later-tonight) · [Things to try](#things-to-try) · [Canvas differences](#where-the-frozen-canvas-differs) · [Loading](#loading-the-seed) · [Open points](#open-points)

## Now

| What | Value |
| --- | --- |
| Now | Fri Sep 25, 2026, 10:41 PM, America/New_York (EDT, UTC-4) |
| Business date | Fri Sep 25, 2026: local time minus the 6:00 AM cutover |
| Later tonight | Sat Sep 26, 4:12 AM, still business date Fri Sep 25 |
| The Rail's late demo | Sat Sep 26, 4:02 AM, business date Fri Sep 25 |
| Alcohol stops | 4:00 AM |
| Clear-out check and tab cut-off | 4:30 AM (close plus 30 minutes of drinking-up) |

- Every screen reads this time. None reads the device clock for the date or the time. A page may tick its seconds after it loads, counting from 10:41 PM.
- Staging and the end-to-end tests run on a simulated clock set to 10:41:00 PM, and move it to 4:00, 4:12 and 4:30 AM. Ages such as "Ringing · 2:11" come from that clock.
- Close the night is the one screen that shows a later time. See [Later tonight](#later-tonight).

## Counts at 10:41 PM

| What | Count |
| --- | --- |
| Rooms | 8 in use (1, 3, 5, 7, 9, 10, 12, VIP), 3 open (2 held, 8 booked at 11:00, 11 free), 2 cleaning (6, 13), 1 out of service (4) |
| People inside | 98: 77 in rooms, 5 on bar tabs, 16 waiting |
| Occupancy limit | Not set. Screens show "Limit not set · Admin → Safety". Never invent a number. The 90% warning shows only in a demo toggle with a made-up limit, labeled "Demo". |
| Waitlist | 3 parties (16 people) |
| Bar orders badge | "Bar orders · 2", counting every ringing and asked-to-wait order |
| Room tablets | 13 of 14 online (Room 4's is off) |
| Bar tabs open | 5 |
| Songs | 23 sung so far, round 3, 6 in the queue |
| Approvals waiting | 1 (Diego's void, for Andy) |
| Paper tip slips to enter | 3 |

## West 4 and its rules

| Setting | Value |
| --- | --- |
| Venue | West 4 Boho Karaoke, 186 W 4th St, New York, NY. Time zone America/New_York. The business day turns at 6:00 AM. |
| Hours | Mon to Fri 4:00 PM to 4:00 AM, Sat and Sun 2:00 PM to 4:00 AM. Only the 4 AM close is in the brief; the rest is the AdminDesk board's demo. |
| Rooms | 14. Rooms 1 to 5 fit 3 to 6, Rooms 6 to 10 fit 6 to 12, Rooms 11 to 13 fit 12 to 20, the VIP room fits 20 to 40. |
| Room rate | $10 a person an hour: a first-hour minimum, then by the minute. At least 3 guests are billed on weeknights and 4 on Friday and Saturday. The VIP room is a flat $250 an hour, from 20 guests. |
| Tax | 8.875% on room time, drinks and damage fees. |
| Gratuity | 20% on room checks only: before tax, never on damage fees. Bar tabs carry none and tip on the reader (18%, 20%, 22%). |
| Deposit | The first hour: $10 for each billable guest. From 20 guests, a flat $250. Refundable until 24 hours before. A no-show is allowed after a 15-minute grace. |
| Damage fee | $150, with a photo. |
| Bar tabs | A $50 opening hold that grows as rounds are sent. Any tab still open is charged at 4:30 AM. |
| Reason-only limit | Comps and voids of up to $25 each and $75 a shift per person need only a reason. Above that, a manager approves. |
| Order aging | Bar phones buzz at 30 s, amber at 2 min, pink at 4 min (the manager on duty is told), a text or call at 6 min. |
| Cash | Two house drawers, each opened with $300. |
| Bar mode | On. "Buy a drink, get a song". No song price is set. One song per singer per round. |
| Off at West 4 | Minimum spend, the card fee and the occupancy limit. |
| Modules | On (13): website, booking, waitlist, rooms, roomOrdering, barScreen, barTabs, barMode, packages, messages, team, safety, reports. Off (6): kitchen, songControl, marketing, events, crm, multiLocation. |
| Menu | 127 lines in 9 sections (Beer, Soju, Cocktails, Shots, Spirits, Wine, Soft drinks, Bottles, Buckets). Out tonight (86'd): Hoegaarden, Casamigos Blanco, Casamigos · bottle. |

Money rules for all of this are in [Money rules](spec/05-money-rules.md); every setting key is in [Settings, rule packs and modules](spec/03-settings-rule-packs-modules.md).

## The team tonight

| Person | Role | Tonight | Demo PIN | Notes |
| --- | --- | --- | --- | --- |
| Abhishek G. | Owner | Not on shift | `915204` | Approves Andy's own requests. |
| Andy C. | Manager (manager on duty) | On since 6:00 PM | `730915` | The staff-phone demo is Andy's phone. |
| Maya S. | Bartender | On since 4:00 PM | `4071` | Holds the open tabs of Hana K., Jess P. and Luis M. Has used $12 of her $75. |
| Diego R. | Front desk | On since 7:00 PM | `6358` | Covers the bar when Maya is on break. Holds Tariq A.'s and Seat 6's tabs. Was "Staff" on the old boards. |

Everyone has a paired phone and an NTAG 424 DNA badge. Managers and owners use 6-digit PINs, everyone else 4. **The PINs are demo only.** They are for staging and the boards. Never load them into production, where each person picks their own. The default permission table is in [Tenancy and access](spec/02-tenancy-access.md); the seed loads it as `role_permissions`.

**Approvals and limits tonight**

- Comps and voids up to $25 each and $75 a shift per person need only a reason. The shift total counts every screen. Maya has used $12 of her $75. Diego has used $0.
- Over the limit, a manager approves on **their own phone**, never on the requester's device. Nobody approves their own request, so Andy's go to Abhishek.
- **Pending now: one approval.** Diego's void of 1 × Large bucket · 10 beers ($70.00) on Tariq A.'s tab, reason "rang it wrong". It is over $25, so it goes to Andy. Diego's screen shows "Waiting for Andy", and Andy's phone shows "Approvals · 1" with the line, amount, reason, who asked and when.
- A tip over 25% on a paper slip goes to Andy, or to Abhishek if Andy entered the slip.

## Rooms at 10:41 PM

**Room time so far** is billable guests × $10 ÷ 60 × minutes, never less than the first hour, rounded once to the cent. **Tab so far** is room time plus the drinks accepted so far, before tax and gratuity. A drink counts once it is accepted, so a ringing order is not on the tab. Billable guests are the larger of the party and the minimum (4 on Friday). The VIP room is $250 an hour flat.

**Who is where**

| Room | Fits | Board says | Party | Booked | Notes |
| --- | --- | --- | --- | --- | --- |
| Room 1 | 3–6 | In room · 49 min left | Dana K. · 4 | 9:30–11:30 PM · $40.00 deposit | ID ✓ 3 of 4. The runner checks the last ID. |
| Room 2 | 3–6 | Open · **held for Sam O. until 10:45** | Sam O. · 3 (bills as 4) | 10:30–11:30 PM · $40.00 deposit | Sam texted "running 15 late" at 10:24 PM. Check him in, or Mark no-show at 10:45. |
| Room 3 | 3–6 | Wrap up · 4 min left | Priya R. · 5 | 8:45–10:45 PM · $50.00 deposit | Next: Jae & co. · 5 at 11:00 PM. ID ✓ 5 of 5. |
| Room 4 | 3–6 | **Out of service** | none | none | "Mic dead since Tue. Replacement ordered." The fault was logged Tue Sep 22. |
| Room 5 | 3–6 | In room · 79 min left | Leo M. · 4 | Walk-in · 2 hr, until 12:00 AM · no deposit | Seated from the waitlist at 10:00 PM. 4 × Bud Light $32.00 is ringing (2:11). ID ✓ 4 of 4. |
| Room 6 | 6–12 | Needs a wipe · left 10:33 PM (8 min) | (Ella S. · 8, paid and left) | none | Note: "TV remote goes missing. Check under the couch." Goes to Nadia K. (6) once wiped. |
| Room 7 | 6–12 | **Needed now · 11 min past** | Rob & Kim · 7 | 8:30–10:30 PM · $70.00 deposit | Next: The Parks · 8 at 11:00 PM, booked into Room 7. ID count not in the brief. |
| Room 8 | 6–12 | Open · next 11:00 | none | The Nguyens · 6 · 11:00 PM–1:00 AM · $60.00 deposit | Not free for an hour, so no waitlist offer. |
| Room 9 | 6–12 | In room · 19 min left | Marcus T. · 12 | 8:00–11:00 PM · $120.00 deposit (Amex ··1005) | 2 × Margarita · Peach $26.00 is ringing (0:43) and not on the tab. Called staff 2 min ago: "Another mic, please". Code KX4M7, host lock off. Nothing is booked next, so he may stay on by the minute. ID ✓ 12 of 12. |
| Room 10 | 6–12 | Staying · 41 min past | Tanya W. · 9 | 7:00–10:00 PM · $90.00 deposit | Nothing is booked next, so she stays on by the minute. ID ✓ 9 of 9. |
| Room 11 | 12–20 | Open · free all night | none | none | Free all night, and no booking tonight needs it. The waitlist offer goes here. |
| Room 12 | 12–20 | In room · 79 min left | Omar F. · 14 | 9:00 PM–12:00 AM · $140.00 deposit (Visa ··6630) | ID ✓ 14 of 14. |
| Room 13 | 12–20 | Needs a wipe · left 10:36 PM (5 min) | (Yuki H. · 12, paid and left) | none | Goes to Chris P. (3) once wiped. |
| VIP room | 20–40 | In room · 109 min left | Bianca L. · 22 | 9:30 PM–12:30 AM · $250.00 deposit (Visa ··2290) | Birthday. "Cake at 11:00, in the fridge behind the bar." ID ✓ 22 of 22. |

**What each room owes**

| Room | Clock | Room time so far | Drinks so far | Tab so far | What is on the tab |
| --- | --- | --- | --- | --- | --- |
| Room 1 | 71 min | $47.33 | $76.00 | **$123.33** | Small bucket · 6 beers $40.00 (delivered 9:52 PM); 4 × Corona $36.00 (accepted 10:38 by Maya, ready for a runner) |
| Room 3 | 116 min | $96.67 | $79.00 | **$175.67** | 2 × Peach soju $40.00; 2 × Margarita · Peach and 1 × Margarita · Strawberry $39.00 (accepted 10:33 by Maya, ready since 10:37) |
| Room 5 | 41 min | $40.00 (first-hour minimum) | $0.00 | **$40.00** | Nothing yet. The room time is the first-hour minimum |
| Room 7 | 131 min | $152.83 | $58.00 | **$210.83** | Small bucket · 6 beers $40.00; 2 × Lemon Drop shot $18.00 |
| Room 9 | 161 min | $322.00 | $158.00 | **$480.00** | Large bucket · 10 beers $70.00; 2 × Chamisul Fresh $40.00; 4 × Jäger Bomb $48.00 (delivered 9:58 PM by Diego) |
| Room 10 | 221 min | $331.50 | $110.00 | **$441.50** | Large bucket · 10 beers $70.00; 2 × Chamisul Fresh $40.00 |
| Room 12 | 101 min | $235.67 | $70.00 | **$305.67** | 2 soju + small bucket $70.00 |
| VIP room | 71 min | $295.83 | $480.00 | **$775.83** | Hennessy · bottle $300.00; Moët & Chandon · bottle $180.00 (delivered 10:05 PM by Andy) |

Rooms 2, 4, 6, 8, 11 and 13 have no tab. The clock for Room 9 is 12 × $10 = $120 an hour, which is $2.00 a minute, for 161 minutes. Earlier tonight Ella S. (8, Room 6) and Yuki H. (12, Room 13) came and paid; show them only where earlier sessions are listed.

## Bookings tonight

The Calendar boards, the phone's Calendar and Staff → Tonight all list exactly these 11.

| Time | Guest | Party | Room | Length | Deposit | Status at 10:41 |
| --- | --- | --- | --- | --- | --- | --- |
| 7:00 PM | Tanya W. | 9 | Room 10 | 3 hr | $90.00 | Seated · staying past 10:00 |
| 8:00 PM | Marcus T. | 12 | Room 9 | 3 hr | $120.00 | Seated |
| 8:30 PM | Rob & Kim | 7 | Room 7 | 2 hr | $70.00 | Seated · 11 min past, and the Parks are next |
| 8:45 PM | Priya R. | 5 | Room 3 | 2 hr | $50.00 | Seated |
| 9:00 PM | Omar F. | 14 | Room 12 | 3 hr | $140.00 | Seated |
| 9:30 PM | Dana K. | 4 | Room 1 | 2 hr | $40.00 | Seated |
| 9:30 PM | Bianca L. (birthday) | 22 | VIP room | 3 hr | $250.00 | Seated · big party |
| 10:30 PM | Sam O. | 3 (bills as 4) | Room 2 | 1 hr | $40.00 | Late · "running 15 late" · held until 10:45 |
| 11:00 PM | Jae & co. | 5 | Room 3 | 2 hr | $50.00 | Booked |
| 11:00 PM | The Parks | 8 | Room 7 | 2 hr | $80.00 | Booked |
| 11:00 PM | The Nguyens | 6 | Room 8 | 2 hr | $60.00 | Booked |

- Leo M. (Room 5) is a walk-in, not a booking.
- The guest booking demo (Manage) is **Jae & co.**: 5 guests, Fri Sep 25, 11:00 PM, 2 hr, Room 3, $50 deposit paid Wed Sep 23.
- Sam O.'s 3 guests bill as 4 on a Friday, so his deposit is $40.00 (4 × $10).

## Waitlist

| # | Party | Joined | Quoted | Note |
| --- | --- | --- | --- | --- |
| 1 | Amara B. · 7 | 10:15 PM (26 min) | 25 min | At the bar. |
| 2 | Nadia K. · 6 | 10:21 PM (20 min) | 20 min | Renamed from "Priya K." so nobody confuses her with Priya R. |
| 3 | Chris P. · 3 (bills as 4 on Friday) | 10:37 PM (4 min) | 40 min |  |

- **Offer suggested now:** Room 11 (12 to 20) is free all night and no booking tonight needs it, so it can go to a smaller party. It goes to **Amara B. (7)**, who is first. The offer holds the room for 10 minutes, texts her and shows a countdown. If the text fails, the row shows "Not delivered · Call".
- Room 6, once wiped, goes to **Nadia K. (6)**. Room 13, once wiped, goes to **Chris P. (3)**: it is big for them, but nothing else is free for an hour.
- **The guest waitlist page:** the guest joins as the 4th party (a party of 4), and the page says "3 parties ahead". The "room ready" demo says **"Room 2 is ready · 10:00 to claim it"**, because Sam O. no-showed at 10:45.

## Board alerts

Most urgent first. Colors are the Board's.

1. **Pink**: Room 7 is 11 min past its time, and the Parks (8) are booked into Room 7 at 11:00. [Text Rob & Kim: please wrap up] [Move a room…] The Move sheet lists Room 11 as free all night.
2. **Pink**: Room 9 called for another mic, 2 min ago. [On it]
3. **Amber**: Room 5's order has been ringing 2:11 (4 × Bud Light). [Show]
4. **Amber**: Room 3: 4 min left, and Jae & co. are booked at 11:00. [Text Priya: please wrap up]
5. **Lime**: Room 11 is free all night, and Amara B. (7) has waited 26 min. [Offer Room 11 · 10 min to claim]
6. **Grey**: Rooms 6 and 13 need a wipe (8 and 5 min), and Nadia K. and Chris P. are waiting. [Show]
7. **Grey**: Sam O. texted "running 15 late" for the 10:30 in Room 2, and it's held until 10:45. [Reply "no problem"] [Check in] [Mark no-show]

The Board's menu badge reads **"Bar orders · 2"**, which counts every ringing and asked-to-wait order. The alert for Room 5's order is the 2-minute escalation: at 4 minutes it says "on Andy's phone", and at 6 minutes "texted Andy".

## Room orders

The bar screen, the Rail, Runs, the Board and Order all show these. The sale happens at **Accept**, and Delivered charges nothing.

| Order | Room | Items | Amount | Staff see | The guest's phone | On the tab | IDs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| o1 | Room 9 | 2 × Margarita · Peach | $26.00 | Ringing · 0:43 | Sent to the bar · you can still cancel | no | ID ✓ 12 of 12 |
| o2 | Room 5 | 4 × Bud Light | $32.00 | Ringing · 2:11 (amber) | Sent to the bar · you can still cancel | no | ID ✓ 4 of 4 |
| o3 | Room 3 | 2 × Margarita · Peach, 1 × Margarita · Strawberry | $39.00 | Ready for a runner · 4:00 (accepted 10:33 by Maya, ready 10:37) | Being made · on your tab | yes | ID ✓ 5 of 5 |
| o4 | Room 1 | 4 × Corona | $36.00 | Ready for a runner · 1:35 (accepted 10:38 by Maya, ready 10:39) | Being made · on your tab | yes | ID ✓ 3 of 4 · runner checks the last ID |
| earlier | VIP room | 1 × Moët & Chandon · bottle | $180.00 | Delivered · 10:05 PM · Andy | Delivered | yes |  |
| earlier | Room 9 | 4 × Jäger Bomb | $48.00 | Delivered · 9:58 PM · Diego | Delivered | yes |  |

- Nothing has been returned tonight. The boards that show a Returned list give it a "Demo: a runner brings one back" control.
- Diego has one unsent draft: 1 × Red Bull ($6.00) on Tariq A.'s tab. A draft is never part of a check.
- The six words: Ringing → Asked to wait → Being made → Ready for a runner → On its way → Delivered. The full pipeline and the guest's wording are in [Staff screens and the bar POS](spec/10-staff-screens-bar-pos.md) and the [glossary](glossary.md).

## Bar tabs, room tabs and paper slips

**Bar tabs.** The Rail keeps five. Drinks, tax and total are at 10:41 PM. Bar tabs carry no gratuity. The lines come from the Rail board; the brief fixes the names, cards and states.

| Tab | Card | Hold | Opened | Owner | Lines | Drinks | Tax | Total | State |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hana K. (t4) | Visa ··5120 | $50.00 | 9:10 PM | Maya | Chamisul Fresh $20.00; Peach soju $20.00 | $40.00 | $3.55 | $43.55 | **Cut off by Andy at 10:30 PM.** Alcohol greyed out. Her song is fine. |
| Jess P. (t1) | Visa ··4417 | $50.00 | 9:40 PM | Maya | 2 × Modelo $18.00; Jäger Bomb $12.00 | $30.00 | $2.66 | $32.66 |  |
| Luis M. (t2) | Mastercard ··2281 | $80.00 | 9:55 PM | Maya | Small bucket · 6 beers $40.00; 2 × Lemon Drop shot $18.00; Mr. Brightside · The Killers $0.00 | $58.00 | $5.15 | $63.15 | Hold grew from $50 to $80 as rounds were sent. Singing now: a $0.00 song line for a drink credit. |
| Tariq A. (t5) | Visa ··8830 | $100.00 | 10:02 PM | Diego | Large bucket · 10 beers $70.00; Modelo $9.00 | $79.00 | $7.01 | $86.01 | Diego's tab. His void of the Large bucket waits for Andy ("Waiting for Andy"). |
| Seat 6 · blue jacket (t3) | Amex ··7712 | $50.00 | 10:20 PM | Diego | Tito’s (Rocks, Soda) $12.00 | $12.00 | $1.07 | $13.07 | Diego's tab. A phone tapped, no name. |

**Room tabs on the Rail.** Room tabs use the room numbers above:

- **r9 Room 9:** Marcus T. · 12, opened 8:00 PM, 161 min, $322.00 of room time, deposit $120.00.
- **r12 Room 12:** Omar F. · 14, opened 9:00 PM, 101 min, $235.67 of room time, deposit $140.00.
- **r14 VIP room:** Bianca L. · 22, opened 9:30 PM, 71 min, $295.83 of room time, deposit $250.00.
- The Rail may list more room tabs. If it does, use the numbers under [Rooms](#rooms-at-1041-pm).

**Paper tip slips** (the staff phone's "Tips to enter", and Close the night). Three signed slips wait for a tip. Close the night shows "3 slips not entered · tips post to Sat Sep 26". **Jess P.'s card, Visa ··4417, is not on any slip.**

| Slip | Card | Tab total | Signed | State |
| --- | --- | --- | --- | --- |
| Dev S. | Visa ··3318 | $48.00 | 10:12 PM | photo saved, tip not entered |
| Tom W. | Mastercard ··0457 | $36.00 | 10:26 PM | photo saved, tip not entered |
| Ana R. | Amex ··2204 | $62.50 | 10:35 PM | photo saved, tip not entered |

## Cash drawers and devices

- **Two drawers**, each a **house drawer** (the manager on duty, Andy, answers for it). The **bar drawer** is on the bar receipt printer's kick port, and the **front-desk drawer** is on the front-desk printer. Each opened with $300.00, the starting bank in the West 4 designs ([Settings](spec/03-settings-rule-packs-modules.md)). Opening times and per-drawer cash are not in the brief.
- Cash from a sale goes into the drawer at the screen where it is taken. The log names who took it: "Logged to Maya · bar drawer".
- Admin → Cash drawers can switch to a drawer per person. The Board and Close the night keep a demo link for that model.
- Close the night counts both drawers blind.

| Where | Device | State |
| --- | --- | --- |
| Bar | Bar computer (bar POS, bar orders screen, song queue) | online |
| Bar | USB NFC badge reader | online |
| Bar | Receipt printer with the bar drawer | online |
| Bar | **Stripe Reader S710 (bar)**, installed, cellular | online |
| Front desk | Desktop app computer (Board, DeskRoom and the rest) | online |
| Front desk | USB NFC badge reader | online |
| Front desk | Receipt printer with the front-desk drawer | online |
| Front desk | **Stripe Reader S710 (front desk)**, cellular | online |
| Around the venue | 14 room tablets, one per room | 13 online. Room 4's is off because the room is out of service |
| Around the venue | 1 Up next TV at the bar | online |
| Around the venue | Dual-WAN router with a cellular backup | "Backup internet · on" (not on backup now) |
| Badges | NTAG 424 DNA badges for Abhishek, Andy, Maya and Diego |  |
| Phones | One paired phone each | Andy's is the staff-phone demo |

The Console shows the same facts: 13 of 14 room tablets online, both readers online, backup internet on. Devices, printing and the outage behavior are in [Devices, printing and offline](spec/09-devices-printing-offline.md).

## The singer queue

Bar mode started at 9:00 PM and 23 songs have been sung. It is round 3, with a limit of 1 song per singer per round. The offer is "Buy a drink, get a song": each drink bought earns one song credit, which posts as a $0.00 song line when the song starts. West 4 has set no price for a song without a credit, so Admin shows "Song price · not set · songs need a drink credit".

**Now singing:** Luis M., "Mr. Brightside", The Killers. Maya started it at 10:39 PM. It used a drink credit, so a $0.00 song line is on his tab (t2).

**Up next,** in order. The Rail's header reads "Song queue · 6".

| # | Singer | Song | Artist | Tab | Credits | Note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Jess P. | "Dancing Queen" | ABBA | tab t1 | 1 |  |
| 2 | Kira | "Valerie" | Amy Winehouse | no tab | 1 | She bought a drink at the bar. |
| 3 | Ben T. | "Livin' on a Prayer" | Bon Jovi | no tab | 1 | The SingQueue phone demo's guest: "2 singers before you". |
| 4 | Tariq A. | "Sweet Caroline" | Neil Diamond | tab t5 | 2 |  |
| 5 | Hana K. | "Someone Like You" | Adele | tab t4 | 1 | Her tab is cut off from alcohol. Singing is fine. |
| 6 | Sofia R. | "Bohemian Rhapsody" | Queen | no tab | 0 | Flagged "Needs a drink credit". |

The Up next TV shows the one now singing and the next 5 singers, with a QR code to join. It never shows phone numbers. Bar mode is in [Song systems and texts](spec/11-song-systems-texts.md).

## Texts and the inbox

The Admin texts list, the desktop Messages board and the phone's Messages all show exactly these 14. Twelve are service texts. The last two are marketing texts, and both are off until they have their own opt-in.

| # | Text | Sent | State | Wording |
| --- | --- | --- | --- | --- |
| 1 | Booking confirmed | Right away | on | Booked. Room for 6 at 9:30 PM, Sat Sep 26. A 20% gratuity is added to room tabs. Deposit $60 paid, comes off your bill. Free to cancel until Fri 9:30 PM: west4karaoke.com/b/… |
| 2 | Reminder | Afternoon of | on | Tonight at West 4: room for 6 at 9:30 PM. 186 W 4th St. Reply if anything changes. |
| 3 | Room code | At check-in | on | Welcome to Room 9. To order drinks from your phone, scan the code on the wall and enter room code KX4M7. |
| 4 | Room ready | When staff offer a room | on | Your room is ready: Room 11. You have 10 minutes to claim it at the front desk. |
| 5 | Offer expiring | 5 min left | on | 5 minutes left to claim your room at West 4. After that it goes to the next party in line. |
| 6 | Please wrap up | Someone booked next, 10 min before end | on | 10 minutes left in Room 9. The next party is here, so please start wrapping up. Thank you! |
| 7 | Booked time ending | 10 min before end | on | Your booked time in Room 9 ends at 11:00 PM. Nobody's booked after you, so you can stay on by the minute until we close at 4 AM. |
| 8 | Receipt | After paying | on | Thanks for singing with us. Your receipt for $154.65: west4karaoke.com/rc/… |
| 9 | Deposit refund | When a refund goes out | on | Your $60.00 deposit for Sat Sep 26 is on its way back to your card. It takes 5–10 days to show. |
| 10 | Payment link | Staff or big-party booking | on | West 4 is holding the VIP room for 22 on Fri Sep 25 at 9:30 PM. Agree to the terms and pay the $250.00 deposit here: west4karaoke.com/b/… |
| 11 | Running late reply | Guest says they're late | on | No problem. We'll hold your room until 10:45 PM. |
| 12 | You're up next | Bar mode · when 1 singer is ahead | on | You're up next at the bar. Come to the stage when this song ends. |
| 13 | Review ask | Next morning 11 AM | off | Hope last night was a good one. Two taps to tell Google: g.page/west4/review |
| 14 | Birthday | A week before | off | Your birthday's coming up. Book a room this month and the first song's on us. |

"The bar needs a few minutes" and "On its way" are room-screen messages, not texts. The wording of #4 and #7 comes from the fix brief; the others come from the AdminDesk board's demo. Texts are in [Song systems and texts](spec/11-song-systems-texts.md).

**Inbox threads**

- **Sam O.** (unread): guest "running 15 late". The reply waiting to send: "No problem. We'll hold your room until 10:45 PM."
- **Marcus T.**: automatic "Booked. Room for 12 at 8:00 PM, Fri Sep 25. Deposit $120 paid, comes off your bill."; guest "if we're having fun can we stay past 11?"; West 4 "Nobody has Room 9 after you tonight, so you can stay on by the minute until we close at 4 AM."
- **Bianca L.**: automatic "Your VIP room is confirmed for Fri 9:30 PM. Deposit received, thank you."; guest "can we bring a cake?"

## Room 9, worked through

Marcus T., 12 guests, booked 8:00 to 11:00 PM, check **#1042**, deposit $120.00 on Amex ··1005. Room 9 is the money story every close-out test uses. The same numbers are cases in [`money-cases.json`](../seed/money-cases.json) (`room9_closeout_rev1` and its neighbors), and the reasoning is in [Money rules](spec/05-money-rules.md).

| Line | How | Amount |
| --- | --- | --- |
| Room time | 12 × $10 = $120 an hour = $2.00 a minute, for 161 minutes | $322.00 |
| Drinks | Large bucket $70 + 2 × Chamisul Fresh $40 + 4 × Jäger Bomb $48 | $158.00 |
| Subtotal |  | $480.00 |
| Tax | 8.875% × $480.00 | $42.60 |
| Gratuity (20%) | 20% × $480.00, a room check | $96.00 |
| **Total** | revision 1 | **$618.60** |
| Deposit | 12 × $10, paid online and allocated at check-in | −$120.00 |
| **Left to pay** |  | **$498.60** |

**If the ringing margaritas are accepted first.** The 2 × Margarita · Peach ($26.00) is not on the check, and the check can't be presented until it is accepted or cancelled ("2 × Margarita · Peach is ringing at the bar · accept or cancel it first"). If the bar accepts it, the check becomes:

| Line | Amount |
| --- | --- |
| Subtotal (room time $322.00 + drinks $184.00) | $506.00 |
| Tax | $44.91 |
| Gratuity (20%) | $101.20 |
| **Total** | **$652.11** |
| Deposit | −$120.00 |
| **Left to pay** | **$532.11** |

If a manager reopens a presented check to add a line, the next finalize writes revision 2, which reverses revision 1's tax and gratuity and writes new ones.

**What the screens show along the way**

- **Present the check** finalizes #1042 and locks ordering from the room. Guests' phones read "Your bill is ready · ordering is closed", with the bill link. A manager can [Reopen the check].
- **Ways to pay** can be mixed: a tap on the front-desk or bar reader; the card on file (Amex ··1005) after "Waiting for Marcus to confirm on his phone"; cash; or a split. The reader skips its tip screen, because the check already carries the 20% gratuity.
- **Even split three ways:** $498.60 ÷ 3 = $166.20 each.
- **Pay my share:** each of the 12 guests pays 1 of 12 of $498.60, which is **$41.55** (12 × $41.55 = $498.60 exactly). The log line reads "Paid by a guest · Kevin (share 1 of 12) $41.55". The booker's Amex ··1005 still guarantees the rest.
- **Refund cap:** only Marcus's $120.00 deposit is captured tonight, so a refund can't exceed $120.00.
- **Receipt:** [Text] [Email] [Print] [No receipt], printing "Gratuity included (20%)". Then "Room 9 goes to cleaning". That is blocked while any order on the room is ringing, asked to wait or unpaid.
- The card fee is off at West 4, so no surcharge applies.

## Later tonight

The Close the night board (`Night`) is labeled **"Later tonight · Sat 4:12 AM"**. The business date is still Fri Sep 25. Its demo ends with "Night closed · 4:48 AM".

| Time (Sat Sep 26) | What happens |
| --- | --- |
| 4:00 AM | The alcohol window closes. Every alcohol button greys out on every screen. Alcohol orders nobody accepted are cancelled (alcohol_closed, nothing charged). Guests see "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged". The bar orders screen lists "Cancelled at 4:00 AM". No Decline button. |
| 4:02 AM | The Rail's late demo ("Demo: it's 4:02 AM"). |
| 4:12 AM | Close the night screen ("Later tonight · Sat 4:12 AM"). |
| 4:30 AM | Close plus 30 minutes' drinking-up: the clear-out check is due, and the tab cut-off job captures every open tab at its balance. |
| 4:31 AM | Clear-out check · Andy · 4:31 AM (Done). |
| 4:48 AM | Night closed · 4:48 AM. |

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

**The Z report:**

- Drinks split into Room checks and Bar tabs.
- Gratuity from room checks only, as the sum of their gratuity lines.
- "Print X report (running)" until the night closes, then "Print Z report".
- The gratuity is 20% of room time + room drinks + packages sold to rooms − room comps and refunds, before tax.
- The log is in time order and agrees with the Board: Room 4 has been out of service since Tue.

**Not seeded:** the whole night's Z totals. The brief gives none, and the Night board's figures are from an older night. Compute them from the checks, and check them against the [money cases](../seed/money-cases.json) (`z_gratuity_room_checks_only` and the rest of the `z_report` group).

## Things to try

Sixteen scripted walks through the Friday. Each names what to do and what must happen, so they are the first end-to-end tests. They are also in the JSON as `scenarios`. Some boards have "Demo:" buttons to jump to a state, such as "Demo: it's 4:02 AM"; the app has none. In staging, move the simulated clock or call the API instead.

- **`accept_o1`.** Accept o1 (2 × Margarita · Peach) from the bar POS or the bar orders screen. Expect: o1 leaves Ringing and joins Room 9's check: drinks $158.00 → $184.00, tab so far $480.00 → $506.00. A ticket prints. Bar orders · 2 becomes Bar orders · 1. Room 9's phone reads "Being made · on your tab".
- **`ask_room5_wait`.** On o2 (Room 5, 4 × Bud Light, ringing 2:11) tap Ask the room to wait. Expect: o2 shows Asked to wait, stays under Waiting for you and keeps aging; the badge stays at 2; no screen offers Ready or Delivered until Accept. Room 5's phone reads "The bar needs a few minutes".
- **`accept_o2`.** Accept o2. Expect: Room 5's tab so far $40.00 → $72.00 (first-hour minimum $40.00 + $32.00). The room's ID chip reads ID ✓ 4 of 4.
- **`runner_o3`.** On Andy's phone open Runs, tap I've got it on o3 (Room 3), then Delivered. Expect: o3 goes Ready for a runner · 4:00 → On its way · Andy → Delivered · time · Andy. Delivered charges nothing; the $39.00 was charged at Accept.
- **`runner_returns_o4`.** Demo: a runner brings o4 (Room 1, 4 × Corona) back with "No ID for someone who ordered". Expect: o4 shows Couldn't serve: No ID for someone who ordered · Andy under Returned; the manager on duty sees it; the bar picks Void · not made, Void · made (waste) or Remake. The $36.00 void is over the $25 reason-only limit: the spec does not say whether return resolutions count against the limit (flagged).
- **`andy_approves_void`.** On Andy's phone open Approvals · 1 and tap Approve on Diego's void of the Large bucket. Expect: Tariq A.'s tab drops $79.00 → $9.00 of drinks, tax $0.80, total $9.80 (was $86.01). Diego's screen showed "Waiting for Andy" and then the decision. Tip choices on the reader change to $1, $2, $3 because the drinks are under $10.
- **`reason_only`.** As Maya, comp a $13.00 drink with a reason. Expect: No approval: her shift total goes $12.00 → $25.00 and the screen shows "$50 left this shift". A $25.01 comp, or a shift total over $75.00, goes to Andy.
- **`sam_check_in`.** At 10:44 check Sam O. in (party 3). Expect: The sheet shows "3 guests · Fridays bill at least 4", deposit applied −$40.00, a new room code texted to the host with the join link. Room time bills 4 × $10.00 an hour with the one-hour minimum ($40.00).
- **`sam_no_show`.** At 10:45 tap Mark no-show instead. Expect: Allowed only after the 15-minute grace (10:30 + 15). Room 2 frees up; the guest waitlist page reads "Room 2 is ready · 10:00 to claim it".
- **`offer_room11`.** Tap Offer Room 11 · 10 min to claim for Amara B. (7). Expect: Room 11 is held for 10 minutes with a countdown and the Room ready text goes out. If the text fails: "Not delivered · Call". Seat opens check-in in Room 11. If unclaimed, the room is released and offered to the next party that fits (Nadia K.).
- **`room9_closeout`.** Close out Room 9 (Marcus T.). Expect: Present the check is refused while o1 rings ("2 × Margarita · Peach is ringing at the bar · accept or cancel it first"). With o1 cancelled: check #1042 totals $618.60, deposit −$120.00, $498.60 left. With o1 accepted first: $652.11 total, $532.11 left. Gratuity is on the check, so the reader skips its tip screen and the receipt says "Gratuity included (20%)". Marcus's refund cap is $120.00 (only the deposit is captured tonight).
- **`pay_my_share`.** On the guests' phones open Your bill and pay 1 of 12. Expect: Each share of $498.60 is $41.55. The log line reads "Paid by a guest · Kevin (share 1 of 12) $41.55". The booker's Amex ··1005 still guarantees the rest.
- **`room7_move`.** Tap Move a room… on Room 7's alert. Expect: The sheet lists only rooms that fit and are free for the time needed; Room 11 is free all night. Moving opens a new segment, a new room code and "You've moved to Room 11 · new code …" on the guests' phones; Room 7 goes to cleaning for the Parks (8) at 11:00.
- **`cut_off_hana`.** Look at Hana K.'s tab (t4). Expect: "Cut off by Andy at 10:30 PM" on every screen for that tab; alcohol greyed; moves of alcohol onto it refused; her song (position 5) still plays.
- **`alcohol_stop`.** Use the Rail's "Demo: it's 4:02 AM". Expect: Every alcohol button is greyed with the reason in words; unaccepted alcohol orders show Cancelled at 4:00 AM; there is no Decline button.
- **`night_close`.** Open Close the night at Sat 4:12 AM (business date Fri Sep 25). Expect: Nine checks each link to their fix; "3 slips not entered · tips post to Sat Sep 26"; both drawers counted blind; the clear-out check is due at 4:30 AM and closes as "Clear-out check · Andy · 4:31 AM"; the demo ends "Night closed · 4:48 AM".

## Where the frozen canvas differs

The design canvas is frozen at v39 and will not change ([design](../design/README.md)). Where a board and the seed differ, build the seed. [screens](screens.md) lists what to build on each board; this is the short version, so a screenshot check isn't fooled.

| Board | It shows | The seed has |
| --- | --- | --- |
| Board | Six alerts. Room 7 "9 min past and a party of 7 is on the waitlist". The Room 11 offer names "Priya K. (6)". Room 3 says Jae & co. are booked at 10:45. | Seven alerts (see [Board alerts](#board-alerts)). Room 7 is 11 min past, and the Parks (8) are booked into it at 11:00. The Room 11 offer is for Amara B. (7). The waitlist party is Nadia K. (6). Jae & co. are booked at 11:00. |
| Board | Room 1 $86 · 28 min left. Room 3 $154. Room 5 51 min left. Room 7 9 min past · $212. Room 10 $96 · 12 min past. Room 12 $330 · 102 min left. VIP $745 · 140 min left. | Room 1 $123.33 · 49 min left. Room 3 $175.67. Room 5 79 min left. Room 7 11 min past · $210.83. Room 10 $441.50 · 41 min past. Room 12 $305.67 · 79 min left. VIP $775.83 · 109 min left. |
| Board | Rooms 6 and 13 "Left 9:12 PM" and "Left 9:20 PM". The VIP note says "Cake at 10:30". | Room 6 left 10:33 PM (8 min), Room 13 left 10:36 PM (5 min). "Cake at 11:00, in the fridge behind the bar." |
| Board | "Inside now 100 people". "Bar orders 1". One "House drawer". | 98 inside (77 in rooms, 5 on bar tabs, 16 waiting). "Bar orders · 2". Two house drawers. |
| Bar | Room 5 is "Kenji W. · party of 5 · ID 4 of 5". Room 3's party is "Walk-in". | Leo M. · 4 · ID ✓ 4 of 4 in Room 5. Priya R. · 5 in Room 3. |
| Rail | Room 12 opened 8:23 PM, 138 min, $322. The VIP room $296. | Room 12 opened 9:00 PM, 101 min, $235.67. The VIP room $295.83, in cents. |
| Staff | 2 rooms in use and 11 open. A booking list from another Friday (Dana late at 8:30, Jae & co. as 8 guests in Room 6, no Omar F. or Tanya W.). The first paper slip is Dev S. with Visa ··4417. | 8 in use and 3 open. The 11 bookings above. Dev S. is Visa ··3318, Tom W. is Mastercard ··0457 and Ana R. is Amex ··2204. Visa ··4417 is Jess P.'s. |
| Calendar, DeskCalendar | Priya R. 7:00 to 9:00, Jae & co. as 8 guests in Room 6, Sam O. at 10:00. Leo M. as a booking. No Jae & co. on the desktop. | The 11 bookings above. Leo M. is a walk-in. |
| Messages, DeskMessages | Dana in the "running late" thread on the phone and Sam O. on the desktop. A waitlist party "Priya K.". | Sam O. "running 15 late" at 10:24 PM. Nadia K. (6) on the waitlist. |
| AdminDesk | 13 automatic texts. "4 open tabs · 9 rooms in use". | 14 texts. 5 open tabs and 8 rooms in use. |
| Pin | 7:00 PM, and Maya "3h 00m so far". Diego is "Staff". | 10:41 PM. Maya on 6h 41m, Andy 4h 41m, Diego 3h 41m. Diego is Front desk. |
| Night | Gratuity on every sale, one drawer, a 10:39 PM line after 9:14 PM, "Priya K.", and "Turned Room 4 off at 11:30 PM". | Gratuity on room checks only, two drawers, a log in time order, Nadia K., and Room 4 out of service since Tue. |
| Main, Book, Manage, Waitlist | Read the device clock for "open now", "tonight" and the minimum. | Now is Fri Sep 25, 10:41 PM, so Friday's minimum of 4 applies. |
| Manage | Jae & co.: 7 guests, 10:00 PM, $70 deposit. | Jae & co.: 5 guests, 11:00 PM, 2 hr, Room 3, $50 deposit paid Wed Sep 23. |
| Waitlist (guest) | "2 parties ahead". The ready screen names Room 4, or Room 8 or Room 12 by party size. | "3 parties ahead". "Room 2 is ready · 10:00 to claim it". |
| Setup | West 4's preset orders "1 × S710", has one drawer, no NFC readers, badges or Up next TV, and four roles with Diego as Staff. | Two S710s, two drawers, two NFC readers, four badges, the Up next TV and the router. Five roles, and Diego is Front desk. |
| Console | West 4 is "7/7 online" with "10 of 10" steps. | 13 of 14 room tablets online (Room 4's is off), both readers online, "Backup internet · on". |
| Order | Room 9's numbers already match the seed. | Keep them: 161 min, $322.00, drinks $158.00, code KX4M7, host lock off. |

## Loading the seed

Staging is seeded from [`seed/west4-friday.json`](../seed/west4-friday.json) ([Testing and operations](spec/13-testing-operations.md)), and the end-to-end tests use the same file as their fixture. A failing test then names a fact from this page, and a screen and the build can be checked against each other.

**The file**

- **Money** is integer cents. No floats anywhere.
- **Times** are ISO 8601 with the -04:00 offset (EDT). Sat Sep 26 times after midnight belong to business date 2026-09-25.
- **Ids** are stable slugs, such as `room_9`, `o1` and `tab_t5`. The loader maps each to the same UUID on every load and keeps the slug in the `seed_ids` table, so a test can find `room_9` by name.
- **`null`** means the brief does not say. Nothing is invented to fill it.
- **Phone numbers** are fictional 555-01xx numbers. Seven come from the Staff board; the ones marked `phone_made_up` were made up for this seed. Staging sends texts only to our own test phones ([milestones](milestones.md), M2).
- **Check numbers.** Only Room 9's check is fixed (#1042); the loader numbers the others from the venue's counter, so no test may depend on them. Only Room 9's room code is fixed (KX4M7).
- **Derived numbers** under `expected_at_now`, `if_presented_now` and the `expected_*` keys are worked out with [Money rules](spec/05-money-rules.md). They are the answers a screen or a test compares against, and the same numbers are cases in [`money-cases.json`](../seed/money-cases.json).
- **Demo PINs** are for staging and the boards only, and never go into production.

**Which milestone first needs which part**

| Part | Keys | First used in |
| --- | --- | --- |
| The venue and its rules | `venue`, `settings`, `role_permissions`, `team`, `badges`, `devices` | M1 |
| Rooms, bookings, waitlist, clocks, alerts, texts | `guests`, `rooms`, `bookings`, `sessions`, `earlier_sessions`, `waitlist`, `waitlist_earlier`, `waitlist_page_demo`, `board_alerts`, `texts`, `inbox` | M2 |
| Menu and room orders | `menu`, `orders`, `order_drafts`, `approvals`, `reason_only_used_tonight` | M3 |
| Checks and paying | `checks` (tab so far from M2; close-out and payments in M4), `drawers` | M2, M4 |
| Bar tabs and bar mode | `bar_tabs`, `singers`, `song_queue`, `up_next_tv` | M6 |
| Paper tip slips (Tips to enter) | `tip_slips` | M6 |
| Close the night | `later_tonight` | M7 |
| Scripts and counts | `scenarios`, `counts` | each scenario runs in the milestone that builds what it touches |

Tests that change state (accept o1, approve the void, check Sam O. in) start from a fresh load, so the next test still sees 10:41 PM.

## Open points

Things the fix brief leaves open or gets wrong, so nobody trips on them. Each needs an answer before the build reaches it.

- **Jae & co. and the room tier (resolved).** Small tier: 5 guests in Room 3, which fits 3 to 6. The milestones now say small.
- **The Room ready text (resolved).** Use 3i's wording everywhere: "Your room is ready: Room 11. You have 10 minutes to claim it at the front desk."
- **Menu size.** The Rail board lists 119 items and Admin → Menu 127. The seed has all 127; the 8 spirit bottles only Admin lists are marked `in_rail_canvas: false`.
- **Maya's $12 (resolved).** The seed now has the line behind it: Luis M.'s tab t2 carries 1 × Jäger Bomb ($12, 10:02 PM) and its reason-only COMP ("Dropped it at the bar", made, by Maya, 10:05 PM). The tab's balance is unchanged at $58.00, and Maya has $63 left this shift.
- **A returned order and the limit.** o4's void ($36.00) is over $25. The spec does not say whether the bar's choice after a return counts against the reason-only limit.
- **Bar tab lines and holds.** The brief fixes the five tabs' names, cards and states. Their lines and holds (Tariq A.'s $100, for one) come from the Rail board.
- **Not in the brief, so `null`:** Room 7's ID count, the drawers' opening times and cash, most check numbers and room codes, and the whole night's Z totals.
- **Made-up phone numbers.** The brief has none. 10 guests and all 7 singers have numbers made up for this seed and marked `phone_made_up`; the other 7 guests' numbers come from the Staff board. All are fictional 555-01xx numbers.

The same points are in the JSON as `meta.flags` (one entry each; the `null` bullet is three entries). The ambiguities in the money cases are in `meta.ambiguities` of [`money-cases.json`](../seed/money-cases.json).
