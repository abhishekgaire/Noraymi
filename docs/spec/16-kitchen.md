## Kitchen and food

**Approved by the founder on Oct 9, 2026.** It is built from the tickets in [K · Kitchen](../backlog/K-kitchen.md), and the decisions behind this file are [D98](../decisions.md) and, for Send to kitchen and drink tickets, [D99](../decisions.md) (the founder's answers of Oct 9). Open points it names stay cautious defaults, as settings, until [open questions](14-open-questions.md) answers them.

The first venue to go live is **Sing Sing Karaoke, Astoria (Queens, NY)**, then West 4. Sing Sing runs the same way as West 4, with the same rules, the same kind of rooms and bar and the same managers, but it has 6 rooms and a kitchen. This file adds only what the founder asked for on Oct 9: food that guests and staff order like drinks, a ticket that prints on a kitchen printer (at Accept for a guest's order, at Send to kitchen for food staff ring), runners who take the food to the rooms, food inside some packages, and the allergy notice. The kitchen manages its own timing; the software doesn't.

Sing Sing's own facts (its menu, prices, hours, legal name, tax numbers, licenses and team) are entered by its managers in Admin, Stripe's onboarding and the Twilio registration. Nothing in this file or the tests invents them: tests use a test-only menu clearly marked as such, never a made-up Sing Sing menu.

**What a food order looks like, start to finish** (the room and the items are examples, not Sing Sing's)

1. A guest in Room 3 orders wings and two beers from their phone, the same way they order drinks.
2. The room page sends one order for the bar (the beers) and one for the kitchen (the wings). Both ring at the bar.
3. The bartender taps Accept on each. Accept is the sale: the lines join Room 3's check, the bar ticket prints at the bar and the kitchen ticket prints in the kitchen at once, with the guest's notes. The guest already confirmed the order, so there's no Send to kitchen step.
4. The cook makes the wings from the paper ticket. When they're up, a runner taps Picked up on their phone and carries them to Room 3, then taps Delivered.

### The Kitchen module

- **The switch.** Kitchen & food is a module (`kitchen`) like the others in [Settings, rule packs and modules](03-settings-rule-packs-modules.md) · Modules. It needs Bar screen & tickets, because food orders ring and are accepted at the bar. Turning it on also needs a paired kitchen printer and the allergy notice set (below); until both are there, Admin → Features shows "Kitchen · needs a kitchen printer and the allergy notice" and the switch stays off.
- **Guest ordering.** Guests order food from their phones and the room tablets only while the existing "Ordering from the room" module is on, the same switch that lets them order drinks. There's no separate switch for guest food: with Ordering from the room off, food is rung only by staff.
- **What it hides.** With the module off, no item can be routed to the kitchen, food items are hidden from every menu, and the kitchen's words below appear nowhere. Turning it off is refused while a kitchen order is ringing, asked to wait or being made, like any module with open work.
- **Phase 1 scope.** The module ships printed kitchen tickets only. The kitchen display, coursing and the rest are listed under [Not included](#not-included).

**Settings.** One new settings key, versioned and checked like the others:

| Key | Shape | Default | Notes |
| --- | --- | --- | --- |
| `kitchen` | `{ allergyNotice: { en, es } \| null, lastOrder: "HH:MM" \| null, unsentWarnMin: number, afterOutage?: boolean }` | Notice and last order empty; `unsentWarnMin` 5; `afterOutage` absent, read as on | `allergyNotice` is the notice printed on every menu (below); empty shows "Allergy notice · not set · Admin → Kitchen" and keeps the module off. `lastOrder` is the kitchen's last order time on the wall clock; empty means food can be ordered whenever room ordering is open (an [open question](14-open-questions.md)). `unsentWarnMin` is how long staff-rung food may sit Not sent before the order shows the reminder (below), 1 to 60 minutes. `afterOutage` is whether a replayed food order's kitchen ticket prints AFTER OUTAGE (below), the cautious default kept as a setting while the [open question](14-open-questions.md) stands. Managers and the owner change the key in Admin → Kitchen |

The drink-ticket setting, "Print tickets for drinks rung at the bar" (`pos.printBarDrinkTickets`, off by default), isn't part of this module: it applies at every venue ([Staff screens and the bar POS](10-staff-screens-bar-pos.md) · Ringing, D99).

### Stations

- **Two stations: bar and kitchen.** Every menu item has one station (`menu_items.station`, already in the [data model](04-data-model.md), default `bar`). Admin → Menu shows a Station choice on each item only while the module is on. A food item has station `kitchen` and the tax category `food`.
- **Options go with their item.** An option or a variant prints on its item's ticket and can't route anywhere else. "Add fries" on a burger prints in the kitchen; a drink can't send an option to the kitchen. To pair food with a drink, the guest or staff order both items.
- **Each order belongs to one station.** When a basket or a round has lines for both stations, the server splits it into one order per station, placed together (`orders.basket_id`), each with its own status, ticket and run. The guest's phone shows them as two cards, "Drinks" and "Food". Copied at order time like the other fields, `order_items.station` decides which ticket a line prints on.
- **Printers.** The kitchen printer is a printer device with station `kitchen` (`devices.station`). The kitchen has no computer, so it must be a network printer (Star CloudPRNT or Epson Server Direct Print); setup refuses a USB printer for the kitchen. Which model Sing Sing buys is an [open question](14-open-questions.md).

### Kitchen tickets

Kitchen tickets reuse the ticket rules in [Devices, printing and offline](09-devices-printing-offline.md) · Tickets: a guest's food order prints when it's accepted, food staff ring prints when they tap Send to kitchen (below), each creates a print job for the kitchen printer, the printer confirms each job, and an unconfirmed job raises `print_job.failed`.

- **What prints.** "KITCHEN", the room ("Room 3") or the tab ("Bar · Jess P."), the time it was accepted or sent and who did it, then each line with its quantity, options and its note, and no prices. A note marked as an allergy prints under its line boxed, in bold capitals: "ALLERGY: …". A remake prints "REMAKE". Reprint prints a copy of the same ticket stamped "REPRINT" with its count, "REPRINT 2", then "REPRINT 3" and so on (`print_jobs.reprint_n`); a reprint never marks a line sent again or adds anything to the check.
- **Didn't print.** A kitchen job still unconfirmed after three polls shows "Kitchen ticket didn't print · Reprint" on the bar orders screen and the bar POS, and also tells the manager on duty's phone, because nobody in the kitchen watches a screen. Reprint offers the kitchen printer again or **Print at the bar instead**, so a runner can carry the slip to the kitchen. A printer that's out of paper or has its cover open doesn't confirm, so it takes the same path.
- **Printer offline.** The kitchen printer checks in like every device: two minutes of silence during opening hours raises `device.offline` to the manager. While it's offline, every kitchen ticket goes down the "didn't print" path above.
- **Outages.** The kitchen printer asks our cloud for jobs, so it prints nothing while the venue is offline. Orders queued with an offline code replay as asked to wait ([Devices, printing and offline](09-devices-printing-offline.md) · Replay), and accepting a replayed food order prints its kitchen ticket with "AFTER OUTAGE · check with the kitchen before making", because staff may have handed the kitchen a written order in the meantime. Flagged for the founder: this is the cautious default.

### Ordering food

Food follows the room-order rules in [Data model](04-data-model.md) · Room orders and [Staff screens and the bar POS](10-staff-screens-bar-pos.md) word for word, with these differences only.

- **From phones and room tablets.** Only while Ordering from the room is on. The room page and the room tablet show food under a "Food" heading, each of the menu's food categories as its own section in Admin → Menu's order, with the allergy notice. Each food line in the basket has an optional note for the kitchen, "Allergies or notes for the kitchen" (the wording is the lawyer's to confirm; see [open questions](14-open-questions.md)), up to 200 characters, and "This is an allergy", which prints the note boxed. They're stored on the line (`order_items.kitchen_note` and `order_items.kitchen_note_allergy`). Same again works for food and leaves the notes empty.
- **At the bar.** Food orders ring at the bar with the drinks, oldest first, marked with a "Kitchen" chip, and age and escalate on the same clock (`pos.orderAging`). Accept, Ask the room to wait, Decline and the guest's cancel work exactly as for drinks.
- **Accept is the sale.** The food joins the check at Accept and the kitchen ticket prints then, with the guest's notes, because the guest already confirmed it; Delivered never charges.
- **From the bar POS and staff screens.** The bar POS (bar tabs and quick sale), a room tab on desktop or phone, and Open in the bar POS can add food like drinks. On the bar POS, food sits in a Food section, added after the ten fixed sections only while the module is on, so no drink moves from its slot (Staff screens and the bar POS, rule 2). Tapping Food opens a second row of the menu's own food categories (`menu_categories` whose items are station `kitchen`, at Sing Sing Burgers, Chicken Sandwiches, Fried Rice, Korean Ramen, Sides, Combos, Tenders, Wings, Popcorn Chicken and Buckets), named and ordered in Admin → Menu; a category shows only its items, and the bar POS search still covers the whole menu, food included. An item with choices (a size, a sauce, add-ons, "Make it a meal · fries + drink +$5") opens them on tap, and a required choice must be picked before the line goes on (D100). Staff-rung food reaches the kitchen only through Send to kitchen (below), never by itself.
- **Not sent is still sold.** The money rules don't change: food goes on the tab or check exactly when a drink would. On a room tab it's a staff order accepted at once; on a bar tab or a quick sale it goes on with the round at Send, or at Send to kitchen if that comes first, through the same hold-raise and checks. Until it's sent to the kitchen, each food line reads "Not sent" on the tab or check.
- **Send to kitchen.** While a tab, a quick sale or a room's check has food that's Not sent, a "Send to kitchen (N)" button at the bottom is active, N counting the unsent food items. Tapping it opens a confirmation listing only the unsent food lines, each with its options, a note for the kitchen (free text, up to 200 characters) and "This is an allergy", which prints that note boxed and bold. Send prints one kitchen ticket with the tab's or room's name, the items, their options and notes. On a quick sale, which has no name, the confirmation asks for one first, a first name or a label such as Seat 3, as at New tab, so a server can find the guest.
- **Sent.** The lines on that ticket read "Sent · 11:42" (`order_items.kitchen_sent_at` and `kitchen_sent_by`) and are never sent again: a later Send to kitchen lists only the food added since. The server refuses to send a line twice, so two screens tapping at once print one ticket.
- **Removing food.** Food that's Not sent can be removed freely, with no reason or approval, because the kitchen never saw it; the removal is logged with who and when. Sent food comes off only by a void, under the fix panel's rules (Staff screens and the bar POS · Changing a sent drink): made or not made, a reason, the reason-only limit and a manager's approval above it.
- **Not sent reminder.** Food left Not sent for `kitchen.unsentWarnMin` minutes (5 by default) shows "N food items not sent to the kitchen" on that tab, quick sale or room's check, and the same warning shows before the tab or check is closed or paid, with Send to kitchen beside it. Paying anyway is allowed; the warning only reminds.
- **Bar tabs and quick sale.** The kitchen ticket names the tab ("Bar · Jess P."), or for a quick sale the name given at Send to kitchen ("Bar · Seat 3"). Food for the bar isn't a run in the app: a server takes it from the kitchen to the guest by the name on the ticket (the founder's answer of Oct 9).
- **Drinks don't change with food.** Drinks rung on a bar tab or a quick sale print a bar ticket only while "Print tickets for drinks rung at the bar" is on (off by default, D99). Drinks for a room, from a guest or from staff, always print at the bar. Food always prints in the kitchen.
- **No alcohol rules on food.** The alcohol window, cut-offs and ID checks never stop a food-only order, and a food order shows no ID status. The 4 AM stop cancels only unaccepted alcohol orders, as now; a food order keeps ringing. The kitchen stops taking orders at `kitchen.lastOrder`, or when a manager taps Close the kitchen (below).
- **Words.** Guests see the same order words as for drinks ("Sent to the bar · you can still cancel", "Being made · on your tab", "On its way to Room 3", "Delivered"); food adds no guest wording beyond the two card names and the note fields.

### Runners and delivery

The founder's servers are runners in the spec's words (the Staff role, or anyone with the Runner duty).

- **In the kitchen.** A food order shows on the bar orders screen's Being made column once its ticket prints (at Accept for a guest's order, at Send to kitchen for staff-rung food; staff-rung food that's Not sent has no run yet), and on every staff phone's Runs as "In the kitchen · ticket printed · 6:12". The bar has no Ready button for it, because nobody at the bar sees the food. Food for a bar tab or a quick sale has no run; it shows only on its tab or sale, as Sent.
- **Picked up.** When the food is up, the runner taps **Picked up** on their phone. That one tap records Ready and I've got it together (`ready_at`, `claimed_by` and `claimed_at`, with both events), so the order reads "On its way · Andy" and every step still checks the one before it.
- **Then as for drinks.** Delivered, or Couldn't serve… with a reason, which sends the order to Returned, where the bar resolves it with Void · not made, Void · made (waste) or Remake. A remake prints a new kitchen ticket marked "REMAKE" and charges nothing again.

### 86 and closing the kitchen

- **86 a food item or option.** Food uses the existing 86 ([Staff screens and the bar POS](10-staff-screens-bar-pos.md) · 86 from the bar POS, and `menu_items.out_until`, `menu_variants.out_until` and `menu_options.out_until`): it greys out on every staff screen and the guest menu, marked "86'd tonight", until someone taps it again or the night closes. The same roles that 86 a drink can 86 food.
- **Close the kitchen.** A manager's "Close the kitchen" (bar POS and the manager's phone) marks every kitchen item out until close, and the guest menu shows food as "Kitchen closed". Orders already accepted still print and run. "Reopen the kitchen" undoes it the same night.

### Food in packages

The spec doesn't yet say how a package's contents reach the room: phase 1 has packages on the staff menus and the promotion checks, but no step that turns a sold package into tickets. This draft fills that gap the simplest way, for drinks and food alike.

- **When the food fires.** Staff add a package to a room from the room tab, like adding drinks. That makes a staff order, accepted at once: its drinks print at the bar at that moment, and its food goes on the check as Not sent and prints when staff tap Send to kitchen, like any staff-rung food. There's no timer and no "fire at room start"; staff choose the moment, and the Not sent reminder shows after `kitchen.unsentWarnMin`. This is the cautious default and an [open question](14-open-questions.md) for the founder.
- **Picks.** A package's contents name items, or one choice from a modifier group ("one food pick"), which staff choose when they add it.
- **The price on the check.** The package's price is divided across its contents in proportion to their regular prices, by largest remainder (Money rules 1), so every line keeps its own tax category and the parts add up to the package price. The bill groups the lines under the package's name. The accountant confirms this; see [open questions](14-open-questions.md).
- **Checks.** The promotion checks still run when the package is saved. A package with food can't be hourly, because its food prints once.

### Tax

Food lines use the tax category `food`, which the [money rules](05-money-rules.md) and `check_lines.tax_category` already have. Phase 1 has no rate for it. The cautious default taxes food at the same rate as drinks in the rule pack (8.875% in New York City), so nothing is under-collected, and the gratuity base includes food like any item (Money rules 9). Flagged for the accountant: how prepared food is taxed in New York City, and how a package mixing food and drinks is split for tax. The default is rule pack version 2026.10.1 (food among the taxed categories), so the answer becomes a new pack version. Food shows on its own line in the Z report ("Food") and the journal ("Sales · Food"); a package's food stays under Packages.

### The allergy notice

- **On every menu.** With the module on, the allergy notice from `kitchen.allergyNotice` shows on the room page, the room tablet, the website's menu page and the menu PDF, in the guest's language.
- **Wording.** The blueprint ties the notice to [PHL §1356](https://www.nysenate.gov/legislation/laws/PBH/1356). Whether it applies to a bar with a kitchen, and its exact words, are the lawyer's to confirm; this spec never writes the notice itself. Until it's set, the module stays off.
- **Kitchen notes.** A line's note, the guest's or staff's, is printed on the kitchen ticket and shown on the order card, never texted, never on a receipt and never kept on the guest's record. It's kept as long as the order is ([Security and data retention](12-security-retention.md) · How long we keep things); the lawyer confirms that.

### Not included

These stay out until the founder asks for them: a kitchen display screen (the blueprint's K14, phase 2), holds, coursing and firing courses later, an expo station, an allergen database on menu items (`menu_items.allergens` stays phase 2), all-day counts, recall, a prep-time report, takeout, delivery and online ordering from the website, and stock counts.

### Where this touches the rest of the spec

On approval, each of these changes in the same commit as the code that builds it:

- [Settings, rule packs and modules](03-settings-rule-packs-modules.md): the `kitchen` key (with `unsentWarnMin`), Kitchen & food in the dependency table (needs Bar screen & tickets) and in What each module hides.
- [Data model](04-data-model.md): `orders.station`, `orders.basket_id`; `order_items.kitchen_note`, `kitchen_note_allergy`, `kitchen_sent_at` and `kitchen_sent_by`; `menu_items.station` and `devices.station` limited to `bar`, `kitchen` and `front_desk` where they apply; `order_items.package_id`.
- [Devices, printing and offline](09-devices-printing-offline.md): the kitchen printer, the manager told on a failed kitchen ticket, Print at the bar instead, and AFTER OUTAGE.
- [Staff screens and the bar POS](10-staff-screens-bar-pos.md): the Food section after the ten fixed sections with its row of food categories (rule 2, D100), Send to kitchen, Not sent and Sent, the Not sent reminder before closing or paying, "In the kitchen", Picked up, Close the kitchen, and their Spanish strings.
- [Money rules](05-money-rules.md) rule 8: the `food` rate, once the accountant answers.
