## Staff screens and the bar POS

The bar is where a slow screen costs the most. At peak one bartender rings, pours, takes cards and answers 14 rooms at once, in a room that averages 81 dBA, with wet hands and an interruption every few seconds. About half of hospitality staff leave within a year, so a new hire runs the screen on their first shift. The staff screens keep every control the rest of this spec describes, and are built so the usual path is one tap, every state is visible without opening anything, and nothing waits for a manager. The design canvas has the bar POS (desktop app) and the other staff screens; where a canvas board and this spec differ, this spec wins.

**Rules every staff screen follows**

1. **One home per role.** Sign-in opens the screen the role works in: bartenders get the bar POS, the front desk (`front_desk`) and managers tonight's board, and runners (`staff`) the Runs tab on their phone. Everything else is one tap away in the side menu, which is the same on the board, the bar POS, the bar orders screen, the song queue and every other desktop screen: Tonight, Bar POS, Bar orders, Song queue (in bar mode), Calendar, Messages, Reports, Close the night, Admin and Lock.
2. **Nothing moves.** The grid has 25 fixed slots per section, and an item keeps its slot all night. An item that's out stays where it is, greyed and marked "86'd tonight", instead of vanishing and shifting its neighbors, and a new item takes an empty slot. Layouts are versioned in `pos_layouts`, and a published change starts at the next business date. With Kitchen & food on, a Food section comes after the ten, and tapping it opens a second row of the menu's own food categories, each showing only its items; the ten drink sections don't change ([Kitchen and food](16-kitchen.md), draft, D100). Bar tabs stay in the order they were opened.
3. **The usual is one tap.** A drink rings with its usual options already set (spirits on the rocks), and tapping it again makes two. Options show under the line in the check, never in a pop-up. Only a choice with no sensible default, like a margarita's flavor, holds a line back: the line turns amber, stays open while other drinks are rung, and the send button names what's missing.
4. **Exceptions in words.** A tab row carries a badge only when it needs attention ("Hold · $6 left", "Hold raise declined", "Partly paid · $16.33 of $32.66", "Cut off", "Waiting for Andy", "2 not sent", "Paid $272.19 · no hold"), so the ones that matter stand out. Color always comes with words.
5. **Undo, not "are you sure?"** Every change to unsent drinks can be undone step by step. Confirmation is kept for what the screen can't take back: charging the remaining tabs, and closing the night.
6. **Nothing waits for a manager.** Approvals go to a manager's own phone ([Tenancy and access](02-tenancy-access.md)), the line shows "Waiting for Andy" and then the decision, and the bartender keeps working. Nobody types a manager code at the bar.
7. **Color is the alarm.** A chime would have to reach about 96 dBA to be heard over the bar, so room orders age on screen instead ([Devices, printing and offline](09-devices-printing-offline.md)). Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup.
8. **Interruptions lose nothing.** Unsent drinks are saved on the server as they're rung, per person and per tab (`order_drafts`), so a badge swap, a phone call, a crash or moving to the other terminal loses nothing.
9. **Big, wet-proof targets.** On a wet screen people need about two tries per target, so menu buttons are at least 115 × 100 px (about 30 × 26 mm on a 15.6-inch 1920 × 1200 screen at 150%), main actions are 52 to 64 px tall, and nothing needs a swipe or a long press. Wipe screen turns touch off for 10 seconds.
10. **Fast on the glass.** A tap answers in the same frame, under 20 ms, and a send is confirmed within 300 ms at the 95th percentile on the venue's network. While the network is slow, the round shows as sending, never a frozen screen.
11. **Each person's language.** Staff screens launch in English and Spanish. Each person picks theirs in Admin → Team (a Language column) and on their own sign-in ("English · Español"), stored in `memberships.locale`, and menu items keep their menu names. Korean and Chinese follow in phase 2.
12. **One word, one meaning.** Every staff screen uses the words below, so a first-shift bartender never meets one word with two meanings.
13. **Training looks different.** In training mode the bar POS, the board and the room tab show a permanent band, "TRAINING · not real money", and check numbers start with T- ("T-0012"). Admin → Team → Training mode turns it on per person, or per device for a new hire, and practice checks stay out of every total ([Testing and operations](13-testing-operations.md)).

**Words on every staff screen**

Room orders use one set of words on the bar POS, the bar orders screen, the Runs tab on staff phones, the board and the guest's phone:

