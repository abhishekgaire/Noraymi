# Glossary

The product's words and what they mean. One word, one meaning: the same term is used on every screen, in the spec and in the tests. Plain words, US spelling.

- The first six sections are **domain terms**, in alphabetical order within each section.
- [The words on screen](#the-words-on-screen) is the **UI vocabulary**: the order statuses with the staff and guest wording, the "say this, not that" table, the roles, the escalation sentence and the other exact sentences.
- [Board names and finding codes](#board-names-and-finding-codes) explains the names the docs use for the design boards and the review findings.

Where this page and the [spec](spec/README.md) differ, the spec wins. Examples use the [demo seed](demo-seed.md), Fri Sep 25, 2026, 10:41 PM.

## Rooms, time and bookings

- **Billable guests.** The number of guests a room's time is billed for: the larger of the party size and that business date's minimum (3 on weeknights, 4 on Friday and Saturday at West 4). Sam O.'s party of 3 bills as 4 on a Friday. In the VIP room, a party of 20 or more pays the flat VIP rate ($250 an hour) instead. ([Money rules](spec/05-money-rules.md), rule 3)
- **Booking.** A room reserved for a party at a time, usually with a deposit. Every booking gets a real room when it is made; the guest sees only the size tier. Statuses: `pending`, `confirmed`, `checked_in`, `no_show`, `cancelled`, `completed`. ([Data model](spec/04-data-model.md))
- **Business date.** The night a sale, payment, shift or drawer move belongs to: its local time minus the venue's day cutover (6:00 AM at West 4). A 2:30 AM Saturday sale belongs to Friday. Day-of-week rules, such as the minimum guests, use it. ([Money rules](spec/05-money-rules.md), rule 2)
- **Check-in.** The sheet that turns a booking or a walk-in into a room session: party size with the billable minimum ("3 guests · Fridays bill at least 4"), IDs checked ("3 of 4"), the room, when the clock starts, the deposit applied, and a new room code texted to the host. The sheet is the same on the Board and on staff phones. ([Staff screens and the bar POS](spec/10-staff-screens-bar-pos.md))
- **Cleaning.** The room state after a party leaves ("Needs a wipe · left 10:33 PM (8 min)"). Staff mark it done, and it is flagged after 8 minutes. Cleaning minutes are also reserved between bookings.
- **Deposit.** Money a guest pays when booking. At West 4 it is the first hour: $10 for each billable guest, or a flat $250 from 20 guests. A deposit is a payment, never a line. It is allocated to the check at check-in, so it comes off the bill (Room 9: −$120.00). ([Money rules](spec/05-money-rules.md), rule 11)
- **First-hour minimum.** A session shorter than an hour is billed as one hour, at its first segment's rate. It applies once per session. Room 5, 41 minutes in, shows $40.00.
- **Host and friend.** The host is the guest who gets the Room code text at check-in and joins from its link. Everyone else who scans the wall code and enters the room code joins as a friend. The host can cancel orders and use the host lock.
- **Host lock.** A switch only the host has. While it is on, friends can see the menu but can't send orders. It is off in Room 9. Whether a new session starts with it on is a setting (`hostLockDefault` in the `ordering` settings).
- **Late and no-show.** A booking whose party isn't there is Late, and its room is held until a time staff set ("running 15 late" holds Room 2 until 10:45). Mark no-show is allowed only after the 15-minute grace, and it frees the room.
- **Minimum spend.** A minimum a party must spend, set per room size and day in Admin → Hours & prices. Where one is set, the tile, DeskRoom and the room page show "$84 to your minimum". It is off at West 4, so West 4 screens show nothing for it.
- **Out of service.** A room state set by staff or by a fault (Room 4: "Mic dead since Tue. Replacement ordered."). Its tablet is off, and its future bookings are reassigned or listed for a manager.
- **Party size.** The people in the room now. + and − on the room's screens show the new hourly rate and billable minimum, close the current segment and update the ID chip. Lowering it after the gratuity applies needs approval.
- **Room code.** A 5-character code for a session, texted to the host at check-in with the join link and entered by guests after they scan the wall QR code. A new session or a room move gets a new code, and codes never contain the room number. Room 9's is KX4M7.
- **Room hold.** A room set aside for a short time. It is not a card hold. A slot being paid for online, and a waitlist offer, each hold the room for 10 minutes and then release it.
- **Room session.** One party's stay in a room, from check-in to close-out: its clock, room code, guests, check, IDs checked and any cut-off. It starts from a booking or a walk-in. Room 9's began at 8:00 PM.
- **Room state.** One of available, in use, wrap-up, cleaning or out of service. The Board's tile words add detail: "In room · 19 min left"; "Staying · 41 min past" (past the booked end, nobody booked next); "Needed now · 11 min past" (past the end, with a booking next); "Wrap up · 4 min left"; "Needs a wipe"; "Open · free all night"; "Out of service".
- **Room time.** The room's hours on a check: for each segment, billable guests × the rate × the minutes, added up and rounded once to the cent. "Room time so far" is the same figure while the clock runs.
- **Segment.** A stretch of a session billed at one rate for one party size in one room. A party-size change, a time band, a room move or a pause closes one segment and opens the next, on the minute. Room time is billed from the segments. Room 9 has one: 161 minutes at $120 an hour.
- **Soft end time.** The booked end never stops the clock. When a booking or a waitlist party needs the room, staff and the room screen get wrap-up prompts, and time keeps billing by the minute until close-out. Nothing runs past the night's close.
- **Stay on by the minute.** What a party may do after its booked end when nobody is booked next: keep the room and pay by the minute until we close at 4 AM. Say this, never "Stay as long as you like".
- **Tab so far.** Room time so far plus the drinks accepted so far, before tax and gratuity. It is the amount on the Board tile: Room 9 shows $480.00.
- **Time band and billing step.** A band is a period (by day and time) with its own rates. Each band also sets a billing step of 1, 15, 30 or 60 minutes and a rounding rule. West 4 bills by the minute, so the step changes nothing there.
- **Waitlist.** Parties waiting for a room. An offer holds a room for 10 minutes, texts the party and shows a countdown. If it isn't claimed, the room goes to the next party that fits. The Board's drawer and the phone's Waitlist tab show the same rows.
- **Walk-in.** A party with no booking. Leo M. in Room 5 was seated from the waitlist at 10:00 PM. "+ Walk-in" opens the check-in sheet with a free room.
- **Wrap-up.** The prompts sent when a booked end is near and someone is booked next: the Please wrap up text, 10 minutes before the end, and the Board's alerts. The clock keeps billing until close-out.

## Orders and the bar

- **86 (86'd).** An item that is out tonight. It greys out in its slot, marked "86'd tonight", on every staff screen and on the guest menu, until someone taps it again or the night closes. Tonight: Hoegaarden, Casamigos Blanco and Casamigos · bottle.
- **Accept.** The bar takes a room order. Accept is the sale: the order's lines join the check at that moment and a ticket prints. Delivered charges nothing. No screen offers Ready or Delivered on an order that hasn't been accepted.
- **Alcohol window.** The hours alcohol may be sold, from the rule pack. At West 4 the last sale is 4:00 AM, with 30 minutes of drinking-up time. Every route that creates an alcohol line checks it and a refusal answers `409 alcohol_closed` or `409 cut_off`. From 4 to 8 AM every alcohol button is greyed out, with the reason in words.
- **Allergy notice.** The notice about food allergies on every menu while the Kitchen module is on: the room page, the room tablet, the website menu and the menu PDF. Its words are set in Admin → Kitchen once the lawyer confirms them; until then the module stays off. ([Kitchen and food](spec/16-kitchen.md), a draft awaiting approval)
- **Allergy note.** The guest's optional note on a food order ("Allergies or notes for the kitchen", wording for the lawyer to confirm). It prints boxed on the kitchen ticket, "ALLERGY: …", and is never texted or kept on the guest's record. ([Kitchen and food](spec/16-kitchen.md), a draft awaiting approval)
- **Approval.** A request that waits for a manager other than the requester, decided on the approver's own phone. It covers comps and voids over the reason-only limit, refunds, room-clock pauses, tips over 25%, paid-outs over the limit, a lower party size after the gratuity, and charging a saved card without the guest. The requester's screen shows "Waiting for Andy", then the decision. Andy's own requests go to Abhishek. ([Tenancy and access](spec/02-tenancy-access.md))
- **Asked to wait.** A room order the bar has asked to wait (status `held`). The guest sees "The bar needs a few minutes". It stays in Waiting for you, keeps aging and still needs Accept. It is not a sale. Never call it a "hold".
- **Bar orders.** The bar orders screen, where room orders show in five columns (Waiting for you, Being made, Ready for a runner, Delivered tonight, Returned), and the Board's badge, "Bar orders · 2", which counts every ringing and asked-to-wait order.
- **Bar POS.** The desktop screen where bartenders ring drinks, open tabs and take payments. On the design boards it is the Rail.
- **Bar tab.** A tab for one person at the bar, opened with a card tap. It opens with a $50 hold that grows as rounds are sent, and it closes on the reader with a tip. One card has one open tab. A tab still open at 4:30 AM is charged.
- **Clear-out check.** At 4:30 AM, the close plus the drinking-up time, the Board and Close the night ask: "Walk every room and the bar · no drinks left out". Done records who and when ("Clear-out check · Andy · 4:31 AM"). The night can't close before it is done.
- **Close the kitchen.** A manager marks every kitchen item out until close, and the guest menu shows food as "Kitchen closed". Orders already accepted still print and run. "Reopen the kitchen" undoes it the same night. ([Kitchen and food](spec/16-kitchen.md), a draft awaiting approval)
- **Comp.** The house pays for a drink the guest had: a negative line pointing at the original, with a reason and whether the drink was made. Labeled COMP.
- **Cut off.** Stopping alcohol for a tab, a room or one guest. It records who, why and when ("Cut off by Andy at 10:30 PM"), greys out alcohol on every screen, cancels unaccepted alcohol orders and logs a refusal. Singing is still fine. Owners, managers, bartenders and the front desk can cut off; a runner returns the order with a reason and a manager decides. Not the same as the tab cut-off, which is a job that charges tabs.
- **Drinking-up time.** The time after the alcohol window closes for guests to finish: 30 minutes at West 4, so until 4:30 AM. The clear-out check and the tab cut-off happen then.
- **Escalation.** How a room order that nobody accepts gets louder. See [the escalation sentence](#the-escalation-sentence).
- **House last call.** The venue's last-call time in Admin (4:00 AM at West 4). "Last call" means only this, never charging the tabs.
- **In the kitchen.** An accepted food order the kitchen is making: "In the kitchen · ticket printed · 6:12" on the bar orders screen and every staff phone's Runs. The bar has no Ready button for it; the runner taps Picked up. ([Kitchen and food](spec/16-kitchen.md), a draft awaiting approval)
- **Kitchen ticket.** The slip that prints on the kitchen printer when a food order is accepted, with the room or tab, the lines and any allergy note, and no prices. It follows the rules of a [ticket and reprint](#orders-and-the-bar), plus "Kitchen ticket didn't print · Reprint" and Print at the bar instead. ([Kitchen and food](spec/16-kitchen.md), a draft awaiting approval)
- **Made (waste).** On a void or comp, whether the drink was made. It flags waste for reports. Phase 1 keeps no stock.
- **Manager on duty.** The manager who answers for the night. Andy C. is on duty tonight. Approval requests go to the manager on duty, an order that is still ringing at 4 minutes tells them, and they answer for both house drawers. When it changes, the drawers are counted and handed over.
- **Picked up.** The runner's one tap when a food order is up in the kitchen. It records Ready and I've got it together, so the order reads "On its way · Andy". ([Kitchen and food](spec/16-kitchen.md), a draft awaiting approval)
- **Quick sale.** A sale rung with no tab and paid at once, by card or cash. Each person has their own.
- **Ready for a runner.** A made order waiting to be carried. It shows on every staff phone's Runs, and the runner taps I've got it.
- **Reason-only limit.** A comp or void of up to $25 each and $75 a shift per person needs only a reason. Over either number, a manager approves. The shift total counts every screen, and practice checks don't count. Maya has used $12 of her $75, so her screen shows "$63 left this shift". ([Tenancy and access](spec/02-tenancy-access.md))
- **Repeat round.** Copies the last round onto the tab, leaving out anything 86'd or blocked and saying so.
- **Return (Couldn't serve).** A runner brings an order back with a reason: "No ID for someone who ordered", "Someone looks too drunk", "Nobody in the room" or Other. The manager on duty sees it. The bar picks Void · not made, Void · made (waste) or Remake. For "Someone looks too drunk", the screen offers "Cut off Room 9?".
- **Room order.** Drinks ordered for a room by a guest or by staff. It moves through the [order statuses](#order-statuses), and the sale happens at Accept.
- **Runner and Runs.** A runner is a person carrying orders to rooms (the Staff role, or anyone with the Runner duty). Runs is the list on every staff phone: I've got it, then Delivered or Couldn't serve….
- **Same again.** A guest's one-tap re-order of the room's last delivered rounds. It still rings the bar.
- **Station.** Where an item is made and its ticket prints: the bar or, with the Kitchen module on, the kitchen. Options print on their item's ticket, and a basket with lines for both stations becomes one order per station. ([Kitchen and food](spec/16-kitchen.md), a draft awaiting approval)
- **Ticket and reprint.** The slip that prints at the bar when an order is accepted. If the printer doesn't confirm it, the screen shows "Ticket didn't print · Reprint", and the reprint prints "REPRINT 2".
- **Unsent drinks.** Drinks rung but not sent. They are saved on the server per person and per tab, so a badge swap or a crash loses nothing. They are not on a check. Diego has one: a Red Bull on Tariq A.'s tab.
- **Void.** The sale is taken back: a negative line pointing at the original, with a reason and whether the drink was made. Labeled VOID.

## Money, cards and cash

- **Allocation.** How much of a payment goes to which check. A check's amount due is its lines minus what's been paid or is in progress. A deposit is allocated at check-in, and a tab hold's allocation follows the tab's lines up to the hold. ([Money rules](spec/05-money-rules.md), rule 12)
- **Amount due (Left to pay).** What is still owed on a check. Room 9's is $498.60 after its deposit.
- **Blind count.** Counting a drawer without seeing what it should hold. A difference over the venue's limit needs a note. Close the night counts both drawers blind.
- **Break-glass card.** The one-page card kept at each desk: when our cloud is down, take cards with Tap to Pay in Stripe's Dashboard app on a manager's phone, and match them later in Unmatched payments. If Stripe is down too, take cash. ([Devices, printing and offline](spec/09-devices-printing-offline.md))
- **Capture.** Taking the money for a card payment that was only authorized. A bar tab is captured when it closes, or by the 4:30 AM tab cut-off. The card is charged only at capture.
- **Card fee.** A credit-card surcharge or a cash discount. Off at West 4.
- **Card on file.** A card saved from an earlier payment, such as Marcus's Amex ··1005 from his deposit. Charging it at close-out needs the guest to confirm on their phone ("Waiting for Marcus to confirm on his phone"), or a manager's approval if they have left.
- **Check.** The bill for a room session or a bar tab: its lines, tax, gratuity and payments. Room checks carry the gratuity and bar tabs don't. Room 9's is #1042. Practice checks in training mode are numbered T-0012 and so on.
- **Check revision.** A finalized version of a check. Presenting writes revision 1. If a manager reopens the check and it changes, the next finalize writes revision 2, which reverses revision 1's tax and gratuity and writes new ones.
- **Drawer per person.** The other cash-drawer model, set in Admin → Cash drawers and starting the next business date. Each bartender opens their own session by counting in the starting bank, and only they take cash into it. At a shift change the session is counted, or its tray is pulled and counted at close.
- **Drop, paid-out and no-sale.** Kinds of drawer move. A drop hands a staff bank in to a drawer. A paid-out takes cash out for an expense, and one over the limit needs approval. A no-sale opens the drawer with no sale and asks for the PIN again.
- **Gratuity.** The 20% service charge on room checks at West 4: on room time, items and songs after comps, before tax, never on a damage fee. It is not taxed. With it on the check, the reader skips its tip screen and receipts print "Gratuity included (20%)". Not the same as a tip.
- **Hold.** Money reserved on a card, not yet charged. A bar tab opens with a $50 hold. "Hold" means only this: for a room order say "Ask the room to wait", and for a room set aside see Room hold.
- **House drawer.** The cash-drawer model West 4 uses. Each drawer has one open session that everyone at its screen rings into, and the manager on duty answers for it. West 4 has two: the bar drawer on the bar receipt printer's kick port and the front-desk drawer on the front-desk printer. Cash goes into the drawer at the screen where it is taken ("Logged to Maya · bar drawer").
- **Incremental authorization.** Raising a hold as a tab grows. The steps are sized to finish within 8 of Stripe's 10 attempts, keeping 2 for closing. A declined raise leaves the old hold good and shows "Hold raise declined": new drinks need a manager's OK until another card is added. Luis M.'s hold grew from $50 to $80. ([Payment flows](spec/07-payment-flows.md))
- **Largest remainder.** How a divided amount is shared so the parts add up exactly: round each part down, then give the leftover cents to the largest remainders, with ties to the first parts. $32.66 in two is $16.33 + $16.33, and $32.67 is $16.34 + $16.33. ([Money rules](spec/05-money-rules.md), rule 1)
- **Overcapture.** Capturing more than the hold. On cards that support it, Stripe lets a bar capture up to 50% more than the hold, or $50 more, whichever is greater. Above that, the close raises the hold first.
- **Pay my share.** On the guest's room page once the check is presented: "My items" or "An even share (1 of N)", with their share of tax and gratuity, paid by Apple Pay, Google Pay or card. Room 9's $498.60 in 12 shares is $41.55 each. On at West 4.
- **Present the check.** Finalizes a room's check and locks ordering from the room. Guests' phones read "Your bill is ready · ordering is closed". It is refused while any order is ringing or asked to wait. A manager can Reopen the check.
- **Reader.** A Stripe Reader S710 with cellular. West 4 has two, the Bar S710 and the Front desk S710, and a card payment picks one first.
- **Reconciler.** A job that runs every 5 minutes. It settles card payments whose result was unknown and finds Stripe payments with no record. A payment it can't match goes to Unmatched payments.
- **Refund cap.** A refund can never exceed what was captured on that payment minus earlier refunds. Marcus has only his $120 deposit captured tonight, so his cap is $120.00.
- **Staff bank.** Cash a person holds outside a drawer, such as cash taken on a staff phone at a room close-out. It stays theirs until they drop it into a drawer, which the clock-out checklist asks for.
- **Tab cut-off.** The 4:30 AM job that closes every bar tab still open and captures its balance, up to the hold plus the overcapture allowance. Not the same as Cut off, which stops alcohol.
- **Tax.** 8.875% at West 4, on room time, drinks and damage fees. It is worked once per rate for each check revision, on the lines after comps. The gratuity isn't taxed.
- **Tip.** What a guest adds on top. Bar tabs tip on the reader (18%, 20% or 22% of the drinks before tax, or $1, $2 or $3 on a tab under $10) or on a paper slip. On a room check it is the "Additional tip (optional)" line. Not the same as the gratuity.
- **Tip pool.** How tips and gratuity are shared out after a night. At West 4 it is by hours worked, among the duties that share. Owners and managers never share.
- **Tips to enter.** The staff phone's list of signed paper slips waiting for a tip, each with a photo of the slip. A tip over 25% or $50, or one entered more than 2 hours late, needs approval. Close the night shows "3 slips not entered · tips post to Sat Sep 26".
- **Unknown result.** A card payment whose outcome isn't known yet, after a timeout or a reader that went quiet. Staff see "Checking with Stripe · don't retry", and no second payment can start for that amount until it resolves.
- **Unmatched payments.** Stripe activity with no check behind it, such as a break-glass payment. A manager matches each to a check.
- **Walkout.** A guest who leaves with a tab open. Charge the remaining tabs, or the 4:30 AM tab cut-off, captures the balance from the held card.
- **X report and Z report.** The night's sales report. Until the night closes it is the running X report ("Print X report (running)"), and after the close it is the Z report ("Print Z report"). The Z report splits drinks into room checks and bar tabs, takes the gratuity from room checks only and leaves out practice checks. ([Money rules](spec/05-money-rules.md), rule 16)

## Songs and texts

- **Adapter.** The interface each song system sits behind. Phase 1 runs every system as `none`, so staff mark songs Started by hand. ([Song systems and texts](spec/11-song-systems-texts.md))
- **Bar mode.** The queue and credits for singing at the bar. It is on at West 4 with the offer "Buy a drink, get a song". Singers join from their phones, and songs rotate round-robin.
- **Drink credit.** One song credit, earned by each drink a singer buys (also called a song credit). A song started on a credit posts a $0.00 song line. Skip returns the credit. A singer with no credit is flagged "Needs a drink credit", and a cut-off from alcohol never stops anyone singing. West 4 has set no price for a song without a credit.
- **Inbox.** The two-way inbox behind Messages. A guest's reply lands on their booking, waitlist spot or room session. Staff can type free text only as a reply in an open service conversation, and links and promotions are blocked there.
- **KJ.** The person running the singing queue, and the KJ's song-queue screen on the desktop app. The KJ songbook is a CSV upload of title, artist and code.
- **Play log.** The record of each song started: who, what and when.
- **Queue page.** The singer's page on their own phone: joining, song search, My songs, their place in line and their credits. It is reached from the website's "Sing at the bar" and from the QR code on the Up next TV.
- **Round and rotation.** Songs rotate round-robin by singer, one song per singer per round at West 4 (it is round 3 tonight). A staff override, moving a song up or down, needs a reason and is logged.
- **Send the singer a drink.** A gift order, charged to the sender's tab, that rings the bar like any order. It checks the alcohol window and the receiving singer's tab, and the bartender checks ID at hand-off.
- **Service text and marketing text.** Service texts (12) run a booking or a visit. Marketing texts (2: Review ask and Birthday) need their own opt-in, and both are off at West 4.
- **Songbook.** The song catalog that the queue page's search reads. It comes from a file the song vendor supplies or from a KJ upload, and is never scraped.
- **Started and Skip.** Staff tap Started as each song begins: it posts the song line to the singer's tab, or uses a credit, and writes the play log. Skip is free, and a credit held for the song comes back.
- **Up next TV.** The TV at the bar in bar mode. It shows who is singing now, the next 5 singers and a QR code to join. It never shows phone numbers.

## People, devices and access

- **Admin.** The settings area of the staff app. It needs a passkey, and a PIN never opens it. Managers see every section except Payments, Team and Console.
- **Badge.** An NTAG 424 DNA tag on a card, fob or wristband, paired to one person and read by a USB reader at the bar computer or the front desk. Tapping it takes over the screen in about a second. A copied tag or a replayed read is refused. Refunds, cash counts and no-sale ask for the PIN again.
- **Console.** Our own staff's tool, on its own address, with single sign-on and a FIDO2 key. Phase 1 has the minimal Console. Not the same as Admin → Console, where a venue's owner approves our support access.
- **Desktop app.** The staff app inside an Electron shell on the bar computer and the front-desk computer. It adds the alarm sound, USB printers, the cash drawer, the badge reader, an encrypted read-only cache and a watchdog. ([Scope and architecture](spec/01-scope-architecture.md))
- **Device and pairing.** Every screen, printer, reader and phone that talks to us is a device, paired with a one-time code. Each checks in every 30 seconds, and two minutes of silence in opening hours raises an alert to the venue's manager.
- **Idle lock and Wipe screen.** The idle lock locks a shared screen after 3 minutes. Wipe screen turns touch off for 10 seconds so the glass can be cleaned.
- **Kiosk mode.** How the room tablets run: the guest web in managed kiosk mode, showing the clock, the running total, the menu and call staff. Online only, no PIN pad. Between sessions it reads "Room available".
- **Membership.** A person's place at a venue, with their role, language, PIN and badge. Deactivating a membership ends its sessions and device keys at once and keeps its records.
- **Offline code and queue mode.** When the venue is offline, the desktop app is read-only. A manager gives an offline code that opens queue mode, where new orders queue and each round shows "queued · not charged". After the connection returns, every queued order lands as asked to wait, under "Confirm replayed orders".
- **Passkey.** The sign-in that opens Admin and that approves requests on a manager's phone. A PIN can do neither.
- **PIN.** A staff PIN has 4 digits and a manager or owner PIN has 6. Each person picks their own from the invite link on their own phone. Shared screens show name tiles, so every try counts against one person. Five wrong tries lock that person on that device for 1 minute, then 5, then 15. The demo PINs in the [demo seed](demo-seed.md) are for staging only.
- **Staff app and staff phone.** The staff app runs in a browser, on a phone (installed to the home screen, with push) and on desktop screens. A personal phone is a device too, so removing a person revokes it.
- **Training mode.** Set per person or per device for a new hire. Screens show a permanent "TRAINING · not real money" band, practice checks are numbered T-…, pay only through Stripe's sandbox and stay out of every total. ([Security and data retention](spec/12-security-retention.md))
- **Venue and venue wall.** A venue is one location, such as West 4. Every venue's rows are walled off in Postgres with row-level security, so venue A can never read venue B's data.

## Setup and rules

- **Module.** A feature a venue can switch on or off in Admin → Features, such as Ordering from the room or Bar mode. A venue can switch 19 modules, and 13 are on at West 4; 4 core modules are always on. A module can be on only while what it needs is on: Ordering from the room needs Bar screen & tickets. A route of a module that is off answers `404 module_off`. ([Settings, rule packs and modules](spec/03-settings-rule-packs-modules.md))
- **Phase.** The build has five phases. Phase 1 puts West 4 live on a backend built for many venues, in the nine [milestones](milestones.md). Phase 2 makes the product something a second venue can set up: the wizard, the website builder, the full control panel, Korean and Chinese staff screens. The [blueprint](blueprint.md) has all five.
- **Rule pack.** Versioned data for one place: the tax table, the alcohol window, wage rules and limits. West 4 uses `us-ny-new-york-county`. Money math and settings screens read limits only from here, never from code. A new version publishes only with two approvers on our side, and applies at the next business-date boundary.
- **Setting.** A value a venue controls in Admin, saved as a new version and checked against the rule pack. A change is live at once, except the drawer model, tip-pool changes and bar POS layouts, which start at the next business date.
- **Venue flag.** A beta or rollout switch (`venue_flags`), separate from modules. New behavior reaches our own test venue first.

## The words on screen

### Order statuses

One set of words on the bar POS, the bar orders screen, the Runs tab, the Board and the guest's phone. The buttons for each step are in [Staff screens and the bar POS](spec/10-staff-screens-bar-pos.md).

| `orders.status` | Staff screens show | The guest's phone shows |
| --- | --- | --- |
| `ringing` | Ringing · 0:43 | Sent to the bar · you can still cancel |
| `held` | Asked to wait · 1:20 (still in Waiting for you, still aging, still needs Accept) | The bar needs a few minutes |
| `accepted` | Being made · "Accepted by Maya · 10:33 · on Room 9's tab · ticket printed" | Being made · on your tab |
| `ready` | Ready for a runner · 4:00 | Being made · on your tab |
| `on_the_way` | On its way · Andy | On its way to Room 9 |
| `delivered` | Delivered · 10:52 · Andy | Delivered |
| `returned` | Couldn't serve: *reason* · Andy | Your server will come by |
| `cancelled`, reason `guest` or `staff` | Cancelled by the guest, or by Diego | Cancelled · nothing charged |
| `cancelled`, reason `declined` | Declined by the bar · *reason* | The bar couldn't take this order · nothing charged, with the reason |
| `cancelled`, reason `alcohol_closed` | Cancelled at 4:00 AM | The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged |
| `cancelled`, reason `cut_off` | Cancelled · cut off by Andy | Your server has paused alcohol for this room |

- **Accept is the sale.** Delivered charges nothing.
- **Cancels.** The guest can cancel only while an order is ringing or asked to wait, and nothing is charged. A decline needs a reason, and the guest sees it. After 4 AM there is no Decline button: alcohol orders nobody accepted are cancelled automatically.
- **The main path on the guest's phone:** Sent to the bar → (The bar needs a few minutes) → Being made → On its way to Room 9 → Delivered.

### Say this, not that

Use the right column on every screen, text, receipt and test. These are the rows of the [fix brief](archive/fix-brief-sep28.md#417-vocabulary-f41-c24-c25) (4.17), plus the last row, which the [spec](spec/10-staff-screens-bar-pos.md) added.

| Replace | With |
| --- | --- |
| "Hold" for a room order | "Ask the room to wait" (the chip says "Asked to wait"). "Hold" now means only a card authorization. |
| "Last call" on Close the night (charging every tab) | "Charge the remaining tabs". "Last call" is only the house last-call time in Admin. |
| "Close out" on the phone list | "Tab & close out →". It opens the room tab and never marks a room paid by itself. |
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

Two more copy rules. Prices on the site read "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour". Admin's old "Ring the bar until someone accepts" alarm toggle is gone: the aging times, the chime and Mute replace it.

### Roles

Five roles, the same list everywhere: Admin → Team, Setup, the sign-in screen's home links and the bar POS. The permission table is in [Tenancy and access](spec/02-tenancy-access.md).

| Role | At West 4 | What they do | Home | PIN |
| --- | --- | --- | --- | --- |
| Owner | Abhishek G. | Everything, including Payments, Team and Console in Admin. Approves the manager's own requests. | Tonight's board | 6 digits |
| Manager | Andy C., the manager on duty | Approves requests, closes the night, Admin except Payments, Team and Console. | Tonight's board | 6 digits |
| Bartender | Maya S. | Bar POS, accepting room orders, comps and voids within the limit, counting the bar drawer. | The bar POS | 4 digits |
| Front desk | Diego R. | Check-in, waitlist, bookings, guest texts, payments and close-out. Covers the bar when the bartender is on break (Admin can switch the bar POS off for this role). Counts the front-desk drawer. | Tonight's board | 4 digits |
| Staff (runner) | none tonight | Carries runs. Check-in and the waitlist only. | The Runs tab on their phone | 4 digits |

- The front desk was called "Staff" on the old boards. It is its own role now.
- **Duty** is not a role. Clock-in asks for the duty (Bar, Front desk, Runner or Manager), and the tip pool uses it. Permissions come from the role.
- Owners and managers never share the tip pool. Bartenders, the front desk and runners do.

### The escalation sentence

Use this exact sentence wherever escalation is described, in Admin, Setup, the Console, the spec and the tests:

> Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup.

The Board gets an alert at 2 minutes. At 4 minutes it says "on Andy's phone", and at 6 minutes "texted Andy". Don't describe it as ringing the bar until someone accepts: that alarm toggle is gone (see [Say this, not that](#say-this-not-that)). ([Staff screens and the bar POS](spec/10-staff-screens-bar-pos.md), [Devices, printing and offline](spec/09-devices-printing-offline.md))

### Other exact sentences

| Where | Wording |
| --- | --- |
| Opening a bar tab (read to the guest) | "We'll hold $50 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader." |
| The check is presented (guest's phone) | "Your bill is ready · ordering is closed" |
| A ringing order blocks the check | "2 × Margarita · Peach is ringing at the bar · accept or cancel it first" |
| Card payment states | "Waiting for a tap on the front-desk reader · Cancel", "Declined · try another card or cash", "Checking with Stripe · don't retry", "Reader offline · use the bar reader", "Reader busy" |
| An approval is pending | "Waiting for Andy", and "Approvals · 1" on Andy's phone |
| A tab's hold could not grow | "Hold raise declined" |
| A tab is cut off | "Cut off by Andy at 10:30 PM" |
| Alcohol paused (guest's phone) | "Your server has paused alcohol for this room" |
| The 4 AM stop (guest's phone) | "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged" |
| The clear-out check | "Walk every room and the bar · no drinks left out" |
| Print failure | "Ticket didn't print · Reprint", then "REPRINT 2" |
| Room calls (guest's phone) | "Staff get it on their phones" |
| A room move (guests' phones) | "You've moved to Room 11 · new code …" |
| A failed room-ready text | "Not delivered · Call" |
| No occupancy limit set | "Limit not set · Admin → Safety" |
| No song price set | "Song price · not set · songs need a drink credit" |
| Training | "TRAINING · not real money" |
| Modules | "Room orders would have nowhere to ring. Turn off Ordering from the room too?" |
| Outage banners | "On backup internet · card readers may take up to 2 min to switch" (amber), "Offline · read-only · orders queue with an offline code" (pink), "Stripe is having trouble · card payments may fail", "Texts are delayed" |
| The Board's footer | "Online · synced 4 s ago" |
| Tips on paper | "3 slips not entered · tips post to Sat Sep 26" |
| A guest's share | "Paid by a guest · Kevin (share 1 of 12) $41.55" |
| Cash into a drawer | "Logged to Maya · bar drawer" |
| Moving a tab to a room | "Moved to Room 9" on the tab, "Moved from Jess P.'s bar tab" on the room's check |

## Board names and finding codes

**Boards.** The design canvas is 27 files in [`design/canvas/`](../design/canvas/), called boards. Its docs use the file names: "the Board" is `Board.dc.html`, the Tonight board. [Design](../design/README.md) says how to view them, and [screens](screens.md) says what each becomes.

| Name in the docs | What it is |
| --- | --- |
| Board | The Tonight board on the desktop app: 14 room tiles, alerts, the waitlist drawer |
| Rail | The bar POS on the desktop app |
| Bar | The bar orders screen |
| DeskRoom, Room | The room tab and clock, on desktop and on a staff phone |
| Night | Close the night |
| Staff, Pin | The staff phone's home, and its sign-in |
| Order | The guest's room page on their own phone |
| Main, Rooms, Menu, Parties, Book, Manage, Waitlist | The guest website's pages |
| Calendar, Messages, Reports | Staff phone screens. Each has a desktop twin: DeskCalendar, DeskMessages, DeskReports |
| Admin, AdminDesk | Admin. It moved from the phone to the desktop app |
| Setup, SiteBuilder, Console | The product for other venues |
| KJ, SingQueue, UpNext, Receipt | Boards that were planned and never drawn. Build them from the spec |

**Codes.** F, C and K are findings of the Sep 28 [flows](archive/review-flows-sep28.md) (F1 to F55), [completeness](archive/review-completeness-sep28.md) (C1 to C37) and [competitive](archive/review-competitive-sep28.md) (K1 to K21) reviews. GA-M, GA-S and GA-N are gap-analysis items. D is a [decision](decisions.md). M1 to M9 are the [milestones](milestones.md). [Screens](screens.md) maps every finding to the boards it touches.
