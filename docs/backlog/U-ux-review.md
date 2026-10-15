# U · Fewer taps for the bartender (the Oct 15 review)

Oct 15, 2026 · the founder asked for a check that every flow makes sense, the screens are clear, and a bartender has as little to do as possible. Four read-only reviews walked the bar register, rooms and the front desk, the shift and the close, and the app as a whole, counting taps in the code; the founder asked for all of it to be built ([D133](../decisions.md)). File references are where the review found each problem; read the code before changing it, since it may have moved.

**Goal (usable when done):** at Sing Sing (bar computers, the outside card machine, cardless tabs, the 3.38% cash discount, the manager's PIN at the register) a bartender rings, takes and closes every sale in the fewest taps, never sees a panel they can't use, and has one place to look for what needs doing.

**Done when:** every ticket below is done, docs/manual-test.md has a section that walks each one, and the full e2e passes.

**Depends on:** P-01 to P-14. **Size:** about 5 weeks.

**Rules for every ticket:** spec first. Where a ticket changes what the spec says, change the spec in the same commit and cite D133. Nothing here relaxes a money, alcohol, approval or audit rule: approvals and PIN-again still happen on the server, and every void, discount and comp is still audited. Every new choice is a venue setting with a cautious default, in Admin, refused on the server where it matters.

## Suggested order

1. **Sales that break at Sing Sing:** U-01 to U-06.
2. **Fewer steps:** U-07 to U-13.
3. **The shift and the close:** U-14 to U-17.
4. **One place for alerts, clearer words and layout:** U-18 to U-22.

Definition of done: see CLAUDE.md.

## Tickets

### U-01 · The outside card machine on a quick sale, and no reader panel where there are no readers

- **Status:** done
- **Size:** M
- **Depends on:** F (outside card machine), M6 (quick sale)
- **Spec:** [Payment flows](../spec/07-payment-flows.md) · Outside card machine; [Bar POS](../spec/10-staff-screens-bar-pos.md)
- **Build:**
  - Quick sale offers **Outside card machine** next to Cash (QuickSale.tsx about 200–219 offers only the reader and cash), with the amount pre-filled as on a tab.
  - Wherever a payment is taken (quick sale, Close tab, a room's close-out, a split share), the Stripe reader panel shows only when the venue has a registered reader. With none, the outside card machine is the main card button; with both, the reader first.
  - When there are readers, the station's own reader (or the only one) is pre-selected (TapPayment.tsx:63 starts with none).
- **Acceptance:**
  - [x] At Sing Sing (no readers, outside machine on) a walk-up card sale is: drink, Pay, Outside card machine, Done; no empty reader list anywhere.
  - [x] At West 4 the bar reader is pre-selected; one tap sends.
  - [x] Server refuses the outside machine when its feature is off (already so; covered by a test on the quick-sale path).
- **Notes:** Built Oct 15, 2026. One hook, `apps/staff/src/useReaders.ts`, reads the venue's registered readers (this station's first: the bar computer's Bar S710, the front desk's Front desk S710) for TapPayment and the screens around it. TapPayment pre-picks the first reader (`picked` falls back to it until another is chosen) and renders nothing when the list came back empty; a list that can't be read still shows the panel with "Couldn't take the payment" rather than hiding a reader that may exist. Quick sale: no reader → **Outside card machine** (primary) then Cash; readers → the reader panel, Cash, then Outside card machine; the button opens OutsideCardPanel with the sale's amount filled in and **Other ways to pay** (`rail.otherWays`, new, en/es) goes back. Close tab: no reader → no **Another card**, the outside machine in its place (primary on a cardless tab with no saved card). Room close-out and a bar tab's split share: with no reader the outside machine's form comes before Cash (and the split share gains the outside machine, which U-03 builds on for cardless tabs). Cautious defaults: while the reader list loads, the screens treat it as "no reader" so a reader button never shows and then vanishes at a venue without one (at West 4 the reader appears a moment later); the acceptance's "Done" is the outside panel's existing **Record payment** button (the glossary's verb), not a new label; Close the night's failed-tab row is left as it was (only a reader-held card can fail there). No migration, no new route. Tests: `quick-sale.int.test.ts` (outside machine refused while the switch is off, pays the quick sale when on); e2e "U-01 · …" ×3 at the end of `e2e/staff.spec.ts`; "Tap at the reader: Room 9…" now expects Front desk S710 pre-picked instead of "Pick a reader first". Spec 07 (What staff see during a card payment) and spec 10 (Paying at the bar) updated, citing D133; manual test 31.1.

### U-02 · Show the cash price wherever cash is taken

- **Status:** done
- **Size:** M
- **Depends on:** the cash discount (rule 10), P-01
- **Spec:** [Money rules](../spec/05-money-rules.md) · rule 10; [Payment flows](../spec/07-payment-flows.md)
- **Build:**
  - With the cash discount on, the cash screens (CashPanel.tsx 53, 109, 151) show the cash price: the amount due, **Exact**, the bill offers and the change are all worked from it. Today they use the card total and the discount is only taken on the server, so "Exact" shows wrong change.
  - The API returns the cash price with each sale, tab and check (the same `cashPriceFor` as the printed bill), so the screen never works it out itself.
  - The screen shows both prices before the guest chooses: "Card $13.92 · Cash $13.45".
- **Acceptance:**
  - [x] Sing Sing's 3.38%: a $13.92 drink shows Cash $13.45, Exact takes $13.45 with $0.00 change, and the Z report matches. (Built to rule 10: $13.92 shows **Cash $13.41**; see Notes.)
  - [x] money-cases cash-discount groups pass; no float touches an amount.
- **Notes:** Built Oct 15, 2026. The API gives the cash price with every read a cash panel works from, through one helper, `cashPricer` in `apps/api/src/payments/surcharge.ts` (one read of the night's terms, then the same `cashDiscount` rule and food weights `applyCashDiscount` uses when the cash is taken; `cashPriceFor`, the printed bill's, now goes through it): the check read (`checkView`, so the quick sale and a room's close-out) carries `cash_due_cents`, each tab in the tab list `cash_rest_cents`, and Close the night's tabs that couldn't be charged `cash_owed_cents` (`failedTabs` now takes `now`); each is null with the discount off or nothing due. The staff app's `CashPanel` takes `cashCents`: Exact, the $5/$10/$20 offers, the change and **Take … in cash** come from it, while `amount_cents` sent stays the card amount, which the server discounts as before. A new `CardAndCash` line, "Card $13.92 · Cash $13.41" (`cash.bothPrices`, en/es), shows in the cash panel (the quick sale and room close-out show it beside the card buttons), under Close tab's total before a way to pay is chosen, and on Close the night's failed-tab row. **The acceptance's $13.45 is the ticket's arithmetic, not the rule's:** Money rules 10 takes the 3.38% ($0.47) and the matching tax on it ($0.04) off, so a $13.92 amount due is Cash $13.41; built to the spec, pinned by a new money case `cash_discount_sing_sing_cash_price` (test data). Cautious defaults: a split share shows one price (the server never discounts a share, so the cash price would be wrong there); the cash price is for tonight's business date, as the cash is taken; on an open tab with a check discount and food at cash prices (`foodIncludesFee` false) the food weights are the lines before Pay finalizes, so the shown price can differ by a cent from what's taken; Sing Sing (food includes the fee) is unaffected. Found, not changed: `cashDiscountFor` doesn't check the Cash discount switch (`cash_discount` module), only the `pay.cardFee` mode, while the surcharge does; the cash price and the cash taken agree either way. No migration, no new route. Tests: money case above (rules unit); `quick-sale.int.test.ts` "U-02 …" (sale, check and tab carry the rule's cash price, Exact pays it with $0.00 change, the X report's cash is the cash price, null with it off); e2e "U-02 · cash discount: …" at the end of `e2e/staff.spec.ts`. Spec 07 (Room close-out · Cash) and screens.md N21 updated, citing D133; manual test 31.2.

### U-03 · Split a cardless tab

- **Status:** done
- **Size:** S
- **Depends on:** P-03
- **Spec:** [Bar POS](../spec/10-staff-screens-bar-pos.md) · Split; [Payment flows](../spec/07-payment-flows.md)
- **Build:**
  - **Split** shows on cardless tabs too (Rail.tsx about 1574 hides it when `no_hold`); each share can be paid by cash, the outside card machine or a reader, as the venue has them.
- **Acceptance:**
  - [x] A cardless Sing Sing tab splits three ways: cash, outside machine, outside machine; it closes when the last share is paid.
- **Notes:** Built Oct 15, 2026. The server already took it: `POST /tabs/{t}/split` never looked at the hold, a share's `claimShare` leaves out a hold only when there is one, cash and the outside card machine both take a `share_id`, and `takeOverHold` closes a tab with no hold once its allocations cover what's due. So no API change, no migration, no new route and no new strings. The bar POS (Rail.tsx) now shows **Split** on a cardless tab (`cardless`: no payment and no card); SplitPanel already gives every share its own **Pay this share** when there's no held card, and U-01 already put the outside machine (before Cash with no reader) on each share. Cautious defaults: a *reopened* tab with no hold (M6-12) still has no Split, as spec 10 says, since its earlier capture makes its shares a different question; cash shares aren't cash-discounted (existing behavior, as before U-03; U-02 owns the cash price). Tests: `tab-split.int.test.ts` "U-03: split a cardless tab" ×2 (three ways: cash, outside, outside, shares by largest remainder adding to the total, a wrong amount and a paid share refused, the tab `closed` and the check `paid` with Stripe never called; Stop splitting keeps the paid share and the rest closes it); e2e "U-03 · a cardless tab splits three ways…" at the end of `e2e/staff.spec.ts` (the full flow through the UI, as app_rw). Spec 10 (Split) and spec 07 (Bar tab step 8) updated, citing D133; manual test 31.3.

### U-04 · The tab screen: the round first, nothing left unsent, a clean screen after closing

- **Status:** done
- **Size:** M
- **Depends on:** M6
- **Spec:** [Bar POS](../spec/10-staff-screens-bar-pos.md) · Tabs, Send & close
- **Build:**
  - On an open tab the round and **Send** sit right under the tab's header and stay in view; Fix and Discount stay folded until a line is tapped or their button is pressed (today the round renders under Repeat/Split/Move/Print/Close, Fix and Discount: Rail.tsx about 1401–1707).
  - Closing a tab with drinks rung but not sent: **Send & close** (the spec's) sends them and goes to Close tab; the plain Close tab says "2 not sent · Send them first or Send & close" instead of leaving them off.
  - After a tab is closed and the receipt chosen, the screen goes back to Quick sale with nothing selected (today the closed tab stays picked and Repeat round still works on it: Rail.tsx about 1490, 1567).
  - Closing to the card on file: Close tab, Close to the card, the receipt choice ends it (no separate Done) (CloseTab.tsx 200–208, 361–372).
- **Acceptance:**
  - [x] Unsent drinks are never dropped silently; Send & close charges them.
  - [x] After closing, the next drink rings as a new quick sale.
  - [x] Closing to the card is 3 taps.
- **Notes:** Built Oct 15, 2026. Staff app only: no API change, no migration, no new route. **The round first:** on the bar POS (Rail.tsx) Repeat round, the round (AddDrinks) and Send now sit right under the tab's name and chips (and the cut-off control), above On the tab, the total and the actions row (Split, Move, Print bill, Close tab); this holds for a room picked on the bar POS too. Fix a sent drink (FixPanel `foldWhenIdle`) shows nothing until a line is tapped, and stays up while it reports what it just did; Discount (DiscountPanel `folded`) is only its **Discount the check** button until pressed, unless a discount is standing or waiting. Repeat round shows only on an open tab nobody is closing, splitting or moving. **Send & close:** a button beside Send on a tab that can close (open, with a hold or with none); it sends through the same `POST /checks/{c}/orders` as Send (so the 4 AM stop, cut-offs, 86'd items and the hold check apply on the server), and opens Close tab only when the round went on: a round waiting for a manager (hold raise declined) or a raise being checked with Stripe stays unsent and Close tab doesn't open. Unsent food still gets the K-05 warning before Close tab. **Close tab with drinks not sent** (this person's draft) shows "N not sent · Send them first or Send & close" with Send & close and Back to the tab, instead of opening. **After closing:** CloseTab's new `onClosed` sends the bar POS back to Quick sale with nothing picked, the notice "Tab closed · Seat 7 · Paid $38.66 with a tip of $6.00"; on the card (to the held card, another card, the outside machine, the saved card) the receipt choice (ReceiptStep's new `onDone`) ends it with no Done, a texted receipt once the guest's number is in. Cautious defaults: **a cash close keeps the change** (and Fix the change) in view after the receipt until **Done** (which then also goes to Quick sale), since the change in large type is what the bartender reads out; the slip path keeps its Done too. The unsent warning offers no "close anyway": unwanted drinks come off the round with − first, so nothing rung is ever left behind by a close. Other people's unsent drinks on the tab still show as the tab row's "2 not sent" badge (existing) and aren't sent by Send & close, since unsent drinks belong to whoever rang them. "Stay in view" is by position (the round is at the top of the right panel), not a sticky panel. Strings: `drinks.sendAndClose`, `closeTab.unsent`, `closeTab.closedName` (en, es). Tests: e2e "U-04 · the round first, Send & close charges the unsent drink, and Close to the card is 3 taps back to Quick sale" at the end of `e2e/staff.spec.ts` (the round above On the tab, Fix and Discount folded, the warning, Send & close leaving no draft and capturing $32.66 + $6.00, Print ending it, Quick sale with nothing picked, the next Modelo a quick sale); the existing close tests no longer tap Done after the receipt, and the bar comp test opens the Fix panel by its line. The whole of `e2e/staff.spec.ts` and `e2e/desktop.spec.ts` ran isolated: 180 passed; the K-05 food reminder test failed once on its clock-timed step and passed alone, and the phone close-out test fails without readers registered, as on main before d325fdd fixed it. Spec 10 (the right panel, Ringing, Receipt, the taps table) and screens.md Rail note 22 updated, citing D133; manual test 31.4.