| `orders.status` | Staff screens show | Staff can tap | The guest's phone shows |
| --- | --- | --- | --- |
| `ringing` | Ringing · 0:43 | Accept · print ticket, Ask the room to wait, Decline… | Sent to the bar · you can still cancel |
| `held` | Asked to wait · 1:20, still in Waiting for you and still aging | Accept · print ticket, Decline… | The bar needs a few minutes |
| `accepted` | Being made · "Accepted by Maya · 10:33 · on Room 9's tab · ticket printed" | Ready | Being made · on your tab |
| `ready` | Ready for a runner · 4:00, on every staff phone's Runs | I've got it | Being made · on your tab |
| `on_the_way` | On its way · Andy | Delivered, Couldn't serve… | On its way to Room 9 |
| `delivered` | Delivered · 10:52 · Andy | — | Delivered |
| `returned` | Couldn't serve: *reason* · Andy | Void · not made, Void · made (waste), Remake | Your server will come by |
| `cancelled`, reason `guest` or `staff` | Cancelled by the guest, or by Diego | — | Cancelled · nothing charged |
| `cancelled`, reason `declined` | Declined by the bar · *reason* | — | The bar couldn't take this order · nothing charged, with the reason |
| `cancelled`, reason `alcohol_closed` | Cancelled at 4:00 AM | — | The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged |
| `cancelled`, reason `cut_off` | Cancelled · cut off by Andy | — | Your server has paused alcohol for this room |

- **Accept is the sale.** The order joins the check at that moment and a ticket prints, because someone else has to make and carry it; Delivered charges nothing. No screen offers Ready or Delivered on an order that hasn't been accepted.
- **Cancels.** The guest can cancel only while the order is ringing or asked to wait, and nothing is charged. Staff cancel for the guest the same way, such as when the check is presented. A decline needs a reason, and the guest sees it. After 4 AM there is no Decline: alcohol orders nobody accepted are cancelled automatically (`alcohol_closed`), and an order that also has other items keeps ringing with just those. Cutting off a room or a guest cancels their unaccepted alcohol orders (`cut_off`).
- **Runs.** `claimed_by` and `claimed_at` record the runner's I've got it. A return records the runner's reason ("No ID for someone who ordered", "Someone looks too drunk", "Nobody in the room" or Other), the manager on duty sees it, and "Someone looks too drunk" offers Cut off Room 9?. Remake sends the order back to Being made with a new ticket and charges nothing again.
- **Events.** Each step writes its live event, such as `order.ready`, `order.claimed`, `order.returned` and `order.cancelled` ([API](08-api.md)).

Other words, the same on every screen:

| Instead of | Say |
| --- | --- |
| "Hold" for a room order | "Ask the room to wait" (the chip says "Asked to wait"). "Hold" means only a card authorization |
| "Last call" on Close the night (charging every tab) | "Charge the remaining tabs". "Last call" is only the house last-call time in Admin |
| "Close out" on the phone list | "Tab & close out →". It opens the room tab and never marks a room paid by itself |
| "Sent to room" | "Ready" (the button) and "Ready for a runner" (the column) |
| "Back to the tab" on a quick sale | "Back to the sale" |
| "COMP · void" | "VOID" or "COMP" |
| "Lock the iPad" | "Lock" |
| "their tablet explains" | "their phones explain" |
| "Bar accepted" (guest) | "Being made" |
| "Stay as long as you like" | "Stay on by the minute until we close at 4 AM" |
| Name-and-PIN wording | "badge or name and PIN" |
| "Refunds, cash counts and Admin ask for the PIN again" | "Refunds, cash counts and no-sale ask for the PIN again; Admin needs a passkey" |
| "The bar screen lights up" (room calls) | "Staff get it on their phones" |

Prices on the site read "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour".

**The bar POS screen**