### U-05 · Opening and closing a cardless tab where cardless is the venue's way

- **Status:** todo
- **Size:** S
- **Depends on:** P-03, U-01
- **Spec:** [Bar POS](../spec/10-staff-screens-bar-pos.md) · New tab
- **Build:**
  - New tab: with no reader, or with cards not required, the name field and the seat/label chips come first and the card-hold consent is secondary (NewTab.tsx 224–248 always leads with the $50 hold).
  - Close a cardless tab: buttons in the order the venue uses (outside machine or reader first, then cash); no "Another card" on a tab that never had one, and no reader button with no readers (CloseTab.tsx 288–313).
- **Acceptance:**
  - [ ] At Sing Sing a new tab is: New tab, type a name (or tap a label chip), Open.
- **Notes:**

### U-06 · Fix the card tip field's float math, and ask for the tip once

- **Status:** todo
- **Size:** S
- **Depends on:** M4
- **Spec:** [Money rules](../spec/05-money-rules.md) · cents
- **Build:**
  - TapPayment.tsx:106 parses the tip with `Math.round(Number(tip) * 100)`; use the shared cents parser (no float), and check every other money input in apps/staff for the same.
  - When the reader asks the guest for the tip, the screen doesn't also show a Tip field (QuickSale.tsx:193, TapPayment.tsx:181); the field shows only when the reader won't ask.
- **Acceptance:**
  - [ ] A unit test feeds "1.005", "0.1", "12" through the parser; no `Number(...) * 100` on money is left in apps/staff (a lint rule or a grep test).
- **Notes:**

### U-07 · No sale and Lock on the bar POS

- **Status:** todo
- **Size:** S
- **Depends on:** M7 (drawers), P-10
- **Spec:** [Bar POS](../spec/10-staff-screens-bar-pos.md) · top bar; spec 07 · no sale
- **Build:**
  - A **No sale** button in the bar POS top bar opens this station's drawer with reason chips (Change, Wrong tender, Other… typed); PIN again still applies as the owner set it. Today it's about 6 steps through Rooms → Cash drawers (Tonight.tsx 977–985, DrawerPanel.tsx 359).
  - **Lock** beside Wipe screen in the bar POS top bar (Rail.tsx:769), as the spec says.
- **Acceptance:**
  - [ ] No sale is 2 taps (plus the PIN when asked), audited and counted on Staff actions as before.
- **Notes:**

### U-08 · The manager's PIN where the approval is asked

- **Status:** done
- **Size:** M
- **Depends on:** approvals (Oct 13 setting), P-10
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Approvals
- **Build:**
  - With approvals set to the manager's PIN at the register, the action that needs one opens the same dialog look as Your PIN again, right where it was asked: "Needs a manager's PIN", the manager on the clock pre-selected (else the first), the PIN, Approve. No "Waiting for Andy" naming a phone that isn't used (WaitingStrip.tsx 51–73, PinApproval.tsx 22–44).
  - Decided requests clear themselves after a few seconds; a refused one says why in the staff's language (no raw server text).
  - Phone approvals stay as they are, with the strip.