| Area | What it shows |
| --- | --- |
| Top bar | Who's signed in, and "Maya · on break" while she's on break; room orders as cards with their age and Accept; "Song queue · 6" in bar mode, which opens the song queue; the clock and online state; Wipe screen and Lock |
| Side menu | The desktop side menu from rule 1, one tap from the W4 button, so Messages, Calendar and Close the night are one tap away |
| Left | New tab, a find box (name, room or the card's last four), All, Mine and Rooms, Quick sale, bar tabs in the order opened, then rooms, and Closed tonight with Reopen |
| Center | Ten sections in fixed places (Favorites, Beer, Soju, Cocktails, Shots, Spirits, Wine, Soft drinks, Bottles, Buckets), 25 slots each, a search across the whole menu, and 86. With Kitchen & food on, Food after them opens a row of the menu's food categories (D100) |
| Right | The tab's name and card; chips for ID ✓, the hold and its headroom, and a cut-off; the round being rung, with its options; what's already on the tab; Repeat round and Undo; the total; Send, Close and Move tab to a room. With Kitchen & food on, each food line reads "Not sent" or "Sent · 11:42", and "Send to kitchen (N)" sits at the bottom ([Kitchen and food](16-kitchen.md) · Ordering food) |

**86 from the bar POS.** Tap 86 above the grid, then an item, or one of its variants or flavors. It greys out in its slot, marked "86'd tonight", on every staff screen and on the guest menu, until someone taps it again or the night closes (`menu_items.out_until`). Owners, managers, bartenders and the front desk covering the bar can 86 an item, from the bar POS as well as the bar orders screen and Admin.

**Tabs, card first.** New tab puts the bar reader to work and shows the consent line for the bartender to read out before the tap: "We'll hold $50 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader." Read to guest ✓ beside it records who read it, and the tab slip prints the same line ([Payment flows](07-payment-flows.md)). The guest taps, dips or swipes, and the opening hold is placed. A dip or swipe brings the name. For a tap or a phone, the bartender types a first name or taps a label such as Seat 3 or By the stage. The card's last four always show and can be searched. One card has one open tab: a card that already has one opens it instead of placing a second hold. A busy bartender can ring the first round on Quick sale and take the card after, and the drinks move onto the new tab. The hold grows as rounds are sent, and the check shows the headroom in dollars.

**Ringing.** Tap a drink, tap it again for two, and use − and + on a line. Repeat round copies the last round, leaves out anything 86'd or blocked and says so. Send puts the round on the tab, and a room's round shows on the room's screen too. The bartender rings and pours a bar tab's or a quick sale's drinks themselves, so Send prints no bar ticket for them unless a manager turns on "Print tickets for drinks rung at the bar" in Admin → Bar POS (`pos.printBarDrinkTickets`, off by default, D99). A room's round, rung here with Open in the bar POS, always prints, because a runner carries it. Send & close sends and opens payment in one tap. A cut-off tab shows "Cut off by Andy at 10:30 PM" and greys out alcohol, and from 4 to 8 AM every alcohol button greys out on every screen, with the reason in words.

**Paying at the bar.** Every card step shows the card states in [Payment flows](07-payment-flows.md): waiting for a tap on the picked reader, "Declined · try another card or cash", "Checking with Stripe · don't retry", "Reader offline · use the front-desk reader" and "Reader busy".

- **Close to the held card.** The guest picks a tip on the bar reader, and the capture includes it. Nothing waits for a tip to be typed in later.
- **Another card.** A new payment with the tip on the reader; the hold is released once it succeeds.
- **Cash.** One tap on what the guest handed over (Exact, the next $5, $10 and $20, $50, $100, or Other) takes the payment, opens the bar drawer and shows the change in large type. "Wrong amount? Fix the change" changes only the change. The log names who took it: "Logged to Maya · bar drawer".
- **Split** evenly 2, 3 or 4 ways, share by share on the reader, with the first share on the held card. A split survives leaving the pay panel and switching tabs: the tab list shows "Partly paid · $16.33 of $32.66", and the next charge is the rest. Shares are worked in cents, so $32.66 ÷ 2 is $16.33 + $16.33, and for an odd amount the first share gets the extra cent. A share can be paid in cash, and "Stop splitting · charge the rest to …" ends the split. Splitting by item stays on the room tab.
- **Receipt.** Text it (the guest types their number on the reader), Print or No receipt. Ringing the next drink starts the next sale without choosing.
- **Closed tonight.** A closed tab stays in the list until the night closes, and Reopen brings it back, with what was paid kept as paid. A reopened tab whose hold was captured has no hold: its chip reads "Paid $272.19 · no hold", and there's no "Close to card". New drinks are paid by a new tap, by cash, or by Charge the saved card, which needs the guest's confirmation or a manager's OK. With $0 due, no pay buttons show. Managers refund from here too (Refund from check).
- **Move tab to a room.** Pick a room that's in use, and every line moves as a transfer. The tab closes as "Moved to Room 9", the room's check shows "Moved from Jess P.'s bar tab" lines, and the tab's hold is released once the room has a payment method. Alcohol can't move onto a cut-off room.

**Changing a sent drink.** Tap it on the tab for Void, Comp or Move. This fix panel is the same on every screen that changes a sent line (the bar POS, the room tab on desktop and phone, and the board): made or not made, a reason, and "$X left this shift". A void is labelled VOID and a comp COMP. Up to the reason-only limit ($25 each and $75 a shift per person at West 4, counted across every screen), a reason is enough and it goes on the exceptions report. Above it, a manager approves on their own phone while the line shows "Waiting for Andy"; nobody approves their own request, so Andy's go to Abhishek. Moving a drink to another tab needs no approval and both tabs log it. A move runs the hold-raise check just as a send does, and the list of tabs greys out cut-off tabs for alcohol, with the reason.

**Food on the bar POS and the room tab.** With Kitchen & food on, food is rung like a drink; an item with choices opens them on tap, and a required one is picked before Add (D100). It goes on the tab or check exactly when a drink would and reads "Not sent" until Send to kitchen (N) prints one kitchen ticket for the unsent food, each line with a note for the kitchen and "This is an allergy"; a quick sale asks for a first name or a label first. On a bar tab or a quick sale, Send to kitchen sends the round first if it hasn't gone (on a quick sale, it makes the sale, as Pay would). Food that's Not sent comes off with Delete, no reason and no approval, logged as a void that doesn't count toward the reason-only limit; sent food comes off only by the fix panel's void. "N food items not sent to the kitchen" shows after `kitchen.unsentWarnMin` minutes, and before Close tab or Pay on a quick sale whatever the time, with Send to kitchen beside it; going ahead anyway is allowed. A quick sale whose food was sent can't go Back to the sale ([Kitchen and food](16-kitchen.md) · Ordering food, K-05).

**Food runs.** A food order rings at the bar with the drinks, marked with a "Kitchen" chip. Once its kitchen ticket prints (at Accept for a guest's order, at Send to kitchen for staff-rung food), a room's food shows in Being made and on every staff phone's Runs as "In the kitchen · ticket printed · 6:12", with no Ready at the bar. The runner taps **Picked up** at the kitchen, which records Ready and I've got it in one tap ("On its way · Andy"), then Delivered, or Couldn't serve… as for drinks; a remake prints REMAKE in the kitchen. Food for a bar tab or a quick sale has no run ([Kitchen and food](16-kitchen.md) · Runners and delivery, K-06).

**Sharing a terminal.** Each person taps their badge to take over, in about a second, against about 5 seconds for a name and PIN. Unsent drinks belong to whoever rang them, so two bartenders can work one tab without mixing rounds, and the check says when someone else has drinks not sent on it. Each person has their own quick sale.

**Room orders at the bar.** Orders from the rooms show across the top of the bar POS and on the bar orders screen, oldest first, with their age and ID status ("ID ✓ 3 of 4 · the runner checks the last ID"). The bar orders screen has the same side menu, signed-in person and Lock as the bar POS, and every Accept is stamped with whoever is signed in. Its columns:

| Column | What's in it | Buttons |
| --- | --- | --- |
| Waiting for you | Ringing and asked-to-wait orders, oldest first, still aging. An asked-to-wait order stays here and still needs Accept | Accept · print ticket, Ask the room to wait, Decline… |
| Being made | Accepted orders: "Accepted by Maya · 10:33 · on Room 9's tab · ticket printed" | Ready |
| Ready for a runner | Made orders with their age since Ready; every staff phone's Runs shows them too | — (the runner taps I've got it) |
| Delivered tonight | Only orders a runner marked Delivered, with the time and the runner | — |
| Returned | "Couldn't serve: *reason* · Andy", with the manager on duty told | Void · not made, Void · made (waste), Remake |

Declined and cancelled orders are listed under Returned with their reason, including "Cancelled at 4:00 AM". After 4 AM there's no Decline button: alcohol orders nobody accepted are cancelled automatically with a message to the room.

- **Escalation.** Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup. The board gets an alert at 2 min; at 4 min the alert says "on Andy's phone", and at 6 min "texted Andy". The board's "Bar orders · 2" badge counts every ringing and asked-to-wait order.
- **Print failure.** A ticket the printer hasn't confirmed shows "Ticket didn't print · Reprint" on the bar orders screen and the bar POS, and a reprint prints "REPRINT 2", then "REPRINT 3" and so on ([Devices, printing and offline](09-devices-printing-offline.md)).
- **Runners.** Ready orders show on every staff phone's Runs. The runner taps I've got it ("On its way · Andy"), then Delivered or Couldn't serve… with a reason, which sends the order to Returned.
- **Same again.** The guest's room page lists the room's last delivered rounds, and one tap orders one again; it still rings the bar like any other order.

**Adding drinks to a room from a staff screen.** The room tab on desktop and phone adds drinks through the same menu search as the bar POS, with variants, required choices, 86, cut-offs and the alcohol window. It creates a staff order that's accepted at once, so the drinks go on the room's check and a ticket prints at the bar, and the order then goes through Being made, Ready and a runner like any room order. Open in the bar POS does the same from the bar with the room's tab selected. There are no generic quick-add chips such as "+ Cocktail $12".

**The board and staff phones.** The front desk runs the night from the board; staff phones carry the same sheets. Each sheet works the same wherever it appears:

| Sheet | Where | What it does |
| --- | --- | --- |
| Check in | Board (Arriving and Late bookings show on their room's tile and panel), staff phone | 1. Party size, with the billable minimum ("3 guests · Fridays bill at least 4"). 2. IDs checked, "x of n", plus "The runner checks the rest". 3. Room, confirmed or changed. 4. Start the clock now or at the booked time. 5. Deposit applied (−$40). 6. Room code sent: a new 5-character code, texted to the host with the join link. It calls `POST /bookings/{b}/check-in {party_size, ids_checked, room_id, start_at}`. Mark no-show sits beside Check in, allowed after the 15-minute grace, and + Walk-in opens the same sheet with a free room |
| Waitlist | Board drawer from "Waitlist · 3", the phone's Waitlist tab | Each row shows the party size, joined time, quote and wait, with Offer a room, Text and Remove. Offer a room picks the smallest room that fits and is free for an hour, or a bigger one if no booking tonight needs it, holds it for 10 minutes, sends the Room ready text and shows a countdown; a text that fails shows "Not delivered · Call (212)…". Seat opens check-in in the held room, and an expired offer releases the room to the next party that fits |
| Move a room | Board, room tab on desktop and phone | Lists only rooms that fit the party and are free for the time needed, with their free-until time; occupied and too-small rooms are greyed out with the reason. A move opens a new clock segment and a new room code, the guests' phones show "You've moved to Room 11 · new code …", and the old room goes to cleaning |
| Party size | Room tab on desktop and phone, board panel | + and − show the new hourly rate and the billable minimum. A change closes the current clock segment and updates the "ID ✓ x of n" chip; lowering it after the gratuity applies needs approval |
| Report a fault | Board, room tab on desktop | Logs the fault on the room, with Out of service, Pause the clock (needs approval) and Comp 15 min of room time (a reason-only comp). Open faults show on the tile |
| Damage fee | Room tab on desktop and phone | $150, added only with a photo (camera or upload) and a reason; the line shows the photo's thumbnail, and no screen says "photo attached" without one |
| Lost and found | Board | "Found in Room 9 · kept at the bar · claimed by …" |
| Cut off | Bar POS (a tab), board panel, room tab on desktop and phone ("No more alcohol for this room"), one guest in a room | Records who, why and when, and logs a refusal. Every screen for that tab, room or guest shows "Cut off by Andy at 10:30 PM" and greys out alcohol, unaccepted alcohol orders are cancelled, and the guest's phone hides alcohol and shows "Your server has paused alcohol for this room" |
| Clear-out check | Board and Close the night, at 4:30 AM | "Walk every room and the bar · no drinks left out", then Done records "Clear-out check · Andy · 4:31 AM" |
| Approvals · N | Managers' phones, and the owner's for a manager's own requests | Each request shows the line, amount, reason, who asked and when, with Approve and Decline: comps and voids over the limit, refunds, clock pauses, tips over 25%, paid-outs and a lower party size after the gratuity. Events `approval.requested` and `approval.decided` |
| Calls | Board and every staff phone's Calls list, with a push | Room calls such as "Another mic, please", with On it. The guest reads "Staff get it on their phones" |
| Help alert | Managers' phones only | The guest's "Need a manager, privately?" shows the room and time, with I'm on it and notes that go to the incident log, which the manager's phone keeps. The board shows only a "Manager needed" pin, with no room and no reason (`incident.opened`) |
| Runs | Every staff phone | Ready for a runner, then I've got it, Delivered or Couldn't serve… |

**Shifts.** Clock-in asks for the duty (Bar, Front desk, Runner or Manager), and the tip pool uses it (`shifts.duty`). Clock-out shows a checklist, each line linked to its fix, and finishes once the list is clear: hand over open tabs (Maya has 3) and unsent drinks to someone still on; make a cash drop, or count your own drawer (a drawer per person only); and declare cash tips. While someone is on break, the bar POS shows it ("Maya · on break").

**Charging the remaining tabs.** Close the night lists the open bar tabs with their totals and cards. Guests still at the bar close on the reader and tip there. Then Charge the remaining tabs charges the rest to their held cards at their balances with no tip, after one confirmation that shows how many cards and the total. A tab waiting on an approval is skipped until it's decided, and the 4:30 AM cut-off job still catches anything left. Before the night closes, Close the night lists what's still open, each with a link to fix it: open rooms and bar tabs, staff still on the clock, open waitlist entries, ringing or asked-to-wait orders, pending approvals, rooms still cleaning, unsent drinks, the clear-out check, paper slips not entered ("3 slips not entered · tips post to Sat Sep 26") and both drawers counted.

**Admin → Bar POS.** One settings screen edits the `pos` and `tabs` keys ([Settings, rule packs and modules](03-settings-rule-packs-modules.md)):

| Part | What it sets | West 4 |
| --- | --- | --- |
| Layout | A 25-slot grid for each of the ten sections, per station, showing each item's button name (`menu_items.button_name`, edited in Admin → Menu beside the alcohol flag). Publish saves a new `pos_layouts` version that starts at the next business date ("Starts Sat Sep 26"), so nothing moves mid-shift | One station, the bar |
| Limits | The reason-only limit for comps and voids, each and per shift per person; 0 sends every one for approval | $25 each, $75 a shift |
| Locks | Idle lock and Wipe screen | 3 min, 10 s |
| Tip path | Bar tabs tip on the reader or on a paper slip; the slip stays as the fallback either way | Reader |
| Drink tickets | "Print tickets for drinks rung at the bar": whether Send prints a bar ticket for a bar tab's or a quick sale's drinks. Room orders, from guests or from staff, always print, and food always prints in the kitchen | Off |
| Order aging | Bar phones, amber and the board alert, pink and the manager on duty, a text or call; the chime, and how long Mute lasts | 30 s, 2 min, 4 min, 6 min; chime on; Mute 1 min |
| Tabs | The opening hold, the amount that flags a tab to the manager, and the tab cut-off. The consent line read out at New tab is built from them, and each wording is saved as a new `policy_versions` row, which `tabs.consent_text_version` points at | $50, $600, 4:30 AM |

Whether the front desk can use the bar POS when covering the bar is a role permission in Admin → Team. The old "Ring the bar until someone accepts" alarm toggle is gone: the aging times, the chime and Mute replace it.

The `PosSettings` and `TabSettings` types are defined once, in [Settings, rule packs and modules](03-settings-rule-packs-modules.md).

**How we'll know it works.** No POS vendor publishes timings, so these targets are hypotheses. Before launch, three bartenders who haven't used the system run a scripted 20-minute rush in the venue, with the music on and wet hands, and we count taps, errors and seconds per task. The same run repeats after the first real Friday, and a target that's missed changes the design, not the target. New hires learn on the real screens in training mode (Testing and operations).

| Task | Taps on the prototype | Target |
| --- | --- | --- |
| A walk-up beer, paid in cash | 3: the beer, Pay, the bill handed over | Under 8 s |
| Open a tab for a tapped phone | 4: New tab, Read to guest ✓, a label, Open, while the guest taps | Under 20 s, reading the consent line included |
| Another round on a tab | 2: Repeat round, Send | Under 3 s |
| Close a tab with a tip | 2 on the open tab: Close tab, Close to the card, then the guest tips | Under 20 s with the guest |
| Take over the terminal | 1 badge tap | Under 2 s |
| Accept a room order | 1 | Every order accepted within 2 minutes on a busy night |
| Void a drink rung by mistake | 4: the line, Not made, a reason, Void | Under 6 s |