- **Acceptance:**
  - [x] A void over the limit at Sing Sing: VOID, the dialog opens, Andy's PIN, done; audited as before.
- **Notes:** Built Oct 15, 2026. The staff app's `api()` (apps/staff/src/api.ts) sees any write that answers `approval_pending` with `decided_with: "pin"` (at the top of the answer or one level down, as a fault's pause and comp) and opens **Needs a manager's PIN** (approvals/PinApproval.tsx, `ManagerPinDialog`, mounted once in App.tsx beside Your PIN again, the same sheet look). The dialog reads the approvers from `GET /approvals`, which now marks each `on_clock` (an open shift): the one it was routed to if on the clock, else anyone on it, else the first. The PIN goes to `POST /approvals/{id}/pin` as before, so the server checks it with the lockouts, decides and audits it; nothing about approvals moved to the screen. Approved: the screen gets the answer as with no approval (`status: approved`, nobody to wait for) and says it's done (FixPanel "Voided: …", DiscountPanel "Discount on · … off"; FaultSheet no longer reads a non-pending pause as waiting). Declined or no longer needed: the call is refused with the decision in words. Refusals in the dialog are the staff's words (wrong PIN, locked, can't approve, offline, couldn't record), never server text; one decided meanwhile on the phone says what was decided. **Later** (cautious default: the bartender is never stuck on a dialog) leaves it pending; the waiting strip then reads "Needs a manager's PIN" (no name) and its **Manager's PIN** opens the same dialog; a shared screen gets no per-person events, so the dialog tells the strip to read the list again (`west4:approvals-changed`). Decided requests on the strip clear themselves after 8 s in both modes (Dismiss still works); phone approvals are otherwise unchanged. Left as they were: the persistent per-line and tab-row badges ("Waiting for Andy" from the check and tab views) and the other screens' own waiting words (refund, tip change, drawer, tips to enter, room orders), since Andy's phone can still decide a PIN-mode request; the strip and the dialog are where the PIN is offered. No migration. Tests: `manager-pin.test.ts` (unit), `approvals/modes.int.test.ts` (`on_clock`), e2e "U-08: a void over the limit asks for Andy's PIN right there…"; manual test 31.8. Spec 02 · Approvals, spec 10 principle 6, screens N18 and the glossary updated (D133).

### U-09 · A booked party's room offers Check in; Walk-in from anywhere

- **Status:** todo
- **Size:** M
- **Depends on:** M2
- **Spec:** [Bar POS and staff screens](../spec/10-staff-screens-bar-pos.md) · the board (N10)
- **Build:**
  - A booking due within the hour shows on its room's tile ("Arriving · Jae 11:00") and its panel's main button is **Check in Jae**; Walk-in becomes secondary there (Tonight.tsx 715–731 offers only Walk-in, so a booked party can be seated as a walk-in and lose its deposit).
  - **+ Walk-in** in the board header on every layout (today only on a phone, Tonight.tsx:1270). It picks the smallest free room that fits the party, as the waitlist's Offer does, and the room picker is chips showing each room's size, rooms too small greyed with the reason (CheckInSheet.tsx about 390).
  - Arriving gets a name search and shows the next 90 minutes first.
- **Acceptance:**
  - [ ] Tapping Room 3 at 10:41 PM offers Check in Jae & co.; Walk-in still possible.
  - [ ] + Walk-in for 6 seats the party in the smallest free room that fits.
- **Notes:**

### U-10 · Ending a room in fewer taps

- **Status:** todo
- **Size:** M
- **Depends on:** M4, U-01
- **Spec:** [Payment flows](../spec/07-payment-flows.md) · Present the check
- **Build:**
  - The room's panel has **Add drinks** and **Present & pay** on it, without first tapping Open room (Tonight.tsx:586).
  - The first payment tap presents the check if it isn't yet (today the pay panels hide until Present).
  - Present refused while an order rings lists those orders with **Accept** and **Cancel** on each line (PresentCheck.tsx 83–92 is a dead end).
  - Once paid and the receipt chosen, the screen goes back to the board, and the paid screen has **Mark clean** (the room stays "cleaning" until someone does it).
  - Remove the doubled "tab so far" (Tonight.tsx 559 and 621) and the doubled Rooms in use for managers (the glance and the boxes, 919–940).
- **Acceptance:**
  - [ ] Room 9's close-out on the outside machine: tile, Present & pay, Outside card machine, receipt, Mark clean: 5 taps.
- **Notes:**

### U-11 · Room orders without runners

- **Status:** todo
- **Size:** S
- **Depends on:** M3
- **Spec:** [Room orders and the bar screen](../spec/10-staff-screens-bar-pos.md) · Bar orders, Runs
- **Build:**
  - A venue setting **We run our own orders** (off by default): on, a Ready card on Bar orders has **Delivered** on it, and Runs isn't needed (BarOrders.tsx 406–420, Runs.tsx 199–211). Sold stays at Accept; Delivered still never charges.
- **Acceptance:**
  - [ ] With the setting on, a room order is Accept, Ready, Delivered on one screen.
- **Notes:**

### U-12 · Moving a bar tab into a new room, and undo

- **Status:** todo
- **Size:** S
- **Depends on:** M6, M2
- **Spec:** [Bar POS](../spec/10-staff-screens-bar-pos.md) · Move a tab to a room
- **Build:**
  - On a tab, **Move to a new room** opens the walk-in sheet (party, room); once seated, the tab moves there (today the room must already be in use: MoveTab.tsx:74).
  - After any move, "Moved to Room 9 · Undo" for 10 seconds; Undo moves it back (MoveTab.tsx 78–83 is one tap, no undo). The undo is audited like the move.
- **Acceptance:**
  - [ ] A tab goes to a fresh room in one flow; Undo within 10 s restores it, to the cent.
- **Notes:**

### U-13 · Booking from the calendar like checking in

- **Status:** todo
- **Size:** S
- **Depends on:** P-08
- **Spec:** [Bookings](../spec/10-staff-screens-bar-pos.md) · Calendar
- **Build:**
  - The Calendar's New booking uses the check-in sheet's party and length chips and its phone check (a bad phone says so instead of being dropped: Calendar.tsx 174–180, 468–520), defaults the time to the next half hour, and lists only rooms that fit the party.
- **Acceptance:**
  - [ ] Booking 6 for 2 h tomorrow at 9 PM is: date, 9 PM (or the default), chips, a fitting room, Book.
- **Notes:**

### U-14 · Clock out in one step

- **Status:** todo
- **Size:** M
- **Depends on:** M7 (time clock, tips)
- **Spec:** [Team, time clock & tips](../spec/06-team-shifts-tips.md)
- **Build:**
  - The Clock out screen shows the checklist before the first tap, with the cash tips box on it and a **$0** chip; one tap declares and clocks out. Today the first Clock out is always refused and the bartender must declare, then tap again (timeclock/checklist.ts 84–86, shifts.ts 226–229, TimeClock.tsx 116–140, 391–414).
  - Each checklist line has its action: open that tab, Drop my cash, Count. Open tabs: **Hand all tabs to [name]**; with nobody else on the clock, "Close these tabs".
  - Clock in: a person with one duty has it pre-selected (else the one they used last), and Clock in goes straight to their home screen (TimeClock.tsx 216–233).
  - After "Clocked out", the panel doesn't ask "Pick your duty to clock in" again; an owner or manager not on the clock isn't shown the clock panel after every PIN sign-in (SignIn.tsx 147–152).
- **Acceptance:**
  - [ ] A bartender with no open tabs and no cash tips clocks out in 2 taps ($0, Clock out).
  - [ ] Clock in is name, PIN, Clock in.
- **Notes:**

### U-15 · Close the night without getting stuck

- **Status:** todo
- **Size:** M
- **Depends on:** M7
- **Spec:** [Close the night](../spec/05-money-rules.md) · rule 16; spec 06 · punches
- **Build:**
  - A forgotten clock-out no longer strands the manager: the close lists who's still on, with **Clock out {name} at [time]** and a reason, done with the manager's PIN at the register, audited as a punch edit (today Fix goes to /clock, which can't clock anyone else out, and punch edits need a passkey: checks.ts 80–88, shifts.ts 341–360).
  - The page reads as numbered steps (1 tabs, 2 drawers, 3 clear-out, 4 Close); each check's Fix scrolls to its part or opens its form (the drawers' Fix points at the page itself today).
  - Inline **Clear the waitlist** and **Mark all rooms clean** on those blockers.
  - A venue setting **Print and email the Z report at close** (on by default, to the owner's email): the close prints it at the station and emails it.
  - Wording: "Both drawers counted" becomes "Every drawer counted" (Sing Sing has one).
- **Acceptance:**
  - [ ] With Diego still clocked in at 4 AM, Andy closes the night without leaving the page; the punch shows on Staff actions.
- **Notes:**

### U-16 · Offline, said plainly; cash sales offline as the owner's choice

- **Status:** todo
- **Size:** M
- **Depends on:** M8 (offline), U-02
- **Spec:** [Devices, printing, offline](../spec/09-devices-printing-offline.md)
- **Build:**
  - One **While offline** card on the bar POS and Rooms: what still works, what to write on paper, where the offline code is. The time clock says clocking in waits for the connection (TimeClock.tsx 101–104, 131–135).
  - A venue setting **Take cash quick sales while offline**, **off by default** (the spec's locked drawer, until the founder decides; D133). On: a cash quick sale is queued like queue mode's rounds (alcohol rules checked from the kept menu as online, the 4 AM stop on the simulated clock), the drawer opens with the offline code, and the sale replays on reconnect with its idempotency key; replays that the server refuses show in Confirm replayed orders.
- **Acceptance:**
  - [ ] Off: nothing changes from today. On: a cash beer offline replays once, to the cent, on reconnect; after 4 AM alcohol is greyed as online.
- **Notes:**

### U-17 · Drawer counts, tip-outs and paid-outs

- **Status:** todo
- **Size:** S
- **Depends on:** M7
- **Spec:** spec 05 · drawers; spec 06 · tips
- **Build:**
  - The count's hint says up front that a big difference will ask for a note and a second counter (DrawerPanel.tsx 690–704).
  - The tip-out amount is pre-filled with the person's share (DrawerPanel.tsx:394).
  - A paid-out's receipt photo: check the spec. If the spec allows, add "No receipt" with a required note, or "Add the photo later from a phone"; if it doesn't, leave it and say so in Notes.
- **Acceptance:**
  - [ ] A tip-out is one tap on the pre-filled amount.
- **Notes:**

### U-18 · One place for what needs doing

- **Status:** todo
- **Size:** L
- **Depends on:** P-05, P-11
- **Spec:** [Bar POS and staff screens](../spec/10-staff-screens-bar-pos.md) · rule 14 (Bell), the board's alerts
- **Build:**
  - Every alert opens its room: the board's alert lines, the Bell's room lines (`/tonight?room=<id>` opens the panel) and the time-up strip (tapping a name clears it and opens the room).
  - The Bell is a short list of what has no home on the current screen: approvals, prints that failed, guest texts, and room calls and bar orders only when you're not on the screen that already shows them. Drop the Bell's wipe and new-room-code lines. Bell lines carry the real action where there is one (On it, Accept).
  - The Bell reads a light alerts endpoint, not the whole `/board` (it doubled the board's load at every screen and caused the offline race fixed in 8ac4348).
  - The time-up strip moves inside the shell's bands (not above it, and not on the sign-in or lock screens), has **Clear all**, is titled "Time's up", and reuses the tile words (Staying · 41 min past, Needed now).
- **Acceptance:**
  - [ ] A room's time-up appears on its tile, the strip and (off the board) the Bell; tapping any opens Room 7.
  - [ ] Network: one `/board` read per board load; the Bell's endpoint is covered by the principal and wall suites.
- **Notes:**

### U-19 · The phone's tabs

- **Status:** todo
- **Size:** M
- **Depends on:** P-13
- **Spec:** [Bar POS and staff screens](../spec/10-staff-screens-bar-pos.md) · rule 1, phone
- **Build:**
  - At most 5 bottom tabs per role: home, then the role's most used (Rooms, Calls, Messages for a bartender), and **More**. More is the ☰ list holding only what isn't a tab (today up to 10–14 tabs that scroll sideways, and the ☰ repeats them: navigation.ts 181–229, Shell.tsx 194, 228–248).
  - **My tips** shows only with `tips.share` (navigation.ts:213 shows it to anyone when Team is on).
- **Acceptance:**
  - [ ] A bartender's phone has 5 tabs; nothing appears twice between the tabs and More.
- **Notes:**

### U-20 · One word for each thing

- **Status:** todo
- **Size:** S
- **Depends on:** P-11, P-05
- **Spec:** [Glossary](../glossary.md); spec 10 vocabulary table
- **Build (strings and the glossary, English and Spanish):**
  - "Alerts" means only the board's alerts: the phone tab becomes **Phone alerts** (Avisos del teléfono); Admin's "Alerts & rules" becomes **Sounds & rules**.
  - Staff screens say **check**: "Print the check" (the printed slip still reads BILL).
  - The time-up strip: "Time's up" (not "Room time", which is the money line).
  - The top bar's "Business date Fri Sep 25" reads **Fri night** (Admin and reports keep business date).
  - Owners' words: **feature** for module, **state rules** for rule pack.
  - One cleaning word: the tile, the button and the glossary all say **Needs cleaning** / **Mark clean**.
  - Spanish plurals through `tn` for the Bell and unread counts ("1 nuevo").
  - Errors in one form: "Couldn't … · Try again"; buttons as verbs in the same form.
  - The Bell's "is waiting" uses the glossary's **Asked to wait**; "Sent · on Jess's tab" for bar tabs (no ticket mention); "Send 3" at the bar.
  - Sign-in leads with the name tiles where the venue has no badge readers.
- **Acceptance:**
  - [ ] The copy tests and i18n check pass; the e2e words are updated.
- **Notes:**

### U-21 · Admin an owner can find their way around

- **Status:** todo
- **Size:** M
- **Depends on:** P-10, P-13, P-14
- **Spec:** [Settings](../spec/03-settings-rule-packs-modules.md); screens.md AdminDesk
- **Build:**
  - Until Set up your venue is finished, `/admin` opens it (Admin.tsx 87–98 opens the first section).
  - Admin's sections and Features' switches are grouped under headings: Rooms, Bar, Guests, Team, Money, Venue (today 26 sections and about 28 switches in one list).
  - Where two settings meet (drink tickets in Features → Choices and Bar POS; the Texting switch beside Guest and Marketing texts; approvals beside Ask for the PIN again), a one-line hint in each place says how they relate. Don't remove either place (spec 03 asks for both).
- **Acceptance:**
  - [ ] A new owner lands in Set up your venue; Features reads as five or six short groups.
- **Notes:**

### U-22 · Every sheet and dialog works the same way

- **Status:** todo
- **Size:** M
- **Depends on:** none
- **Spec:** [Bar POS and staff screens](../spec/10-staff-screens-bar-pos.md)
- **Build:**
  - Every hand-built `role="dialog"` sheet uses the shared `Dialog` (focus trap, Esc, a bottom sheet on a phone): TipChangeSheet.tsx, RefundSheet.tsx, CutOff.tsx, Rail.tsx about 1231, and the admin ones.
  - Quick choices where typing is slow: reason chips on Cut off (CutOff.tsx:231); 10% and 20% chips on Discount; Void's "Rang it wrong" sets Not made, and VOID and COMP stop being two equal primary buttons side by side (FixPanel.tsx 121, 333–348).
  - Change tip and refund are reachable for quick sales from Closed tonight, and the find box searches Closed tonight.
- **Acceptance:**
  - [ ] Every sheet closes on Esc and traps focus (a test lists them); the phone shows each as a bottom sheet.
- **Notes:**
