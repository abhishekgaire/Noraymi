# Screens

Sep 29, 2026 · the 27 boards of the design canvas, what each one becomes in the product, and what to change when you build it. The canvas is frozen at v39 and won't change, and it predates the Sep 28 decisions, so it differs from the spec in many places. This page lists every difference, so you can build from the spec without reading the reviews first. Screens the canvas never drew are in [Not on the canvas](#not-on-the-canvas--build-from-the-spec), and the [finding map](#finding-map) at the end shows where every review finding landed.

## Rules for every screen

1. **The spec wins.** Where a board and the [spec](spec/README.md) differ, or a state has no board, build what the spec says ([decisions](decisions.md), D78). To see a board, follow the steps in the [design README](../design/README.md).
2. **Build notes.** Each note reads "The canvas shows X. Build Y." Its bold title names the review finding behind it: F is from the [flows review](archive/review-flows-sep28.md), C from the [completeness review](archive/review-completeness-sep28.md) and K from the [competitive review](archive/review-competitive-sep28.md). "Spec" marks a difference the reviews didn't raise. A note ends with where it was decided ("FB 4.1" is section 4.1 of the [Sep 28 fix brief](archive/fix-brief-sep28.md)) and the spec files that say how it works.
3. **One seed.** Every screen shows the same Friday: Fri Sep 25, 2026, 10:41 PM, New York time, business date Fri Sep 25. The names and numbers are in the [demo seed](demo-seed.md); the boards show older ones.
4. **One set of words.** Staff and guests see the words in the [glossary](glossary.md), the same on every screen. Room orders use one set of words from the bar to the guest's phone.
5. **Settings and modules.** A screen reads every setting from Admin, from the same saved value. A module that's off hides its menu items, phone tabs, website sections and texts ([Settings, rule packs and modules](spec/03-settings-rule-packs-modules.md)).
6. **Two languages.** Staff screens ship in English and Spanish. Every staff string lives in a catalog, never in code.
7. **The venue's clock.** "Now", "tonight", "open now" and the booking minimum come from the venue's time zone and business date, never the device's clock.
8. **Not on the canvas.** A state with no board is built from the spec. Each one is listed under [Not on the canvas](#not-on-the-canvas--build-from-the-spec), with its states and spec links.
9. **Milestones.** "Ships in" names the [milestones](milestones.md) whose "Canvas boards" line includes the screen. Each milestone lists what it adds to the board from the spec.

## The 27 screens

| File | Canvas title | Size | Becomes | Ships in |
| --- | --- | --- | --- | --- |
| **Guest website** | | | | |
| [`Main.dc.html`](#main) | A · Downstairs · phone | 390 × 6400 | Guest web | [M5] |
| [`Rooms.dc.html`](#rooms) | A · Section · The rooms | 390 × 1040 | Guest web | [M5] |
| [`Book.dc.html`](#book) | A · Section · Three taps | 390 × 1300 | Guest web | [M5] |
| [`Menu.dc.html`](#menu) | A · Menu · phone | 390 × 4800 | Guest web | [M5] |
| [`Manage.dc.html`](#manage) | A · Change or cancel a booking | 390 × 1100 | Guest web | [M5] |
| [`Waitlist.dc.html`](#waitlist) | A · Walk-in waitlist · door QR | 390 × 1000 | Guest web | [M2] |
| [`Parties.dc.html`](#parties) | A · Private parties | 390 × 4400 | Guest web | [M5] |
| **Guest phone** | | | | |
| [`Order.dc.html`](#order) | M · Guest · order from the room | 390 × 1180 | Guest web | [M3], [M4] |
| **Staff phones** | | | | |
| [`Pin.dc.html`](#pin) | M · Staff sign-in | 390 × 760 | Staff app, phone and desktop | [M1] |
| [`Staff.dc.html`](#staff) | M · Staff portal · tonight | 390 × 1320 | Staff app, phone layout | [M2], [M3], [M6], [M7], [M8] |
| [`Room.dc.html`](#room) | M · Room tab and clock | 390 × 1180 | Staff app, phone layout | [M2], [M3], [M4] |
| [`Calendar.dc.html`](#calendar) | M · Calendar · bookings ahead | 390 × 1180 | Staff app, phone layout | [M2] |
| [`Messages.dc.html`](#messages) | M · Messages · texts | 390 × 1180 | Staff app, phone layout | [M2] |
| [`Reports.dc.html`](#reports) | M · Reports | 390 × 1180 | Staff app, phone layout | [M7] |
| [`Admin.dc.html`](#admin) | M · Admin · moved to the desktop app | 390 × 760 | Staff app, phone layout | [M1] |
| **Desktop app** | | | | |
| [`Board.dc.html`](#board) | D · Desktop app · Tonight board | 1280 × 800 | Staff app in the Electron shell | [M2], [M3], [M8] |
| [`AdminDesk.dc.html`](#admindesk) | D · Desktop app · Admin | 1280 × 800 | Staff app, desktop layout (Admin) | [M1], [M3], [M4], [M5], [M6], [M7], [M8] |
| [`Night.dc.html`](#night) | D · Desktop app · Close the night | 1280 × 800 | Staff app in the Electron shell | [M7], [M8] |
| [`Bar.dc.html`](#bar) | D · Bar orders screen · room orders by age | 900 × 640 | Staff app in the Electron shell | [M3], [M8] |
| [`Rail.dc.html`](#rail) | D · Desktop app · Bar POS | 1280 × 800 | Staff app in the Electron shell | [M6], [M8] |
| [`DeskRoom.dc.html`](#deskroom) | D · Desktop app · Room tab and clock | 1280 × 800 | Staff app in the Electron shell | [M2], [M3], [M4] |
| [`DeskCalendar.dc.html`](#deskcalendar) | D · Desktop app · Calendar | 1280 × 800 | Staff app in the Electron shell | [M2] |
| [`DeskMessages.dc.html`](#deskmessages) | D · Desktop app · Messages | 1280 × 800 | Staff app in the Electron shell | [M2] |
| [`DeskReports.dc.html`](#deskreports) | D · Desktop app · Reports | 1280 × 800 | Staff app in the Electron shell | [M7] |
| **Product for other venues** | | | | |
| [`Setup.dc.html`](#setup) | P · New venue setup wizard | 1280 × 800 | Staff app and Admin (phase 2) | Phase 2 ([not in phase 1](milestones.md#not-in-phase-1)) |
| [`SiteBuilder.dc.html`](#sitebuilder) | P · Website builder | 1280 × 800 | Admin (phase 2) | Phase 2 ([not in phase 1](milestones.md#not-in-phase-1)) |
| [`Console.dc.html`](#console) | P · Our control panel · venues, plans, modules | 1280 × 800 | The internal Console | [M1], [M8] |

## Guest website (7)

Public pages that anyone with a link can open, server-rendered with Next.js on West 4's own domain. The payment step runs on its own origin (a `pay.` subdomain), not on these pages.

**Light and dark (founder, Oct 9, 2026; V-07).** The canvas draws these boards dark only. The guest web follows the phone's light or dark setting: dark is the canvas; light is the same tokens inverted (cream page, near-black text, the primary action a near-black pill with lime words), with the canvas's accents darkened wherever they are text so every colour passes WCAG 2.2 AA. This applies to every guest page here and under "Guest pages and states" below, including the room page and the payment page.

### Main

[`Main.dc.html`](../design/canvas/Main.dc.html) · "A · Downstairs · phone" · 390 × 6400

- **Becomes:** Guest web (Next.js), server-rendered.
- **Ships in:** [M5].
- **Purpose:** The venue's home page: hero, the numbers, songbook search, the "Sing at the bar" teaser, house rules, hours and address. The Rooms and Book sections sit inside it.
- **Also build here, from the spec:** [N9](#n9-the-singers-queue-page) The singer's queue page.

**Build notes**

1. **Sing at the bar (F6, C10).** The canvas shows a "Sing at the bar" section ("Buy a drink, get a song") that links nowhere. Build it to open the singer's queue page ([N9](#n9-the-singers-queue-page)), the same page the Up next TV's QR code opens. West 4's offer is "Buy a drink, get a song", and a song without a credit has no price. *Decided in [FB 4.11]. Spec: [Song systems and texts][spec-11].*
2. **Hero button when booking is off (F37).** The canvas keeps "Book a room" in the hero and the nav whatever the modules say. Build both from the module state: when Online booking & deposits is off, the hero reads "Call to book" and the Book section is hidden. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03].*
3. **The venue's clock, not the device's (F40).** The canvas builds "Open now" and the closing line from the device clock. Build them from the venue's hours in its own time zone (America/New_York). Staging and the tests pin "now" to Fri Sep 25, 2026, 10:41 PM, so the page reads open until 4 AM. *Decided in [FB 1]. See: [Demo seed][see-seed].*
4. **Price wording (F45, C32).** The canvas says "$10 per person, per hour" with no tax or gratuity. Build "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour", read from Admin's prices. *Decided in [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10].*
5. **Songbook search.** The canvas shows a search box with results "from Playbox's song list". Build the search on `song_catalog`, loaded from a vendor file or a KJ songbook upload. Until a catalog exists, show only the heading and the venue's own song count, with no search box. West 4's catalog comes only from Playbox or West 4, never scraped. *Spec: [Song systems and texts][spec-11].*

### Rooms

[`Rooms.dc.html`](../design/canvas/Rooms.dc.html) · "A · Section · The rooms" · 390 × 1040

- **Becomes:** Guest web (Next.js). A section of the home page, shown by itself on the canvas.
- **Ships in:** [M5].
- **Purpose:** The Rooms section: a head-count picker that shows which room fits and what it costs.

**Build notes**

1. **Price wording (F45, C32).** The canvas shows "$10 per person, per hour", "$80 an hour, plus tax" and "VIP room $250 per hour and up". Build "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour". The VIP room is a flat $250 an hour from 20 guests, and a smaller party in it pays the normal per-person rate. *Decided in [FB 4.17]. Spec: [Money rules][spec-05].*

### Book

[`Book.dc.html`](../design/canvas/Book.dc.html) · "A · Section · Three taps" · 390 × 1300

- **Becomes:** Guest web (Next.js). A section of the home page; the payment step runs on its own origin.
- **Ships in:** [M5].
- **Purpose:** The Book section: pick a night, head count and length, see the price, and pay the deposit.
- **Also build here, from the spec:** [N1](#n1-booking-steps-after-the-price) Booking steps after the price.

**Build notes**

1. **Every step after the price (F5, C13).** The canvas stops at "Pay $X deposit" and "Google Pay · or type a card", and neither does anything. There is no name, mobile or email, no terms, no confirmation. Build these as states of this page: Pick (a real room held for 10 minutes, with a countdown) → Details → Terms → Payment on its own origin → Confirmed, plus the failure states. The full list is in [N1](#n1-booking-steps-after-the-price). *Decided in [FB 5]. Spec: [Payment flows][spec-07], [Security and data retention][spec-12].*
2. **Saved-card wording (C13).** The canvas policy text never says the card is saved or that the rest of the tab and a no-show charge can go on it. Build the terms above Pay from the policy version in Admin → Deposits & cancelling, which Book and Manage both read. It names the later charges, how each is worked out and when. *Spec: [Payment flows][spec-07], [Settings, rule packs and modules][spec-03].*
3. **A party of 3 on Friday and Saturday (F32).** The canvas stops the guests stepper at 4 on Fridays and Saturdays (`guests = max(min, …)`). Build 3 as allowed, with the note "Fri & Sat bill at least 4 · you pay for 4". Keep party size and billable guests separate everywhere, and work the deposit from billable guests. *Decided in [FB 3b]. Spec: [Money rules][spec-05].*
4. **"Tonight" (F40).** The canvas reads the device date and showed Mon Sep 28 with the weeknight minimum of 3. Build "Tonight" and the minimum from the venue's clock. In the demo it is Fri Sep 25, so the minimum is 4. *Decided in [FB 1].*
5. **Booking off (F37).** The canvas has no booking-off state on the page. Build the Book section hidden when Online booking & deposits is off. Guest links for existing bookings (manage, cancel, refund status) keep working. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03].*

### Menu

[`Menu.dc.html`](../design/canvas/Menu.dc.html) · "A · Menu · phone" · 390 × 4800

- **Becomes:** Guest web (Next.js), server-rendered; the menu PDF comes from the same list.
- **Ships in:** [M5].
- **Purpose:** The public menu: drinks and packages, the room price, hours and house rules.

**Build notes**

1. **Happy hour banner (C31).** The canvas always shows "Happy hour · [Days and hours] · [Deals]", hard-coded. Build the banner from dated `price_rules` and hide it when there are none. The site must never advertise a price the POS doesn't charge. *Not decided in the fix brief. Spec: [Settings, rule packs and modules][spec-03].*
2. **Room price line (F45, C32).** The canvas shows "{price} a person, an hour" with no tax or gratuity. Build "$10 a person an hour, plus tax and a 20% gratuity". *Decided in [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10].*
3. **Out tonight.** The canvas has no state for an 86'd item. Build it greyed out and marked "86'd tonight" on the guest menu until someone restores it or the night closes (`menu_items.out_until`). *Spec: [Staff screens and the bar POS][spec-10].*
4. **Menu PDF.** The canvas has a "Menu PDF" button. Build the PDF as a job that renders the same menu list the page and room ordering read, so a price changes once. *Spec: [Scope and architecture][spec-01], [API][spec-08].*

### Manage

[`Manage.dc.html`](../design/canvas/Manage.dc.html) · "A · Change or cancel a booking" · 390 × 1100

- **Becomes:** Guest web (Next.js). Reached from the link in the confirmation text.
- **Ships in:** [M5].
- **Purpose:** One booking for its guest: change the time or party size, say they're running late, or cancel.
- **Also build here, from the spec:** [N1](#n1-booking-steps-after-the-price) Booking steps after the price.

**Build notes**

1. **The demo booking (F33, F40).** The canvas shows Jae & co. as 7 guests at 10:00 PM for $70, with "in 3 days" and "in 5 hours" switches that treat a Sep 25, 10:00 PM booking as upcoming. Build the seed booking: Jae & co. · 5 guests · Fri Sep 25, 11:00 PM, 2 hr, Room 3 (medium tier), $50 deposit paid Wed. Work "in N hours" from the pinned now, 10:41 PM. *Decided in [FB 3b] and [FB 1]. See: [Demo seed][see-seed].*
2. **A party of 3 (F32).** The canvas stops the stepper at 4 ("Fri & Sat: 4 minimum"). Build 3 as allowed and billed as 4, and recompute the deposit from billable guests. *Spec: [Money rules][spec-05], [Payment flows][spec-07].*
3. **Change the date (F52).** The canvas changes the time on the same night only. Build "Change date": it picks a real room for the new slot, keeps the deposit, and never moves the refund cut-off later. A smaller party refunds the excess only before the cut-off; a bigger party or room collects the difference on this screen. When the venue cancels a date, show that and the full refund. *Not decided in the fix brief. Spec: [Payment flows][spec-07].*
4. **Linked from the confirmation (F5).** The canvas is reached directly and nothing links to it. Build the link from the confirmation page and the Booking confirmed text (`west4karaoke.com/b/…`). The link carries a 128-bit token that is stored hashed. *Decided in [FB 5]. Spec: [Payment flows][spec-07], [Tenancy and access][spec-02].*
5. **Policy wording (C13).** The canvas reads a policy that doesn't mention the saved card. Build it from the same Admin → Deposits & cancelling wording as Book. *Spec: [Payment flows][spec-07].*

### Waitlist

[`Waitlist.dc.html`](../design/canvas/Waitlist.dc.html) · "A · Walk-in waitlist · door QR" · 390 × 1000

- **Becomes:** Guest web (Next.js). Opened from the door QR code.
- **Ships in:** [M2].
- **Purpose:** The walk-in waitlist: join, see the place in line, claim the offered room within 10 minutes, or give it away.
- **Also build here, from the spec:** [N9](#n9-the-singers-queue-page) The singer's queue page.

**Build notes**

1. **Place in line (F43, F33).** The canvas hard-codes "2 parties ahead" while 3 are waiting. Build the place from the live list. In the demo the guest joins as the 4th party (a party of 4) and the page says "3 parties ahead". *Decided in [FB 3c]. Spec: [API][spec-08].*
2. **The ready screen names the offered room (F4, F43).** The canvas names Room 4, which is off tonight, for small parties, and Room 8, booked at 11:00, for medium ones. Build it from the offer: the room staff chose, its 10-minute countdown, and "give it away". The demo reads "Room 2 is ready · 10:00 to claim it", because Sam O. no-showed at 10:45. *Decided in [FB 3c] and [FB 4.3]. Spec: [Staff screens and the bar POS][spec-10].*
3. **A party of 3 (F32).** The canvas refuses 3 on a Friday. Build 3 as allowed, with "bills as 4 on Friday" (Chris P. is a party of 3, quoted 40 min). *Decided in [FB 3c]. Spec: [Money rules][spec-05].*
4. **CAPTCHA (F43).** The canvas has no CAPTCHA on the join form. Build one checked on the server, with daily limits per phone number, IP address and device. *Spec: [Security and data retention][spec-12], [API][spec-08].*
5. **Sing at the bar while you wait (F6).** The canvas links to the home page's bar section. Build the link to the singer's queue page ([N9](#n9-the-singers-queue-page)). *Decided in [FB 4.11]. Spec: [Song systems and texts][spec-11].*

### Parties

[`Parties.dc.html`](../design/canvas/Parties.dc.html) · "A · Private parties" · 390 × 4400

- **Becomes:** Guest web (Next.js), server-rendered.
- **Ships in:** [M5].
- **Purpose:** Private parties: what the venue hosts, room sizes, a rough cost estimator, drink packages and an enquiry form.

**Build notes**

1. **Phone or email (C37).** The canvas enquiry form takes "phone or email", but the inbox is texts only and enquiries land in Messages. Build the form to take a mobile number and say "We reply by text". If an email-only enquiry must be allowed, someone has to decide how it gets answered before M5. *Not decided in the fix brief. Spec: [API][spec-08], [Song systems and texts][spec-11].*
2. **Packages.** The canvas lists five drink packages ($70 to $680) that guests order once they're in the room. Build them as menu items ordered from the room. The booking takes only the deposit; selling packages in the booking is phase 2 (K3). *Spec: [Settings, rule packs and modules][spec-03].*

## Guest phone (1)

The room page a guest opens on their own phone after joining a room. The room tablets run the same guest web app in managed kiosk mode. Like the guest website, it follows the phone's light or dark setting (founder, Oct 9, 2026): dark is the Order board, light is its inverted, AA-checked twin.

### Order

[`Order.dc.html`](../design/canvas/Order.dc.html) · "M · Guest · order from the room" · 390 × 1180

- **Becomes:** Guest web (Next.js), the room page on a guest's phone. The room tablet runs the same app in kiosk mode.
- **Ships in:** [M3], [M4].
- **Purpose:** What a guest sees in the room: the clock, the tab so far, ordering, call staff and the private help link.
- **Also build here, from the spec:** [N3](#n3-join-a-room) Join a room, [N4](#n4-room-tablet-kiosk) Room tablet (kiosk), [N5](#n5-your-bill) Your bill, [N6](#n6-pay-my-share) Pay my share, [N7](#n7-same-again) Same again, [N8](#n8-confirm-the-card-on-file) Confirm the card on file, [N14](#n14-report-a-fault) Report a fault, [N19](#n19-calls-list) Calls list, [N20](#n20-help-alert-manager-needed-pin-and-incident-log) Help alert, "Manager needed" pin and incident log.

**Build notes**

1. **The guest's words for an order (F1, F2, F41).** The canvas steps Received → Bar accepted → On its way → Delivered on timers and has no held state. Build the path from the server's `orders.status`, never a timer: "Sent to the bar · you can still cancel" → "The bar needs a few minutes" (asked to wait) → "Being made · on your tab" → "On its way to Room 9" → "Delivered". "Bar accepted" becomes "Being made". A guest can cancel only while the order is ringing or asked to wait, and nothing is charged. *Decided in [FB 4.1] and [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10].*
2. **Side messages (F1, F20).** The canvas has no state for an order the bar returns, declines or cancels. Build "Your server will come by" (returned), "The bar couldn't take this order · nothing charged" with the bar's reason (declined), "The bar stopped serving alcohol at 4 AM · your order was cancelled, nothing charged", and "Your server has paused alcohol for this room" (cut off). *Decided in [FB 4.1]. Spec: [Staff screens and the bar POS][spec-10].*
3. **Cut off and the 4 AM stop (F20, C5).** The canvas menu ignores the alcohol window and has no refused state. Build alcohol hidden after 4:00 AM and when staff cut the room off, with the messages above. The server enforces both (`409 alcohol_closed`). *Decided in [FB 4.7]. Spec: [Money rules][spec-05], [Staff screens and the bar POS][spec-10].*
4. **Your bill (F13, F15).** The canvas has no bill state. "Tonight so far" is before tax and gratuity, and a guest can't pay. Build the state after staff Present the check: "Your bill is ready · ordering is closed", with the bill link ([N5](#n5-your-bill)). New orders answer `409 ordering_closed`. *Decided in [FB 4.5]. Spec: [Payment flows][spec-07], [API][spec-08].*
5. **Pay my share (K2).** The canvas gives a guest no way to pay. Build Pay my share on the bill page ([N6](#n6-pay-my-share)). It is on at West 4. *Decided in [FB 4.12]. Spec: [Payment flows][spec-07].*
6. **Same again (K16).** The canvas makes a guest find items again in a 127-item menu. Build one "Same again" row with the room's last delivered rounds. One tap re-orders, and the order still rings the bar ([N7](#n7-same-again)). *Decided in [FB 4.12]. Spec: [Staff screens and the bar POS][spec-10], [API][spec-08].*
7. **Join and kiosk (F27, C37).** The canvas opens already inside Room 9 with "Code KX4M7" in the header. Build the join flow first ([N3](#n3-join-a-room)), and the room-tablet variant ([N4](#n4-room-tablet-kiosk)). *Decided in [FB 5]. Spec: [Devices, printing and offline][spec-09].*
8. **Moved room (F22).** The canvas has no moved state. Build "You've moved to Room 11 · new code …" on every joined phone. The old code stops working. *Decided in [FB 4.4]. Spec: [Devices, printing and offline][spec-09].*
9. **Faults (F24).** The canvas's "TV or song isn't working" call ends when staff tap On it. Build it as a room call ([N19](#n19-calls-list)) that staff can log as a fault ([N14](#n14-report-a-fault)). *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
10. **Private help (F25).** The canvas says "Sent to the managers", but no manager screen receives it. Build the link to alert only the managers' phones (room, time, I'm on it), never to show on any room screen, and to show the Board only a "Manager needed" pin ([N20](#n20-help-alert-manager-needed-pin-and-incident-log)). Keep "In an emergency, call 911". *Decided in [FB 4.10]. Spec: [Devices, printing and offline][spec-09], [Staff screens and the bar POS][spec-10].*
11. **Call copy (F26).** The canvas says "Room 9 lights up on the bar screen with your reason". Build "Staff get it on their phones". *Decided in [FB 4.10] and [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10].*
12. **Stay wording (F41, C32).** The canvas says "stay as long as you like". Build "Stay on by the minute until we close at 4 AM" when nobody is booked next, and the wrap-up message when a party is. *Decided in [FB 4.17]. Spec: [Song systems and texts][spec-11].*
13. **Room 9 stays as it is.** The canvas figures already match the seed: Marcus T. · party of 12, code KX4M7, host lock off, 161 min at $2.00 a minute is $322.00, drinks $158.00 (a $70 bucket, $40 of soju and $48 of Jäger Bombs, all delivered), and 2 × Margarita · Peach ringing and not yet on the tab. Keep them, and give the room page the seed's numbers, so tab so far reads $480.00 before tax and gratuity with the $120 deposit coming off at settle-up. *Decided in [FB 3a]. See: [Demo seed][see-seed].*
14. **Minimum spend (K4).** The canvas shows no minimum. Where a venue sets one, the room page shows "$84 to your minimum". At West 4 the setting is off and the page shows nothing for it. *Decided in [FB 4.12]. Spec: [Settings, rule packs and modules][spec-03].*

## Staff phones (7)

The staff app at phone width, installed to the home screen. It is one React + Vite codebase with the desktop layout, and each person sees the tabs their role allows.

### Pin

[`Pin.dc.html`](../design/canvas/Pin.dc.html) · "M · Staff sign-in" · 390 × 760

- **Becomes:** Staff app (React + Vite). The sign-in screen on the bar and front-desk computers and on staff phones.
- **Ships in:** [M1].
- **Purpose:** Sign-in for the shared bar computer and for staff phones: a badge tap, or a name then a PIN, plus the time clock.
- **Also build here, from the spec:** [N24](#n24-clock-in-duty-and-clock-out-checklist) Clock-in duty and clock-out checklist, [N25](#n25-set-your-pin) Set your PIN.

**Build notes**

1. **Diego's role and the home links (F28, C2).** The canvas signs Diego in as "Staff" and shows him a "Bar POS" link. Build the five roles (Owner, Manager, Bartender, Front desk, Staff). Diego is Front desk: his home is the Tonight board, and Bar POS shows for him only while he covers the bar, which Admin can switch off. Bartenders open the bar POS and runners the Runs tab. Every link follows the role table. *Decided in [FB 2]. Spec: [Tenancy and access][spec-02].*
2. **Duty and clock-out (F29).** The canvas lets Maya clock out with 3 open tabs and never asks for a duty. Build a duty picker at clock-in (Bar, Front desk, Runner, Manager) and the clock-out checklist ([N24](#n24-clock-in-duty-and-clock-out-checklist)). *Decided in [FB 4.13]. Spec: [Staff screens and the bar POS][spec-10].*
3. **Demo time (F40).** The canvas says 7:00 PM and shows Maya "3h 00m so far". Build 10:41 PM: Maya on since 4:00 PM (6h 41m), Andy since 6:00 PM (4h 41m), Diego since 7:00 PM (3h 41m). *Decided in [FB 1] and [FB 2].*
4. **The right person on the phone (F46).** The canvas opens Maya's phone sign-in as "Andy · Manager". Build the phone to open the portal of the person who signed in, with that role's tabs only. *Spec: [Staff screens and the bar POS][spec-10].*
5. **PIN and Admin (F46, C25).** The canvas says Admin asks for the PIN again, while Admin says a PIN never opens it. Build "Refunds, cash counts and no-sale ask for the PIN again; Admin needs a passkey". *Decided in [FB 4.17]. Spec: [Tenancy and access][spec-02].*
6. **Badge wording (C25).** The canvas says "name and PIN". Build "badge or name and PIN" on every screen, the desktop rail's Lock label included. *Decided in [FB 4.17]. Spec: [Tenancy and access][spec-02].*
7. **Language (C9).** The canvas has no language choice. Build "English · Español" on each person's own sign-in, stored in `memberships.locale`. Staff screens launch in English and Spanish; Korean and Chinese are phase 2. *Decided in [FB 4.15]. Spec: [Tenancy and access][spec-02].*
8. **Choosing a PIN (C7).** The canvas has no first-time step. Build the invite link and a "set your PIN" screen on the person's own phone ([N25](#n25-set-your-pin)). Nobody sets or sees another person's PIN, and no PINs are imported. *Spec: [Tenancy and access][spec-02].*

### Staff

[`Staff.dc.html`](../design/canvas/Staff.dc.html) · "M · Staff portal · tonight" · 390 × 1320

- **Becomes:** Staff app (React + Vite), phone layout, installable to the home screen.
- **Ships in:** [M2], [M3], [M6], [M7], [M8].
- **Purpose:** The staff phone's home: Tonight (timeline and list), Waitlist, Runs and Tips, with a Details sheet for each booking.
- **Also build here, from the spec:** [N10](#n10-check-in-sheet) Check-in sheet, [N11](#n11-waitlist-drawer) Waitlist drawer, [N12](#n12-move-sheet) Move sheet, [N13](#n13-party-size-control) Party size control, [N18](#n18-approvals-inbox) Approvals inbox, [N19](#n19-calls-list) Calls list, [N20](#n20-help-alert-manager-needed-pin-and-incident-log) Help alert, "Manager needed" pin and incident log, [N22](#n22-refund-from-check) Refund from check, [N24](#n24-clock-in-duty-and-clock-out-checklist) Clock-in duty and clock-out checklist, [N26](#n26-tips-to-enter) Tips to enter, [N29](#n29-outage-banners-and-queue-mode) Outage banners and queue mode.

**Build notes**

1. **Runs and the words (F1).** The canvas shows "since made", "You're taking it" and "Delivered · on the room's tab", which implies the charge happens at delivery. Build Runs from the server: Ready for a runner · 4:00 → I've got it → On its way · Andy → Delivered · 10:52 · Andy, or Couldn't serve… with a reason. Accept was the sale; Delivered charges nothing. *Decided in [FB 4.1]. Spec: [Staff screens and the bar POS][spec-10].*
2. **Check in (F3).** The canvas checks a guest in with one tap ("Checked in by Andy"). Build the check-in sheet ([N10](#n10-check-in-sheet)) from the Details sheet and from Sam O.'s row. *Decided in [FB 4.2]. Spec: [Staff screens and the bar POS][spec-10], [API][spec-08].*
3. **Waitlist tab (F4).** The canvas's "Text: room ready" texts a guest with no room and no hold, and "+ Add a walk-in" does nothing. Build the same drawer as the Board ([N11](#n11-waitlist-drawer)): Offer a room, Text, Remove, Seat. "+ Add a walk-in" opens check-in with a free room. *Decided in [FB 4.3]. Spec: [Staff screens and the bar POS][spec-10].*
4. **Close out (F7).** The canvas "Close out" marks Priya R. "Done · Closed out, paid at the bar" with no payment, and Reopen only sets the booking back to Confirmed. Build "Tab & close out →", which opens the room tab ([Room](#room)). Remove the one-tap Done. Reopen reopens the check. *Decided in [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10].*
5. **Refund (F8, C16).** The canvas refund sheet is pre-filled with $360.00 on Marcus T.'s $120 deposit and refunds at once. Build Refund from check ([N22](#n22-refund-from-check)): a paid check, lines, payment, reason, then "Send to Abhishek". Owners and managers only. Marcus's cap is $120. *Decided in [FB 4.6]. Spec: [Payment flows][spec-07], [Tenancy and access][spec-02].*
6. **Approvals inbox (F11, C12).** The canvas phone signed in as Andy has no approvals list. Build "Approvals · N" ([N18](#n18-approvals-inbox)). Andy's own requests go to Abhishek. *Decided in [FB 2] and [FB 4.6]. Spec: [Tenancy and access][spec-02].*
7. **Move (F22).** The canvas offers "Move to Room 5" for a party of 12, into a 3–6 room that is occupied, with no new code. Build the Move sheet ([N12](#n12-move-sheet)). *Decided in [FB 4.4]. Spec: [Staff screens and the bar POS][spec-10].*
8. **Party size (F23).** The canvas shows party size read-only. Build the + and − control ([N13](#n13-party-size-control)). *Decided in [FB 4.4]. Spec: [Staff screens and the bar POS][spec-10].*
9. **Calls (F26).** The canvas has no calls list. Build a Calls list with a push, and On it. *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
10. **Incidents (F25).** The canvas has no incident view. Build the incident log on managers' phones only ([N20](#n20-help-alert-manager-needed-pin-and-incident-log)). *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
11. **Tips to enter (F30, F53).** The canvas lists three paper slips while Close the night says none are waiting. Build the queue with the photo of each slip ([N26](#n26-tips-to-enter)). The three slips are Dev S. (Visa ··3318), Tom W. (Mastercard ··0457) and Ana R. (Amex ··2204). Jess P.'s card, Visa ··4417, must not appear there. *Decided in [FB 3f]. Spec: [Payment flows][spec-07].*
12. **Tonight, from one seed (F33, C28).** The canvas lists bookings, not rooms, so walk-ins don't exist; it shows 2 rooms in use and 11 open, where the Board shows 8 and 3. It has Dana K. late at 8:30, Jae & co. as 8 guests at 9:00 in Room 6, no Omar F. or Tanya W., and a waitlist of Leo, Amara and Chris. Build Tonight from the 11 bookings of the seed plus a room-by-room view that includes Leo M.'s walk-in. Counts: 8 in room, 3 open, 2 cleaning, 1 out of service. Waitlist: Amara B. 7, Nadia K. 6, Chris P. 3. *Decided in [FB 3a], [FB 3b] and [FB 3c]. See: [Demo seed][see-seed].*
13. **Details sheet actions (F48).** The canvas offers "Let them stay" to guests who haven't arrived, "Text guest" ("Your room is ready when you are") to guests already seated, and "Mark no-show" on seated bookings. Build the actions per status. "Let them stay" only when nobody is booked next. Room ready only before check-in. Mark no-show only after the 15-minute grace. Check in only for a booking not yet seated. *Not decided in the fix brief. Spec: [Staff screens and the bar POS][spec-10], [Song systems and texts][spec-11].*
14. **Push alerts.** The canvas has no pushes. Build pushes for calls, runs ready for a runner, wrap-up alerts and orders for a person's rooms. Bar-role phones also buzz for an order ringing 30 seconds. Only managers' phones get approvals, help alerts and orders ringing 4 minutes. On iPhone web push works only after the app is added to the home screen, so setup walks staff through it. *Spec: [Devices, printing and offline][spec-09].*
15. **Tabs follow the modules (F37).** The canvas hard-codes the Waitlist and Runs tabs. Build each tab from the module state. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03].*
16. **"Lock the iPad" (F41).** The canvas has a lock button that says "Lock the iPad". Build "Lock". *Decided in [FB 4.17].*
17. **Vendor banners (F12).** The canvas has none. Build the "Stripe is having trouble" and "Texts are delayed" banners on staff phones. Phones on cellular keep working online but don't see the bar computer's local queue. *Decided in [FB 4.9]. Spec: [Devices, printing and offline][spec-09].*
18. **A return for "too drunk" (F20).** The canvas's "Someone looks too drunk" return has no follow-up. Build the return so the manager on duty sees the reason and is offered "Cut off Room 9?". A runner can't cut off. *Decided in [FB 4.1] and [FB 4.7]. Spec: [Staff screens and the bar POS][spec-10].*
19. **Tabs by role (C2).** The canvas shows one set of tabs. Build them from the role table: a runner gets Runs, with check-in and the waitlist only; every staff phone gets Calls; Approvals and Incidents show on managers' and owners' phones only. *Decided in [FB 2]. Spec: [Tenancy and access][spec-02], [Staff screens and the bar POS][spec-10].*
20. **The phone's Tonight board (V-08, founder-approved).** Below 1024 px, `/tonight` follows the canvas: four count boxes (In room, Open, Arriving, Waitlist) under the counts line of note 12, the views Timeline, List, Waitlist, Runs and Tips (each only when its module is on and the role may use it; Runs and Tips open their own screens), the room-by-room timeline from 4 PM to 4 AM first (a now line, bookings and stays as blocks, out-of-service rooms hatched; a block opens its room), List as the room list with the alerts and arrivals, and "+ Walk-in" pinned above the bottom tabs (check-in with a free room, else the Waitlist view). A room opens as a sheet with the Board's panel. The bottom tabs are pills, as the canvas draws its segmented control. *Decided by the founder, Oct 9, 2026 (V-08).*

### Room

[`Room.dc.html`](../design/canvas/Room.dc.html) · "M · Room tab and clock" · 390 × 1180

- **Becomes:** Staff app (React + Vite), phone layout.
- **Ships in:** [M2], [M3], [M4].
- **Purpose:** The room tab on a phone: the clock, the tab, comps and voids, party size and close-out.
- **Also build here, from the spec:** [N2](#n2-receipts-printed-and-web) Receipts, printed and web, [N6](#n6-pay-my-share) Pay my share, [N12](#n12-move-sheet) Move sheet, [N13](#n13-party-size-control) Party size control, [N16](#n16-no-more-alcohol-cut-off) No more alcohol (cut off), [N21](#n21-close-out-steps-and-card-states) Close-out steps and card states, [N22](#n22-refund-from-check) Refund from check, [N30](#n30-training-band) Training band.

**Build notes**

1. **Comps and voids (F11, F41, C15).** The canvas checks only that each comp is $25 or less, never the shift total (six comps totalling $80 all passed), and labels a void "COMP · void". Build the Rail's fix panel: made or not made, a reason, "$X left this shift". Up to $25 each and $75 a shift per person needs only a reason, and the shift total counts every screen. Over that, the line shows "Waiting for Andy". Nobody approves their own request, so Andy's go to Abhishek. A void reads VOID and a comp COMP. *Decided in [FB 2], [FB 4.6] and [FB 4.17]. Spec: [Tenancy and access][spec-02], [Staff screens and the bar POS][spec-10].*
2. **Close-out (F13, F14, F15, F16, F47, C12, C22).** The canvas closes out in one step: card, card on file and cash all land on "Paid", the drawer "opens" from a phone, and the receipt is always texted. Build the four steps of [N21](#n21-close-out-steps-and-card-states): Present the check, ways to pay with their states, the additional tip line, and the receipt choices (the receipt itself is [N2](#n2-receipts-printed-and-web)). Cash taken on a phone goes into the person's staff bank, and they drop it at the desk. *Decided in [FB 4.5]. Spec: [Payment flows][spec-07], [API][spec-08].*
3. **Adding drinks (F21).** The canvas has quick-add chips ("+ Cocktail $12", "+ Shot $9"). Build the menu search from the bar POS, which creates an accepted staff order and prints a ticket. No generic chips. *Spec: [Staff screens and the bar POS][spec-10].*
4. **No more alcohol (F20, C5).** The canvas has no cut-off. Build "No more alcohol for this room" ([N16](#n16-no-more-alcohol-cut-off)). *Decided in [FB 4.7]. Spec: [Staff screens and the bar POS][spec-10].*
5. **Move and party size (F22, F23).** The canvas has neither. Build the Move sheet ([N12](#n12-move-sheet)) and the party size control ([N13](#n13-party-size-control)). *Decided in [FB 4.4]. Spec: [Staff screens and the bar POS][spec-10].*
6. **Damage fee (F24).** The canvas shows "Damage fee · photo attached" with no photo step. Build it with a photo (camera or upload) and a reason, and a thumbnail on the line. Never say "photo attached" without one. *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
7. **Guest shares (K2).** The canvas has no lines from guests paying their own shares. Build them as lines such as "Paid by a guest · Kevin (share 1 of 12) $41.55" ([N6](#n6-pay-my-share)). *Decided in [FB 4.5]. Spec: [Payment flows][spec-07].*
8. **Training band (F39).** The canvas has none. Build the permanent band "TRAINING · not real money" and T- check numbers ([N30](#n30-training-band)). *Decided in [FB 4.14]. Spec: [Security and data retention][spec-12].*
9. **Room 9 stays as it is.** The canvas figures already match the worked example. Keep them: 161 min × $2.00 = $322.00, drinks $158.00, tax $42.60, gratuity $96.00, total $618.60, deposit −$120.00, $498.60 left. *Decided in [FB 4.5]. Spec: [Money rules][spec-05]. See: [Demo seed][see-seed].*
10. **Stay wording (F41, C32).** The canvas says "stay as long as you like". Build "Stay on by the minute until we close at 4 AM". *Decided in [FB 4.17]. Spec: [Song systems and texts][spec-11].*

### Calendar

[`Calendar.dc.html`](../design/canvas/Calendar.dc.html) · "M · Calendar · bookings ahead" · 390 × 1180

- **Becomes:** Staff app (React + Vite), phone layout.
- **Ships in:** [M2].
- **Purpose:** Bookings ahead by day on a phone, closing a night, and the big-party payment link.

**Build notes**

1. **Tonight's bookings (F33, C28).** The canvas lists a different Friday (Priya R. 7:00 to 9:00, Jae & co. as 8 guests in Room 6, Sam O. at 10:00). Build the 11 bookings of the seed exactly. *Decided in [FB 3b]. See: [Demo seed][see-seed].*
2. **The big-party link (F34, C37).** The canvas lets a host book 24 guests into the VIP room at 9:00 PM for 3 hr, while Bianca L.'s party of 22 holds it from 9:30 PM to 12:30 AM, and 9:00 PM is already past. Build the dialog to show the room and how long it is free, to refuse overlapping or past slots, and to place a pending hold that lapses at `pending_until` if the link goes unpaid. The spec doesn't fix the hold's length. *Not decided in the fix brief. Spec: [Payment flows][spec-07], [Data model][spec-04].*
3. **Hold wording (C37).** The canvas says a room is held "from the second a card hold clears". Build the wording to match: an online slot holds a real room for 10 minutes, and a payment link holds it until `pending_until`. *Spec: [Payment flows][spec-07].*
4. **Blocking a date (F52).** The canvas says affected bookings "stay until you move or cancel them" and offers no way to cancel them. Build a list of the affected bookings with "Cancel and refund all". A cancellation by the venue always refunds in full, and the guests are texted. *Not decided in the fix brief. Spec: [Payment flows][spec-07].*

### Messages

[`Messages.dc.html`](../design/canvas/Messages.dc.html) · "M · Messages · texts" · 390 × 1180

- **Becomes:** Staff app (React + Vite), phone layout.
- **Ships in:** [M2].
- **Purpose:** The phone inbox for guest texts, and the list of automatic texts.

**Build notes**

1. **The 14 automatic texts (C34).** The canvas lists 7 automatic texts, while Admin lists 13. Build the same 14 everywhere, in this order: Booking confirmed, Reminder, Room code, Room ready, Offer expiring, Please wrap up, Booked time ending, Receipt, Deposit refund, Payment link, Running late reply, You're up next, Review ask, Birthday. The last two are marketing and stay off until they have their own opt-in. *Decided in [FB 3i]. Spec: [Song systems and texts][spec-11].*
2. **Booking confirmed text (C22).** The canvas text reads "Deposit $60 paid, comes off your tab" and has no gratuity line. Build the same text as Admin → Texts, with "A 20% gratuity is added to room tabs." and "comes off your bill". *Decided in [FB 3i]. Spec: [Song systems and texts][spec-11].*
3. **Free-text links (F55).** The canvas thread shows staff typing "We do. Booking link: west4karaoke.com/book". Free text is allowed only as a reply in an open service conversation, and links and promotions are blocked there. Build the block, and send a payment link through the Payment link text. *Spec: [Song systems and texts][spec-11].*
4. **Threads (F33, C28).** The canvas puts Dana in the "running late" thread that belongs to Sam O. Build the seed: Sam O. texted "running 15 late" at 10:24 PM for the 10:30 in Room 2, held until 10:45. *Decided in [FB 3a] and [FB 3d]. See: [Demo seed][see-seed].*
5. **Stay wording (F41, C32).** The canvas's Booked time ending text says "stay as long as you like". Build "…Nobody's booked after you, so you can stay on by the minute until we close at 4 AM." *Decided in [FB 3i] and [FB 4.17]. Spec: [Song systems and texts][spec-11].*

### Reports

[`Reports.dc.html`](../design/canvas/Reports.dc.html) · "M · Reports" · 390 × 1180

- **Becomes:** Staff app (React + Vite), phone layout. Owners and managers only.
- **Ships in:** [M7].
- **Purpose:** The week and the trends on a phone.
- **Also build here, from the spec:** [N38](#n38-reports-and-exports) Reports and exports.

**Build notes**

1. **Reviews count (F55).** The canvas counts "Reviews from the morning text · 19" while that text is switched off. Build the line to show nothing, or "Off", while the Review ask text is off. *Decided in [FB 3i]. Spec: [Song systems and texts][spec-11].*
2. **Reports with no screen (F53, C37).** The canvas has no tax-quarter, payroll or accounting screens. Build them as reports and exports ([N38](#n38-reports-and-exports)). *Spec: [API][spec-08].*
3. **Tonight's report (F40).** The canvas says tonight's report is "closed out at 4 AM" and links to Close the night, which showed about 1:20 AM. Build the line to agree with Night: tonight's report is a running X report until the night closes, then the Z report. Night's own scene is labeled "Later tonight · Sat 4:12 AM". *Decided in [FB 1] and [FB 4.18]. Spec: [API][spec-08].*

### Admin

[`Admin.dc.html`](../design/canvas/Admin.dc.html) · "M · Admin · moved to the desktop app" · 390 × 760

- **Becomes:** Staff app (React + Vite). A stub; Admin itself is the desktop layout in AdminDesk.
- **Ships in:** [M1].
- **Purpose:** A stub that says Admin lives in the desktop app.

**Build notes**

1. **Where Admin lives (C37, F46).** The canvas says Admin is set "on the office computer". West 4 has no office computer, and the spec lets Admin open in any browser in a passkey session. Build the stub to say "Admin needs your passkey. Open it in the desktop app or in a browser." A PIN never opens Admin. *Not decided in the fix brief. Spec: [Tenancy and access][spec-02], [Scope and architecture][spec-01].*

## Desktop app (9)

The staff app at desktop width. The bar and front-desk computers run it inside the Electron desktop shell, which adds the alarm sound, USB printers, the cash drawer, the badge reader and the offline view. Admin also opens in a browser, in a passkey session.

### Board

[`Board.dc.html`](../design/canvas/Board.dc.html) · "D · Desktop app · Tonight board" · 1280 × 800

- **Becomes:** Staff app (React + Vite), desktop layout, inside the Electron desktop shell. The front-desk computer's home.
- **Ships in:** [M2], [M3], [M8].
- **Purpose:** The live board of 14 rooms: tiles, alerts, waitlist, drawer hand-over and headcount.
- **Also build here, from the spec:** [N10](#n10-check-in-sheet) Check-in sheet, [N11](#n11-waitlist-drawer) Waitlist drawer, [N12](#n12-move-sheet) Move sheet, [N13](#n13-party-size-control) Party size control, [N14](#n14-report-a-fault) Report a fault, [N15](#n15-lost-and-found) Lost and found, [N16](#n16-no-more-alcohol-cut-off) No more alcohol (cut off), [N17](#n17-clear-out-check) Clear-out check, [N19](#n19-calls-list) Calls list, [N20](#n20-help-alert-manager-needed-pin-and-incident-log) Help alert, "Manager needed" pin and incident log, [N29](#n29-outage-banners-and-queue-mode) Outage banners and queue mode, [N30](#n30-training-band) Training band, [N31](#n31-occupancy-warning-and-door-counter) Occupancy warning and door counter, [N32](#n32-no-bar-device-connected) No bar device connected.

**Build notes**

1. **Check in (F3).** The canvas has no check-in on the Board. An open room's only control is "Seat a walk-in here", which does nothing, and the in-use panel has no check-in or no-show. Build the check-in sheet ([N10](#n10-check-in-sheet)). Arriving and Late bookings show on their room's tile or panel with [Check in] and [Mark no-show], allowed after the 15-minute grace. [+ Walk-in] opens the same sheet with a free room. *Decided in [FB 4.2]. Spec: [Staff screens and the bar POS][spec-10], [API][spec-08].*
2. **Waitlist drawer (F4).** The canvas's "Waitlist · 3" and "+ Walk-in" do nothing, and the alert about Room 11 only selects the room. Build the drawer ([N11](#n11-waitlist-drawer)), and wire that alert to [Offer Room 11 · 10 min to claim]. *Decided in [FB 4.3]. Spec: [Staff screens and the bar POS][spec-10].*
3. **Alerts and tiles from one seed (F33, C28).** The canvas is from an older night: Room 7's alert says no other 6–12 room is free while Room 11 is free all night, the waitlist alert names "Priya K.", and the tiles show Room 1 at $86, Room 10 at $96, Room 12 at $330 and the VIP room at $745. Build the seven alerts of the seed in this order: pink Room 7 (11 min past, the Parks booked at 11:00) [Text Rob & Kim: please wrap up] [Move a room…]; pink Room 9 called for another mic [On it]; amber Room 5's order ringing 2:11 [Show]; amber Room 3, 4 min left, Jae & co. at 11:00 [Text Priya: please wrap up]; lime Room 11 free all night, Amara B. (7) has waited 26 min [Offer Room 11 · 10 min to claim]; grey Rooms 6 and 13 need a wipe [Show]; grey Sam O. running 15 late for the 10:30 in Room 2 [Reply "no problem"] [Check in] [Mark no-show]. The waitlist party is Nadia K. (6), not Priya K. *Decided in [FB 3a] and [FB 3d]. See: [Demo seed][see-seed].*
4. **Tab amounts (F45, F33).** The canvas tab amounts disagree with the Rail. Build the seed's tab so far (room time plus drinks accepted so far, before tax and gratuity): Room 1 $123.33, Room 3 $175.67, Room 5 $40.00, Room 7 $210.83, Room 9 $480.00, Room 10 $441.50, Room 12 $305.67, VIP $775.83. *Decided in [FB 3a]. See: [Demo seed][see-seed].*
5. **Order aging on the Board (F36).** The canvas has no alert for the 2:11 Room 5 order, and its "Bar orders" badge says 1 while 2 are waiting. Build the badge as "Bar orders · 2", counting every ringing and asked-to-wait order. The Board alerts at 2 min, then says "on Andy's phone" at 4 min and "texted Andy" at 6. *Decided in [FB 3d] and [FB 4.1]. Spec: [Devices, printing and offline][spec-09].*
6. **Move a room (F22).** The canvas's in-use panel has no Move. Build the Move sheet ([N12](#n12-move-sheet)) from the panel and from [Move a room…]. For Room 7 it lists Room 11, free all night. *Decided in [FB 4.4] and [FB 3d]. Spec: [Staff screens and the bar POS][spec-10].*
7. **Party size (F23).** The canvas panel shows party size read-only. Build the + and − control ([N13](#n13-party-size-control)). *Decided in [FB 4.4]. Spec: [Staff screens and the bar POS][spec-10].*
8. **Faults (F24).** The canvas clears a call with "On it" and nothing more. Build Report a fault ([N14](#n14-report-a-fault)). Room 4 shows "Out of service · Mic dead since Tue. Replacement ordered." (fault logged Tue Sep 22). *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
9. **Lost and found (F50).** The canvas has only room notes ("TV remote goes missing"). Build the lost-item log ([N15](#n15-lost-and-found)). Room 6 keeps its note: "TV remote goes missing. Check under the couch." *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
10. **Manager needed (F25).** The canvas has no pin. Build a "Manager needed" pin that shows a count only, with no room and no reason ([N20](#n20-help-alert-manager-needed-pin-and-incident-log)). *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
11. **Calls (F26).** The canvas shows a call as an alert. Build it with the Calls list ([N19](#n19-calls-list)). *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
12. **No more alcohol (C5, F20).** The canvas tile panel has no cut-off. Build "No more alcohol for this room" ([N16](#n16-no-more-alcohol-cut-off)). *Decided in [FB 4.7]. Spec: [Staff screens and the bar POS][spec-10].*
13. **Clear-out check (C4).** The canvas has none. Build the 4:30 AM prompt ([N17](#n17-clear-out-check)). *Decided in [FB 4.7]. Spec: [API][spec-08].*
14. **Footer and outage banners (F12, C11).** The canvas footer reads "Online · synced 4 s ago · works offline". Build "Online · synced 4 s ago" and the outage banners ([N29](#n29-outage-banners-and-queue-mode)), each shown by a "Demo:" control. *Decided in [FB 4.9]. Spec: [Devices, printing and offline][spec-09].*
15. **Cleaning (F49).** The canvas tiles say "Left 9:12 PM" and "Left 9:20 PM" while the alert says "8 min". "Clean · open it up" sets Room 6's next booking to "nothing tonight" while the phone has Jae & co. booked there. Room 3 has no cleaning gap before Jae's 10:45 start. Build the seed: Room 6 left 10:33 PM (8 min) and Room 13 left 10:36 PM (5 min), nothing booked in Room 6 tonight, and Jae & co. start in Room 3 at 11:00 PM, 15 minutes after Priya R. ends at 10:45. *Decided in [FB 3a]. See: [Demo seed][see-seed].*
16. **Headcount (F51).** The canvas shows "Inside now 100 people" with no limit set. Build "98 inside" (77 in rooms, 5 on bar tabs, 16 waiting) and "Limit not set · Admin → Safety". Never invent a limit. The 90% warning and the door counter are in [N31](#n31-occupancy-warning-and-door-counter). *Decided in [FB 3a] and [FB 4.10]. Spec: [Devices, printing and offline][spec-09].*
17. **No bar device (F53).** The canvas has no alert for this. Build the Board alert for "no bar device connected" during opening hours, beside the buzz on every bar-role phone ([N32](#n32-no-bar-device-connected)). *Not decided in the fix brief. Spec: [Devices, printing and offline][spec-09].*
18. **Two drawers (C19, F17).** The canvas shows one "House drawer" ("everyone rings cash here") and a "Drawers · one each" demo with a bar drawer for Maya. Build two drawers, each a house drawer the manager on duty answers for: the bar drawer on the bar printer's kick port and the front-desk drawer on the front-desk printer. Cash goes into the drawer at the screen where it's taken. Keep the demo link for the drawer-per-person model, which Admin → Cash drawers switches on. *Decided in [FB 3g]. Spec: [Devices, printing and offline][spec-09].*
19. **Side menu (F37).** The canvas menu is hard-coded. Build it from the modules and the signed-in role: Tonight, Bar POS, Bar orders, Song queue (bar mode only), Calendar, Messages, Reports, Close the night, Admin and Lock. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03], [Staff screens and the bar POS][spec-10].*
20. **Training band (F39).** The canvas has none. Build the permanent band "TRAINING · not real money" and a "Demo: training mode" toggle ([N30](#n30-training-band)). *Decided in [FB 4.14]. Spec: [Security and data retention][spec-12].*
21. **Minimum spend (K4).** The canvas tile shows nothing. Where a venue sets a minimum, the tile shows "$84 to your minimum". At West 4 it is off, so the tile shows nothing. *Decided in [FB 4.12].*
22. **Room panel and "Show all" (V-08, founder-approved).** Build the canvas's small tiles (5 columns at 1280) and its right-hand room panel: one tap on a tile opens that room's clock, tab, calls, controls (everything notes 1 to 21 put on a tile), tab so far and room notes. With no room open, the panel says "Tap a room to see its clock, tab and controls here." The alerts show the 3 most urgent, then "Show all N" and "Show only the 3 most urgent". The minimum-spend line (note 21) moves to the panel. *Decided by the founder, Oct 9, 2026 (V-08).*

### AdminDesk

[`AdminDesk.dc.html`](../design/canvas/AdminDesk.dc.html) · "D · Desktop app · Admin" · 1280 × 800

- **Becomes:** Staff app (React + Vite), desktop layout. Admin opens only in a passkey session, in the desktop app or a browser.
- **Ships in:** [M1], [M3], [M4], [M5], [M6], [M7], [M8].
- **Purpose:** Every setting the venue controls, in 14 sections. Nothing reaches the website or the room screens until Save.
- **Also build here, from the spec:** [N25](#n25-set-your-pin) Set your PIN, [N33](#n33-admin--bar-pos) Admin → Bar POS, [N34](#n34-admin--bar-mode) Admin → Bar mode, [N35](#n35-admin--licenses) Admin → Licenses, [N36](#n36-admin--safety) Admin → Safety, [N37](#n37-admin--payments-disputes-and-unmatched-payments) Admin → Payments, disputes and Unmatched payments, [N39](#n39-admin--console) Admin → Console.

**Build notes**

1. **Admin → Bar POS (C17).** The canvas has no section for the `pos` and `tabs` keys. Build Admin → Bar POS ([N33](#n33-admin--bar-pos)): a 25-slot layout editor per station, the reason-only limits, the locks, the tip path, order aging and the tab settings. *Decided in [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10], [Settings, rule packs and modules][spec-03].*
2. **The alarm toggle (C17, C24, F36).** The canvas Alerts & rules offers "Ring the bar until someone accepts · Room orders sound the alarm on the bar screen", a setting the spec doesn't have. Remove it. The aging times, the chime and Mute replace it. *Decided in [FB 4.17] and [FB 4.1]. Spec: [Staff screens and the bar POS][spec-10].*
3. **Menu editor (C17).** The canvas menu editor has no short button name and no alcohol flag. Build both columns (`menu_items.button_name` and the alcohol flag). *Spec: [Staff screens and the bar POS][spec-10], [Data model][spec-04].*
4. **Badges and readers (C18, F38).** The canvas Team has no badge column, and Printers & devices leaves out the USB NFC readers and the badges. Build a Badges column with "Pair (tap the reader)" and "Switch off" for each person. List the bar and front-desk NFC readers as devices. West 4's badges are NTAG 424 DNA for Abhishek, Andy, Maya and Diego. *Decided in [FB 3g]. Spec: [Tenancy and access][spec-02], [Devices, printing and offline][spec-09].*
5. **Roles (C2, F28).** The canvas gives Diego the Staff role ("check-ins, walk-ins, texts"). Build the five roles with the permission table. Diego is Front desk. Whether the front desk may use the bar POS when covering the bar is a permission here. *Decided in [FB 2]. Spec: [Tenancy and access][spec-02].*
6. **Language column (C9).** The canvas Team has no language. Build a Language column (English or Español) for each person. *Decided in [FB 4.15]. Spec: [Tenancy and access][spec-02].*
7. **Training mode (F39).** The canvas has none. Build Admin → Team → Training mode, per person or per device for a new hire. *Decided in [FB 4.14]. Spec: [Settings, rule packs and modules][spec-03].*
8. **Invites (C7).** The canvas has no invite or PIN reset. Build both in Team: a link to the person's own phone, where they choose their PIN. Import people and roles only, never PINs. *Spec: [Tenancy and access][spec-02].*
9. **Devices and drawers (F17, C19).** The canvas lists one drawer at the front desk, the bar reader as "S710, on order", and the router as "Backup internet · TO SET UP". Build West 4's devices: the bar and front-desk computers, two NFC readers, two receipt printers with a drawer each, the Bar S710 (installed, online) and the Front desk S710, 14 room tablets (13 online; Room 4's is off), the Up next TV, and the router ("Backup internet · on"). Cash drawers shows both drawers, with the switch to a drawer per person. *Decided in [FB 3g]. Spec: [Devices, printing and offline][spec-09].*
10. **Mic power outlet (K1).** The canvas has none. The one-room trial of a switched outlet on a room's wireless-mic receiver is a device like any other: paired, with heartbeats, off only on a fresh command from the server. Only with West 4's approval. *Spec: [Song systems and texts][spec-11].*
11. **Features (F37).** The canvas lets "Bar screen & tickets" be switched off mid-service with no warning. Build the dependency "Ordering from the room needs Bar screen & tickets" and the confirm "Room orders would have nowhere to ring. Turn off Ordering from the room too?". Add the table of what each module hides: menu items, phone tabs, website sections and texts. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03].*
12. **Escalation wording (C24).** The canvas module text reads "Orders ring the bar until accepted". Build the one sentence: "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup." *Decided in [FB 4.1]. Spec: [Devices, printing and offline][spec-09].*
13. **Texts (C34).** The canvas lists 13 texts, without "You're up next", and offers "Text the guest when it is on its way". Build the 14 texts. "The bar needs a few minutes" and "On its way" are room-screen messages, not texts. *Decided in [FB 3i]. Spec: [Song systems and texts][spec-11].*
14. **Stay wording (F41, C32).** The canvas Booked time ending text says "stay as long as you like". Build "…Nobody's booked after you, so you can stay on by the minute until we close at 4 AM." *Decided in [FB 3i] and [FB 4.17]. Spec: [Song systems and texts][spec-11].*
15. **Happy hour line (C31).** The canvas offers a free-text "Happy hour line (leave empty to hide it everywhere)". Replace it with a price-rule editor (dated `price_rules`), or remove it. *Not decided in the fix brief. Spec: [Settings, rule packs and modules][spec-03].*
16. **Deposit and limits (C37).** The canvas Deposits has no `cardHold` mode, and Hours & prices has no booking limits. Build both. *Spec: [Settings, rule packs and modules][spec-03], [Payment flows][spec-07].*
17. **What guests read (C13).** The canvas policy wording, read by Book, Manage and Admin, never mentions the saved card. Extend it to name the remaining-tab and no-show charges that can go on it. *Spec: [Payment flows][spec-07].*
18. **Card fee preview (C37).** The canvas surcharge preview adds no tax on the surcharge, though the rule pack says it's taxable. Build the preview with a tax line driven by `salesTax.surchargeTaxable`, which the accountant confirms. The card fee is off at West 4. *Spec: [Settings, rule packs and modules][spec-03], [Open technical questions][spec-14].*
19. **Occupancy limit (F51).** The canvas Rooms leaves the limit empty, so the Board asks for it. Build Admin → Safety ([N36](#n36-admin--safety)) with the limit. West 4 hasn't set one. *Decided in [FB 3a] and [FB 4.10]. Spec: [Settings, rule packs and modules][spec-03].*
20. **Licenses (C6).** The canvas has no license register. Build Admin → Licenses ([N35](#n35-admin--licenses)). *Spec: [Data model][spec-04], [API][spec-08].*
21. **Connections (C36).** The canvas Connections lists "Yelp reservations", "Homebase · Shifts" and a QuickBooks "Connect". None is specified. Leave out Yelp and Homebase until a partner program is chosen, and label the accounting item "Export for QuickBooks" (the spec has a journal export, no push). *Not decided in the fix brief. Spec: [API][spec-08].*
22. **Live counts (F33, C28).** The canvas Features shows "4 open tabs · 9 rooms in use". Build live counts: 5 open bar tabs and 8 rooms in use at 10:41 PM. *Decided in [FB 3a]. See: [Demo seed][see-seed].*
23. **Minimum spend (K4).** The canvas has no setting. Build a minimum spend per room size and day in Hours & prices. West 4 has it off, and Admin shows the off setting. *Decided in [FB 4.12]. Spec: [Settings, rule packs and modules][spec-03].*
24. **Time bands and the billing step (K13).** The canvas Hours & prices has no time bands and no billing step (only Setup step 3 offers one rate change). Build bands in the venue's own rate mode, each with a billing step of 1, 15, 30 or 60 minutes and a rounding rule (up, nearest or down). West 4 bills by the minute, so its step is 1. *Not decided in the fix brief. Spec: [Settings, rule packs and modules][spec-03], [Money rules][spec-05].*
25. **Booking confirmed text (C22).** The canvas text reads "Deposit $60 paid, comes off your tab" and has no gratuity line. Build "Booked. Room for 6 at 9:30 PM, Sat Sep 26. A 20% gratuity is added to room tabs. Deposit $60 paid, comes off your bill. Free to cancel until Fri 9:30 PM: west4karaoke.com/b/…". *Decided in [FB 3i]. Spec: [Song systems and texts][spec-11], [Money rules][spec-05].*
26. **Pay my share (K2).** The canvas has no setting. Build `pay.payShare` in Card fee & gratuity, on at West 4. *Decided in [FB 4.12]. Spec: [Settings, rule packs and modules][spec-03], [Payment flows][spec-07].*
27. **Bar mode (K6, C10).** The canvas has no section for bar mode, though Features shows it on. Build Admin → Bar mode ([N34](#n34-admin--bar-mode)). *Decided in [FB 4.11]. Spec: [Song systems and texts][spec-11].*
28. **Payments and disputes (F53).** The canvas has none of Admin → Payments, the disputes inbox or Unmatched payments. Build them ([N37](#n37-admin--payments-disputes-and-unmatched-payments)). *Spec: [Stripe setup][spec-06], [API][spec-08].*
29. **Admin → Console (C8).** The canvas has no place where the owner approves support access. Build Admin → Console for owners ([N39](#n39-admin--console)). *Spec: [Tenancy and access][spec-02], [API][spec-08].*

### Night

[`Night.dc.html`](../design/canvas/Night.dc.html) · "D · Desktop app · Close the night" · 1280 × 800

- **Becomes:** Staff app (React + Vite), desktop layout, inside the Electron desktop shell. Owners and managers.
- **Ships in:** [M7], [M8].
- **Purpose:** Close the night: what is still open, the numbers, tips, both drawers and the log.
- **Also build here, from the spec:** [N17](#n17-clear-out-check) Clear-out check, [N29](#n29-outage-banners-and-queue-mode) Outage banners and queue mode, [N37](#n37-admin--payments-disputes-and-unmatched-payments) Admin → Payments, disputes and Unmatched payments.

**Build notes**

1. **Checks before closing (F30).** The canvas checks only rooms, tabs and the drawer, and says "Bar tips were picked on the reader, so none are waiting to be typed in" while the phone has 3 slips. Build a list of everything still open, each with a link to fix it: staff still on the clock; open waitlist entries; ringing or asked-to-wait orders; pending approvals; rooms still cleaning; unsent drinks; the clear-out check; paper slips not entered ("3 slips not entered · tips post to Sat Sep 26"); both drawers counted. Awaiting-tip tabs don't block the close, and a late tip posts to the next business date. *Decided in [FB 4.18]. Spec: [Staff screens and the bar POS][spec-10], [API][spec-08], [Payment flows][spec-07].*
2. **Z report gratuity (F31, C29).** The canvas gratuity is $2,122.65, which is 20% of every sale except damage fees and kept deposits, bar tabs included. Build Drinks split into Room checks and Bar tabs, and take the gratuity from room checks only: 20% of room time + room drinks + packages sold to rooms − room comps and refunds, before tax, never on damage fees. Practice checks from training mode stay out of every total. The canvas Z figures are from an older night and the brief gives no Z totals, so compute them from the checks. *Decided in [FB 4.18]. Spec: [Money rules][spec-05]. See: [Money cases][see-cases].*
3. **Small errors (F42).** The canvas counts "26 rooms closed, 8 still open" with bar tabs counted as rooms. It lists a 10:39 PM line after 9:14 PM. It says "Turned Room 4 off at 11:30 PM · TV out" where the Board says Room 4 has been out of service since Tue. It offers "Print Z report" before the night is closed. Build rooms and bar tabs counted apart, the log in time order and agreeing with the Board, and "Print X report (running)" until the night closes, then "Print Z report". *Decided in [FB 4.18]. Spec: [API][spec-08].*
4. **Later tonight (F40).** The canvas Night runs to about 1:20 AM. Build the scene labeled "Later tonight · Sat 4:12 AM" (business date Fri Sep 25) that ends "Night closed · 4:48 AM". The Rail's 4:02 AM demo comes before it, so they don't contradict. *Decided in [FB 1]. See: [Demo seed][see-seed].*
5. **Charge the remaining tabs (F41).** The canvas calls charging every open tab "Last call". Build "Charge the remaining tabs". "Last call" means only the house last-call time in Admin. One confirmation shows how many cards and the total, and a tab waiting on an approval is skipped. *Decided in [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10].*
6. **Clear-out check (C4).** The canvas has none. Build the 4:30 AM check ([N17](#n17-clear-out-check)): "Walk every room and the bar · no drinks left out", then [Done] records "Clear-out check · Andy · 4:31 AM". *Decided in [FB 4.7]. Spec: [API][spec-08].*
7. **Both drawers (C19, F17).** The canvas has one house drawer plus a per-person demo with a "Bar · Maya S." drawer. Build both physical drawers, counted blind, each with its own difference and note. Keep the demo link for a drawer per person. *Decided in [FB 3g]. Spec: [Devices, printing and offline][spec-09], [Money rules][spec-05].*
8. **After an outage (F12, C11).** The canvas has nothing. Build "Review after outage" for a manager and the one-page break-glass card to print at each desk ([N29](#n29-outage-banners-and-queue-mode)). *Decided in [FB 4.9]. Spec: [Devices, printing and offline][spec-09].*
9. **Diego's per-person demo (F28, C2).** The canvas drawer-per-person demo gives Diego "Cash sales · 2 tabs" and a reason-only comp, work a Staff role can't do. Build it with Diego as Front desk, who can. *Decided in [FB 2]. Spec: [Tenancy and access][spec-02].*
10. **Names and times (F33, C28).** The canvas log names "Priya K." (moved from Room 11 to Room 13, and a waitlist text). Build the seed's names: Nadia K. is the waitlist party of 6, and Room 12 has been open since 9:00 PM. *Decided in [FB 3a] and [FB 3c]. See: [Demo seed][see-seed].*
11. **Training checks (F39).** The canvas has none. Practice checks (T- numbers) stay out of the Z report, the gratuity, the tip pool and the reason-only shift totals. *Decided in [FB 4.14]. Spec: [Security and data retention][spec-12].*
12. **Capture-failed tabs (F53).** The canvas has no list. Build the manager's list of tabs whose capture failed; it stays there until settled and doesn't hold up the close. *Spec: [Payment flows][spec-07], [API][spec-08].*

### Bar

[`Bar.dc.html`](../design/canvas/Bar.dc.html) · "D · Bar orders screen · room orders by age" · 900 × 640

- **Becomes:** Staff app (React + Vite), desktop layout, inside the Electron desktop shell. Its own window at the bar.
- **Ships in:** [M3], [M8].
- **Purpose:** The bar orders screen: room orders oldest first, with Accept, tickets, runs and the out-tonight list.
- **Also build here, from the spec:** [N27](#n27-kj-song-queue-screen) KJ song-queue screen, [N29](#n29-outage-banners-and-queue-mode) Outage banners and queue mode, [N32](#n32-no-bar-device-connected) No bar device connected.

**Build notes**

1. **Columns and words (F1, F41).** The canvas "Sent to room" button jumps an order straight to "Delivered tonight". Build the five columns: Waiting for you, Being made, Ready for a runner, Delivered tonight (only orders a runner marked Delivered, with the time and the runner) and Returned. [Ready] moves an order to Ready for a runner, and every staff phone's Runs shows it. Returned shows "Couldn't serve: reason · Andy" with [Void · not made] [Void · made (waste)] [Remake]. *Decided in [FB 4.1] and [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10].*
2. **Ask the room to wait (F2, F41, C34).** The canvas "Hold · text the room" moves an order into Making as "Maya · held", with no ticket and no way back to Accept. Build [Ask the room to wait] (the chip says "Asked to wait · 1:20"). The order stays in Waiting for you, keeps aging and still needs Accept. It can never reach Ready or Delivered first. The guest sees "The bar needs a few minutes", a room-screen message, not a text. *Decided in [FB 4.1] and [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10], [Song systems and texts][spec-11].*
3. **A dead end (F35).** The canvas header has no links, seven desktop menus link to it, and every accept is stamped "Maya". Build the desktop side menu, the W4 button back, Lock and the signed-in person. Stamp each Accept with whoever is signed in. *Spec: [Staff screens and the bar POS][spec-10].*
4. **Escalation and print failures (F36, C24).** The canvas footer says "Waiting 4+ min · front desk and Andy texted". Build the exact sentence: "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup." Orders show cyan when new. Add "Ticket didn't print · Reprint"; the reprint prints "REPRINT 2". *Decided in [FB 4.1]. Spec: [Devices, printing and offline][spec-09], [Staff screens and the bar POS][spec-10].*
5. **The 4 AM stop (F20, C4).** The canvas has no late or cut-off state. Build "Cancelled at 4:00 AM" under Returned, with no Decline button after 4 AM: unaccepted alcohol orders cancel by themselves with a message to the room. A cut-off room's orders show "Cancelled · cut off by Andy". *Decided in [FB 4.7]. Spec: [Staff screens and the bar POS][spec-10], [Money rules][spec-05].*
6. **Room 5 and Room 3 (F44, F33).** The canvas shows Room 5 as "Kenji W. · party of 5 · ID 4 of 5" and calls Room 3's party "Walk-in". Build Leo M. · 4 with "ID ✓ 4 of 4" in Room 5, and Priya R. in Room 3. The orders are o1 to o4 of the seed: Room 9 ringing 0:43, Room 5 ringing 2:11, Room 3 ready 4:00, Room 1 ready 1:35 ("ID ✓ 3 of 4 · runner checks the last ID"). *Decided in [FB 3a] and [FB 3e]. See: [Demo seed][see-seed].*
7. **Outage banners (F12, C11).** The canvas has none. Build the banners and queue mode ([N29](#n29-outage-banners-and-queue-mode)). *Decided in [FB 4.9]. Spec: [Devices, printing and offline][spec-09].*
8. **Module (F37).** The canvas is always there. Build Bar orders only while Bar screen & tickets is on. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03].*
9. **No bar device (F53).** The canvas has no alert for a venue with no bar device connected. Build it ([N32](#n32-no-bar-device-connected)): every bar-role phone buzzes, and the Board shows an alert during opening hours. *Not decided in the fix brief. Spec: [Devices, printing and offline][spec-09].*

### Rail

[`Rail.dc.html`](../design/canvas/Rail.dc.html) · "D · Desktop app · Bar POS" · 1280 × 800

- **Becomes:** Staff app (React + Vite), desktop layout, inside the Electron desktop shell. The bar computer's home.
- **Ships in:** [M6], [M8].
- **Purpose:** The bar POS: quick sale, card-first tabs with growing holds, room orders across the top, and the tab's check.
- **Also build here, from the spec:** [N2](#n2-receipts-printed-and-web) Receipts, printed and web, [N16](#n16-no-more-alcohol-cut-off) No more alcohol (cut off), [N21](#n21-close-out-steps-and-card-states) Close-out steps and card states, [N22](#n22-refund-from-check) Refund from check, [N23](#n23-new-bar-tab-consent-line-and-slip) New bar tab: consent line and slip, [N27](#n27-kj-song-queue-screen) KJ song-queue screen, [N29](#n29-outage-banners-and-queue-mode) Outage banners and queue mode, [N30](#n30-training-band) Training band.

**Build notes**

1. **Room orders across the top (F1, F2).** The canvas Accept removes the card and nothing follows; there is no Ask the room to wait, and Room 9's tab stays at $480. Build the cards with [Accept · print ticket] [Ask the room to wait] [Decline…]. Accepted orders join the room's check at once and show Being made → [Ready]. *Decided in [FB 4.1]. Spec: [Staff screens and the bar POS][spec-10].*
2. **Split (F9, C30).** The canvas forgets a paid share when the pay panel closes, and splits $32.66 into $16.32 and $16.34 (floating point, remainder to the last share). Build the split on the server, in cents: $32.66 ÷ 2 = $16.33 + $16.33, and for an odd amount the first share gets the extra cent. The tab list shows "Partly paid · $16.33 of $32.66", a share can be paid in cash, and "Stop splitting · charge the rest to …" ends the split. *Decided in [FB 4.8]. Spec: [Payment flows][spec-07], [Money rules][spec-05]. See: [Money cases][see-cases].*
3. **Reopen (F10).** The canvas reopens a captured tab with a hold chip and "Close to Mastercard". Build "Paid $272.19 · no hold" and no "Close to card". New drinks are paid by a new tap, by cash, or by [Charge the saved card], which needs the guest's confirmation or a manager's OK. With $0 due, no pay buttons show. *Decided in [FB 4.8]. Spec: [Payment flows][spec-07].*
4. **Fix panel (F11, F41, C15).** The canvas already follows the limit. Keep the panel as the model for every screen: made or not made, a reason, "$X left this shift". Label a void VOID and a comp COMP. Maya has used $12 of $75 tonight and Diego $0. Diego's void of 1 × Large bucket · 10 beers ($70) on Tariq A.'s tab is over $25, so it shows "Waiting for Andy". *Decided in [FB 2], [FB 4.6] and [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10], [Tenancy and access][spec-02].*
5. **Card states (F14, C12).** The canvas goes straight to "Paid". Build the states in the pay panel and on each split share ([N21](#n21-close-out-steps-and-card-states)): waiting for a tap, declined, "Checking with Stripe · don't retry", reader offline or busy, and "Hold raise declined" on a tab. *Decided in [FB 4.5]. Spec: [Payment flows][spec-07].*
6. **Bar reader and bar drawer (F17, C19).** The canvas assumes a bar reader and drawer that Admin doesn't list. Build the reader picker (Front desk S710 or Bar S710) and cash into the bar drawer, logged "Logged to Maya · bar drawer". *Decided in [FB 3g]. Spec: [Devices, printing and offline][spec-09], [Payment flows][spec-07].*
7. **Move tab to a room (F18).** The canvas moves single lines and leaves a $0 tab holding $50. Build [Move tab to a room]: pick a room in use, every line moves as a transfer, the tab closes as "Moved to Room 9", the room's check shows "Moved from Jess P.'s bar tab", and the hold is released once the room has a payment method. *Decided in [FB 4.8]. Spec: [Payment flows][spec-07].*
8. **Moves and cut-off tabs (F19).** The canvas lets 2 × Modelo move onto Hana K.'s cut-off tab, and a move never raises the hold. Build cut-off tabs greyed out as targets for alcohol, with the reason. A move runs the hold-raise check like a send. *Decided in [FB 4.8]. Spec: [Staff screens and the bar POS][spec-10].*
9. **Cut off and 4 AM (F20, C4).** The canvas cut-off is seeded (Hana K., cut off by Andy at 10:30 PM), with no control to cut anyone off. At "Demo: it's 4:02 AM" the room-order cards offer Decline. Build the Cut off control on a tab ([N16](#n16-no-more-alcohol-cut-off)) and at 4:00 AM show "Cancelled at 4:00 AM" with no Decline. From 4 to 8 AM every alcohol button greys out with the reason in words. *Decided in [FB 4.7]. Spec: [Staff screens and the bar POS][spec-10], [Money rules][spec-05].*
10. **Escalation and print failures (F36, C24).** The canvas says "their tablet explains" and has its own aging text. Build the exact escalation sentence, and "Ticket didn't print · Reprint" with "REPRINT 2". *Decided in [FB 4.1] and [FB 4.17]. Spec: [Devices, printing and offline][spec-09].*
11. **Words (F41).** The canvas says "Back to the tab" on a quick sale and "their tablet explains". Build "Back to the sale" and "their phones explain". "Hold" now means only a card authorization. *Decided in [FB 4.17].*
12. **Side menu and 86 (F54).** The canvas has no side menu, so Messages, Calendar and Night take two taps via the Board, and no way to mark an item out. Build the desktop side menu and 86: tap 86 above the grid, then an item or one of its variants. It greys out in its slot, marked "86'd tonight", on every staff screen and the guest menu, until restored or the night closes. *Spec: [Staff screens and the bar POS][spec-10].*
13. **New tab consent (C14).** The canvas has no consent line and no slip. Build the line and [Read to guest ✓] ([N23](#n23-new-bar-tab-consent-line-and-slip)). *Decided in [FB 4.8]. Spec: [Payment flows][spec-07].*
14. **Room tabs from one seed (F33, F45, C28).** The canvas lists Room 12 as opened 8:23 PM, 138 min, $322, and the VIP room as $296 in whole dollars. Build the seed: r9 Room 9 opened 8:00 PM, 161 min, $322.00, deposit $120; r12 Room 12, Omar F. · 14, opened 9:00 PM, 101 min, $235.67, deposit $140; r14 VIP room, Bianca L. · 22, opened 9:30 PM, 71 min, $295.83, deposit $250. *Decided in [FB 3f]. See: [Demo seed][see-seed].*
15. **Room 5 IDs (F44).** The canvas shows "ID 4 of 4" for Room 5 where the bar screen shows 4 of 5. Build "ID ✓ 4 of 4" for Leo M. · 4. *Decided in [FB 3a].*
16. **Song queue (F6, K6, C10).** The canvas has no song queue, though bar mode is on. Build the header link "Song queue · 6" ([N27](#n27-kj-song-queue-screen)). A drink bought at the bar without a tab earns a credit when the bartender picks the singer on the sale. *Decided in [FB 4.11]. Spec: [Song systems and texts][spec-11].*
17. **Queue mode (F12, C11).** The canvas has no outage state. Build the banners, and queue mode where the Rail marks rounds "queued · not charged" ([N29](#n29-outage-banners-and-queue-mode)). *Decided in [FB 4.9]. Spec: [Devices, printing and offline][spec-09].*
18. **Refund from Closed tonight (F8, C16).** The canvas has no refund. Managers refund from Closed tonight ([N22](#n22-refund-from-check)). *Decided in [FB 4.6]. Spec: [Payment flows][spec-07].*
19. **Diego on the Rail (F28, C2).** The canvas has Diego own tabs as "Front desk · covering the bar" while his role is Staff. Build it as allowed for the Front desk role, with Admin's switch to turn it off. *Decided in [FB 2]. Spec: [Tenancy and access][spec-02].*
20. **Training band (F39).** The canvas has none. Build the band and T- check numbers ([N30](#n30-training-band)). *Decided in [FB 4.14]. Spec: [Security and data retention][spec-12].*
21. **Late demo (F40).** The canvas's late demo is Sat 4:02 AM. Keep it, with business date Fri Sep 25. It comes before Night's 4:12 AM. *Decided in [FB 1].*

### DeskRoom

[`DeskRoom.dc.html`](../design/canvas/DeskRoom.dc.html) · "D · Desktop app · Room tab and clock" · 1280 × 800

- **Becomes:** Staff app (React + Vite), desktop layout, inside the Electron desktop shell.
- **Ships in:** [M2], [M3], [M4].
- **Purpose:** One room's tab and clock on the desktop: the check, comps and voids, and close-out.
- **Also build here, from the spec:** [N2](#n2-receipts-printed-and-web) Receipts, printed and web, [N6](#n6-pay-my-share) Pay my share, [N12](#n12-move-sheet) Move sheet, [N13](#n13-party-size-control) Party size control, [N14](#n14-report-a-fault) Report a fault, [N16](#n16-no-more-alcohol-cut-off) No more alcohol (cut off), [N19](#n19-calls-list) Calls list, [N21](#n21-close-out-steps-and-card-states) Close-out steps and card states, [N22](#n22-refund-from-check) Refund from check, [N30](#n30-training-band) Training band.

**Build notes**

1. **Comps and voids (F11, F41, C15).** The canvas says "Comps and voids need a reason and a manager's OK, given on their own phone", and sends every one to Andy, even an $8 comp. Build the reason-only limit ($25 each, $75 a shift per person, counted across every screen) with the Rail's fix panel. Over it, the line shows "Waiting for Andy"; Andy's own requests go to Abhishek. *Decided in [FB 2] and [FB 4.6]. Spec: [Tenancy and access][spec-02], [Staff screens and the bar POS][spec-10].*
2. **Close-out (F13, F14, F15, F16, F47, C12, C22).** The canvas goes Close out → Tap card ("Send $498.60 to the front desk reader") → "Paid." at once. Card on file goes "Ask Marcus to confirm" → "Paid". Cash says "The drawer opens when you mark it paid". Build the four steps of [N21](#n21-close-out-steps-and-card-states): Present the check (#1042), ways to pay with their states, the "Additional tip (optional)" line, and the receipt choices (the receipt itself is [N2](#n2-receipts-printed-and-web)) Text, Email, Print and No receipt. The ringing 2 × Margarita · Peach must be accepted or cancelled before the check can be presented. *Decided in [FB 4.5]. Spec: [Payment flows][spec-07], [API][spec-08].*
3. **The demo accept control (F1, F47).** The canvas has a "Bar accepted" control that isn't marked as a demo. Label it "Demo:" or remove it. A ringing order reads "Ringing · 0:43" and joins the check only when the bar accepts. *Decided in [FB 4.1] and [FB 6]. Spec: [Staff screens and the bar POS][spec-10].*
4. **Quick-add chips (F21).** The canvas has quick adds such as "Margarita $13" with no flavor. Build the bar POS's menu search, which creates an accepted staff order and prints a ticket, or "Open in the bar POS" with this room's tab selected. *Spec: [Staff screens and the bar POS][spec-10].*
5. **Move and party size (F22, F23).** The canvas has neither. Build the Move sheet ([N12](#n12-move-sheet)) and the party size control ([N13](#n13-party-size-control)). *Decided in [FB 4.4]. Spec: [Staff screens and the bar POS][spec-10].*
6. **Faults and damage fee (F24).** The canvas shows "Damage fee · photo attached" with no photo and a call cleared by "On it". Build Report a fault ([N14](#n14-report-a-fault)) and the damage fee with a photo and a reason. *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*
7. **No more alcohol (F20, C5).** The canvas has none. Build "No more alcohol for this room" ([N16](#n16-no-more-alcohol-cut-off)). *Decided in [FB 4.7]. Spec: [Staff screens and the bar POS][spec-10].*
8. **Refund (F8, C16).** The canvas has no refund on a paid check. Build Refund from check ([N22](#n22-refund-from-check)). *Decided in [FB 4.6]. Spec: [Payment flows][spec-07].*
9. **Guest shares (K2).** The canvas has none. Build the "Paid by a guest · Kevin (share 1 of 12) $41.55" lines ([N6](#n6-pay-my-share)). *Decided in [FB 4.5]. Spec: [Payment flows][spec-07].*
10. **Stay wording (F41, C32).** The canvas says "stay as long as you like". Build "Stay on by the minute until we close at 4 AM". *Decided in [FB 4.17]. Spec: [Song systems and texts][spec-11].*
11. **Training band (F39).** The canvas has none. Build the band and T- numbers ([N30](#n30-training-band)). *Decided in [FB 4.14]. Spec: [Security and data retention][spec-12].*
12. **Calls (F26).** The canvas shows "Another mic, please" with [On it · bringing a mic]. Keep it, and add the same call to every staff phone's Calls list ([N19](#n19-calls-list)). *Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10].*

### DeskCalendar

[`DeskCalendar.dc.html`](../design/canvas/DeskCalendar.dc.html) · "D · Desktop app · Calendar" · 1280 × 800

- **Becomes:** Staff app (React + Vite), desktop layout, inside the Electron desktop shell.
- **Ships in:** [M2].
- **Purpose:** Bookings ahead by day, blocked dates and the big-party payment link.

**Build notes**

1. **Tonight's bookings (F33, C28).** The canvas has Dana K. 8:30 for 2 hr, Leo M. in Room 5 as a booking, and no Jae & co. Build the 11 bookings of the seed. Leo M. is a walk-in, not a booking. *Decided in [FB 3b]. See: [Demo seed][see-seed].*
2. **The big-party link (F34, C37).** The canvas lets a host book 24 guests into the VIP room at 9:00 PM for 3 hr, and texts the link, while Bianca L.'s party of 22 holds the VIP room from 9:30 PM to 12:30 AM. 9:00 PM is also already past. Build the dialog to show the room and how long it is free, to refuse overlapping or past slots, and to place a pending hold that lapses at `pending_until` if the link goes unpaid. The spec doesn't fix the hold's length. *Not decided in the fix brief. Spec: [Payment flows][spec-07], [Data model][spec-04].*
3. **Hold wording (C37).** The canvas says "A room is held the second a deposit clears". Build the wording to match the spec: an online slot holds a real room for 10 minutes, and a payment link holds it until `pending_until`. *Spec: [Payment flows][spec-07].*
4. **Blocking a date (F52).** The canvas says affected bookings "stay until you move or cancel them" and offers no cancel-and-refund step. Build the list of affected bookings with "Cancel and refund all". A cancellation by the venue always refunds in full, and the guests are texted ("Text them →"). *Not decided in the fix brief. Spec: [Payment flows][spec-07].*
5. **Tonight (F40).** The canvas "Tonight" comes from a device clock. Build it from the pinned now, Fri Sep 25, 10:41 PM. *Decided in [FB 1].*

### DeskMessages

[`DeskMessages.dc.html`](../design/canvas/DeskMessages.dc.html) · "D · Desktop app · Messages" · 1280 × 800

- **Becomes:** Staff app (React + Vite), desktop layout, inside the Electron desktop shell.
- **Ships in:** [M2].
- **Purpose:** The desktop inbox for guest texts, and the list of automatic texts.

**Build notes**

1. **The 14 automatic texts (C34).** The canvas lists 8 automatic texts. Build the same 14 as Admin → Texts and the phone: 12 service texts and 2 marketing texts that stay off until they have their own opt-in. *Decided in [FB 3i]. Spec: [Song systems and texts][spec-11].*
2. **Booking confirmed text (C22).** The canvas text reads "Deposit $120 paid, comes off your tab" and has no gratuity line. Build the same text as Admin → Texts, with "A 20% gratuity is added to room tabs." and "comes off your bill". *Decided in [FB 3i]. Spec: [Song systems and texts][spec-11].*
3. **Threads (F33, C28).** The canvas puts "running late" on Sam O. here but Dana on the phone, and names the waitlist party "Priya K." (party of 6). Build the seed: Sam O. "running 15 late" at 10:24 PM, and Nadia K. (6) on the waitlist. *Decided in [FB 3a] and [FB 3c]. See: [Demo seed][see-seed].*
4. **Free-text links (F55).** The canvas reply box ("Reply as West 4") takes any text, links included. Build the rule: free text is allowed only as a reply in an open service conversation, and links and promotions are blocked there. A payment link goes out through the Payment link text. *Spec: [Song systems and texts][spec-11].*
5. **Stay wording (F41, C32).** The canvas Booked time ending text says "stay as long as you like". Build "…you can stay on by the minute until we close at 4 AM." *Decided in [FB 3i] and [FB 4.17]. Spec: [Song systems and texts][spec-11].*

### DeskReports

[`DeskReports.dc.html`](../design/canvas/DeskReports.dc.html) · "D · Desktop app · Reports" · 1280 × 800

- **Becomes:** Staff app (React + Vite), desktop layout, inside the Electron desktop shell. Owners and managers.
- **Ships in:** [M7].
- **Purpose:** Weekly and eight-week reports on the desktop.
- **Also build here, from the spec:** [N38](#n38-reports-and-exports) Reports and exports.

**Build notes**

1. **Export needs a passkey (F46).** The canvas "Email CSV" works from the shared computer with no passkey. Build exports so they ask for the passkey again: exports, team changes, large refunds and card-fee changes all do. *Spec: [Tenancy and access][spec-02].*
2. **Reviews count (F55).** The canvas counts "Reviews from the morning text 19 · 4.8" while that text is switched off. Build the line to show nothing, or "Off", while the Review ask text is off. *Decided in [FB 3i]. Spec: [Song systems and texts][spec-11].*
3. **Reports with no screen (F53, C37).** The canvas has no tax-quarter, payroll or accounting screens. Build them ([N38](#n38-reports-and-exports)). *Spec: [API][spec-08].*

## Product for other venues (3)

Screens for venues that aren't West 4 and for our own staff. They are phase 2, except a minimal Console, which is phase 1.

### Setup

[`Setup.dc.html`](../design/canvas/Setup.dc.html) · "P · New venue setup wizard" · 1280 × 800

- **Becomes:** Setup wizard for a new venue: staff app and Admin in a browser (React + Vite). Phase 2; West 4 does not use it.
- **Ships in:** Phase 2 ([not in phase 1](milestones.md#not-in-phase-1)).
- **Purpose:** The 10-step wizard a new venue walks through: venue, what it runs, rooms and prices, menu, songs, team, payments, devices, website, then a test night and Go live.
- **Also build here, from the spec:** [N9](#n9-the-singers-queue-page) The singer's queue page, [N27](#n27-kj-song-queue-screen) KJ song-queue screen, [N28](#n28-up-next-tv) Up next TV, [N35](#n35-admin--licenses) Admin → Licenses.

**Build notes**

1. **Roles in step 6 (C2, F28).** The canvas step 6 lists four roles (Owner, Manager, Bartender, Staff), gives Staff "check-ins, walk-ins, texts", and sets Diego R. to Staff in its West 4 preset. Build the five roles with the permission table (Owner, Manager, Bartender, Front desk, Staff), and set Diego to Front desk. *Decided in [FB 2]. Spec: [Tenancy and access][spec-02].*
2. **PIN wording (C25).** The canvas step 6 says "Everyone gets their own PIN." Build "badge or name and PIN". Each person still chooses their PIN on their own phone from the invite link. *Decided in [FB 4.17]. Spec: [Tenancy and access][spec-02].*
3. **Step 8 hardware (C18, F38).** The canvas step 8 lists card readers, a ticket printer, a receipt printer with a drawer, tablets and a router. It has no USB NFC reader, no NTAG 424 DNA badges and no Up next TV, and West 4's preset orders "1 × S710". Build West 4's devices from the seed: the bar and front-desk computers, two NFC readers, two receipt printers each with a drawer, the Bar S710 and the Front desk S710, 14 room tablets, the Up next TV and the dual-WAN router, with badges for Abhishek, Andy, Maya and Diego. Offer only supported models: the S710 is the only reader with cellular, and the S700 and WisePOS E are labeled "no cellular backup". *Decided in [FB 3g]. Spec: [Devices, printing and offline][spec-09].*
4. **Bar reader and drawers (F17, C19).** The canvas preset has one drawer, on the front-desk printer, and the test night never checks a bar reader or a bar drawer. Build two house drawers (bar and front desk) in step 7's cash choice, and add a bar reader check and a bar drawer check to the test night. *Decided in [FB 3g]. Spec: [Devices, printing and offline][spec-09].*
5. **Escalation wording (C24).** The canvas step 2 describes Bar screen & tickets as "Orders ring the bar until accepted", and the test night says a room order "has to ring the bar until someone accepts it." Build the one sentence: "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup." *Decided in [FB 4.1]. Spec: [Devices, printing and offline][spec-09].*
6. **Bar mode (F6, C10).** The canvas step 2 describes Bar mode as "Phone song queue, per-song charges, Up next TV, send the singer a drink", and step 5 says "staff mark each song as it starts". Those screens are not on the canvas ([N9](#n9-the-singers-queue-page), [N27](#n27-kj-song-queue-screen), [N28](#n28-up-next-tv)). Build the card so a song price is optional: West 4's offer is "Buy a drink, get a song" and its song price is not set. *Decided in [FB 4.11]. Spec: [Song systems and texts][spec-11].*
7. **Dependencies (F37).** The canvas step 2 lists Ordering from the room as needing only Rooms & room clock. Build it to need Bar screen & tickets as well, and use the same dependency rules as Admin → Features. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03].*
8. **West 4's setup checks (C8).** The canvas wizard is where the spec puts three checks: the merchant category before bar tabs turn on, each manager's Stripe Dashboard login, and a phone that runs Tap to Pay. The wizard is phase 2. Build them as the M4 go-live checklist for West 4, and have the wizard run them later. *Spec: [Stripe setup][spec-06], [Tenancy and access][spec-02]. See: [Milestones][see-milestones].*
9. **Licenses (C6).** The canvas asks for the music licenses (ASCAP, BMI, SESAC, GMR) only as ticks in step 10. Build Admin → Licenses now ([N35](#n35-admin--licenses)); the wizard's step reads and writes the same register. *Spec: [Data model][spec-04], [API][spec-08].*
10. **One status everywhere (F38).** The canvas shows Stripe not connected and 0 of 10 steps, while the Console says 10 of 10 for West 4. Build the wizard's checklist, Admin and the Console from the same rows so they never disagree. *Decided in [FB 3g]. Spec: [Devices, printing and offline][spec-09].*

### SiteBuilder

[`SiteBuilder.dc.html`](../design/canvas/SiteBuilder.dc.html) · "P · Website builder" · 1280 × 800

- **Becomes:** Website builder inside Admin (React + Vite), in a browser. Phase 2; phase 1 has Admin → Website only.
- **Ships in:** Phase 2 ([not in phase 1](milestones.md#not-in-phase-1)).
- **Purpose:** The website builder: a style, an accent color, fonts, photos, section order and words, search text, languages and the web address, with a live phone or desktop preview.

**Build notes**

1. **Hero button when booking is off (F37).** The canvas greys the Booking section and drops the nav's Book link when the Booking module is off, but the hero keeps "Book a room" and scrolls to Find us. Build the hero button as "Call to book" with West 4's number, and keep the greyed section. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03].*
2. **What phase 1 ships.** The canvas builder edits styles, fonts, colors, section order, domains and languages. Phase 1 ships Admin → Website only: the words, the photos, which sections show and how prices are worded, saved as `site_versions`. Styles, section order and own domains wait for the builder in phase 2. *Spec: [Settings, rule packs and modules][spec-03], [Scope and architecture][spec-01]. See: [Milestones][see-milestones].*
3. **Price wording.** The canvas price lines read "per person, per hour" and "$10 per person per hour" in the search text. Build "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour", read from the venue's prices. *Decided in [FB 4.17]. Spec: [Settings, rule packs and modules][spec-03].*

### Console

[`Console.dc.html`](../design/canvas/Console.dc.html) · "P · Our control panel · venues, plans, modules" · 1280 × 800

- **Becomes:** The internal Console: our staff's tool on its own hostname, single sign-on with a FIDO2 key. The minimal version is phase 1; the full control panel is phase 2.
- **Ships in:** [M1], [M8].
- **Purpose:** Our view of each venue: its plan, the modules it may use, setup, billing, device health and support access.
- **Also build here, from the spec:** [N39](#n39-admin--console) Admin → Console.

**Build notes**

1. **Same facts as Admin (F38, C28).** The canvas shows West 4 as "7/7 online" with 10 of 10 setup steps, while Admin shows the bar reader on order, 13 of 14 room tablets online and the router "to set up". Build the Console from the same device rows as Admin → Printers & devices: 13 of 14 room tablets online (Room 4's is off), both readers online, "Backup internet · on". *Decided in [FB 3g]. Spec: [Devices, printing and offline][spec-09]. See: [Demo seed][see-seed].*
2. **The minimal Console in phase 1 (C8).** The canvas Console is the full control panel: venues, plans, billing, tickets and beta flags. Phase 1 needs a smaller one. Build sign-in with single sign-on and a FIDO2 key, a read-only venue list with device health, the module allow-list (`venue_modules.allowed`) and venue flags, and rule-pack publishing with two approvers and a signature in M1. Build support grants and the emergency actions in M8. Plans, billing and tickets stay for the full panel. *Spec: [Tenancy and access][spec-02], [Settings, rule packs and modules][spec-03], [Scope and architecture][spec-01]. See: [Milestones][see-milestones].*
3. **Owner approves support access.** The canvas says a venue's "owner or a manager" approves a support request. Build owner only: the request is approved in the venue's Admin → Console ([N39](#n39-admin--console)), which managers don't see. A grant is read-only on masked views, lasts up to 60 minutes and ends when the owner ends it. *Spec: [Tenancy and access][spec-02].*
4. **Dependencies (F37).** The canvas module list has Ordering from the room needing only Rooms & room clock. Build it to need Bar screen & tickets too, from the same module list Admin → Features and Setup read. *Decided in [FB 4.16]. Spec: [Settings, rule packs and modules][spec-03].*
5. **Module wording (C24).** The canvas describes Bar screen & tickets as "Orders ring the bar until accepted". Build the module text from the same source as Admin → Features, with the one escalation sentence. *Decided in [FB 4.1]. Spec: [Devices, printing and offline][spec-09].*

## Not on the canvas — build from the spec

The canvas has no board for these screens and states. The Sep 28 [fix brief](archive/fix-brief-sep28.md#5-new-boards-file-names-fixed-now-so-everyone-can-link-to-them) planned four boards (`SingQueue`, `UpNext`, `Receipt` and `KJ`) and was going to draw the join step, Your bill and Pay my share as states of Order, and Book's details, consent, payment and confirmation as states of Book. None was drawn before the canvas froze. Build each from the spec.

Each entry names the screen it lives in, the milestone that ships it, the findings behind it and the spec that says how it works.

| # | Screen or state | Lives in | Ships in |
| --- | --- | --- | --- |
| [N1](#n1-booking-steps-after-the-price) | Booking steps after the price | States of [Book](#book), then the manage page [Manage](#manage) | [M5] |
| [N2](#n2-receipts-printed-and-web) | Receipts, printed and web | Receipt choices at the end of close-out ([N21](#n21-close-out-steps-and-card-states)), on [DeskRoom](#deskroom), [Room](#room) and [Rail](#rail); the link in the receipt text | [M4] |
| [N3](#n3-join-a-room) | Join a room | The first state of [Order](#order), before the room page | [M3] |
| [N4](#n4-room-tablet-kiosk) | Room tablet (kiosk) | [Order](#order) on a tablet, plus the between-sessions screen | [M3] |
| [N5](#n5-your-bill) | Your bill | A state of [Order](#order), and the page behind the guest's booking link | [M4] |
| [N6](#n6-pay-my-share) | Pay my share | The bill page ([N5](#n5-your-bill)) on [Order](#order) | [M4] |
| [N7](#n7-same-again) | Same again | A row in the menu state of [Order](#order) | [M3] |
| [N8](#n8-confirm-the-card-on-file) | Confirm the card on file | The bill page ([N5](#n5-your-bill)) on [Order](#order), and the guest's booking link | [M4] |
| [N9](#n9-the-singers-queue-page) | The singer's queue page | Opened from "Sing at the bar" on [Main](#main) and [Waitlist](#waitlist), and from the QR code on the Up next TV ([N28](#n28-up-next-tv)) | [M6] |
| [N10](#n10-check-in-sheet) | Check-in sheet | [Board](#board) (Arriving and Late bookings on their room's tile and panel, and [+ Walk-in]) and [Staff](#staff) (a booking's Details, and Sam O.'s row) | [M2] |
| [N11](#n11-waitlist-drawer) | Waitlist drawer | [Board](#board) (from "Waitlist · 3") and [Staff](#staff) | [M2] |
| [N12](#n12-move-sheet) | Move sheet | [Board](#board), [DeskRoom](#deskroom), [Room](#room) and [Staff](#staff) | [M2] |
| [N13](#n13-party-size-control) | Party size control | [Board](#board), [DeskRoom](#deskroom), [Room](#room) and [Staff](#staff) | [M2] |
| [N14](#n14-report-a-fault) | Report a fault | [Board](#board) and [DeskRoom](#deskroom); a guest's "TV or song isn't working" call ([N19](#n19-calls-list)) can be logged as a fault | [M2] |
| [N15](#n15-lost-and-found) | Lost and found | [Board](#board) | [M2] |
| [N16](#n16-no-more-alcohol-cut-off) | No more alcohol (cut off) | [Rail](#rail) (a tab), [Board](#board), [DeskRoom](#deskroom) and [Room](#room) ("No more alcohol for this room"), and one guest in a room | [M3] |
| [N17](#n17-clear-out-check) | Clear-out check | [Board](#board) and [Night](#night) | [M3] |
| [N18](#n18-approvals-inbox) | Approvals inbox | [Staff](#staff), in a passkey-protected session on the approver's own phone | [M2] |
| [N19](#n19-calls-list) | Calls list | [Board](#board), [Staff](#staff) and [DeskRoom](#deskroom) | [M2] |
| [N20](#n20-help-alert-manager-needed-pin-and-incident-log) | Help alert, "Manager needed" pin and incident log | The private link on [Order](#order), [Staff](#staff) (managers' phones only) and [Board](#board) | [M8] |
| [N21](#n21-close-out-steps-and-card-states) | Close-out steps and card states | [DeskRoom](#deskroom), [Room](#room) and [Rail](#rail) | [M4] |
| [N22](#n22-refund-from-check) | Refund from check | [Staff](#staff), [DeskRoom](#deskroom), [Room](#room) and [Rail](#rail) | [M4] |
| [N23](#n23-new-bar-tab-consent-line-and-slip) | New bar tab: consent line and slip | [Rail](#rail) (New tab) | [M6] |
| [N24](#n24-clock-in-duty-and-clock-out-checklist) | Clock-in duty and clock-out checklist | [Pin](#pin) and [Staff](#staff) | [M7] |
| [N25](#n25-set-your-pin) | Set your PIN | Before [Pin](#pin); invites are sent from Admin → Team ([AdminDesk](#admindesk)) | [M1] |
| [N26](#n26-tips-to-enter) | Tips to enter | [Staff](#staff) | [M6] |
| [N27](#n27-kj-song-queue-screen) | KJ song-queue screen | Opened from "Song queue · 6" on [Rail](#rail), from [Bar](#bar) and from the side menu | [M6] |
| [N28](#n28-up-next-tv) | Up next TV | Linked from [N27](#n27-kj-song-queue-screen) | [M6] |
| [N29](#n29-outage-banners-and-queue-mode) | Outage banners and queue mode | [Board](#board), [Rail](#rail), [Bar](#bar), [Staff](#staff) and [Night](#night) (the review list), each with a "Demo:" control on the prototypes | [M8] |
| [N30](#n30-training-band) | Training band | [Rail](#rail), [Board](#board), [Room](#room) and [DeskRoom](#deskroom), with a "Demo: training mode" toggle on the prototypes | [M7] |
| [N31](#n31-occupancy-warning-and-door-counter) | Occupancy warning and door counter | [Board](#board) | [M2] |
| [N32](#n32-no-bar-device-connected) | No bar device connected | [Board](#board) and [Bar](#bar) | [M3] |
| [N33](#n33-admin--bar-pos) | Admin → Bar POS | [AdminDesk](#admindesk), a new section | [M6] |
| [N34](#n34-admin--bar-mode) | Admin → Bar mode | [AdminDesk](#admindesk), a new section | [M6] |
| [N35](#n35-admin--licenses) | Admin → Licenses | [AdminDesk](#admindesk), a new section | [M8] |
| [N36](#n36-admin--safety) | Admin → Safety | [AdminDesk](#admindesk), a new section | [M2] |
| [N37](#n37-admin--payments-disputes-and-unmatched-payments) | Admin → Payments, disputes and Unmatched payments | [AdminDesk](#admindesk), new sections; Unmatched payments opens from Close the night ([Night](#night)) | [M4] |
| [N38](#n38-reports-and-exports) | Reports and exports | [Reports](#reports) and [DeskReports](#deskreports) | [M7] |
| [N39](#n39-admin--console) | Admin → Console | [AdminDesk](#admindesk), a new section; managers don't see it | [M8] |
| [N40](#n40-admin--kitchen) | Admin → Kitchen | [AdminDesk](#admindesk), a new section where the Console allows Kitchen & food | [K-01](backlog/K-kitchen.md) |

### Guest pages and states

Screens and states a guest sees on the website, on their phone or on a room tablet. None has a board; they take the guest website's look in the phone's light or dark setting (founder, Oct 9, 2026; V-07).

#### N1. Booking steps after the price

- **Becomes:** Guest web (Next.js); the payment step runs on its own origin.
- **Lives in:** States of [Book](#book), then the manage page [Manage](#manage).
- **Ships in:** [M5].
- **Findings:** C13, F5, F32.

The canvas stops at "Pay $X deposit". Build every step after it as a state of the Book page. A slot chosen in Pick holds a real room for 10 minutes, and a countdown shows on every later step. Each booking has one PaymentIntent, reused on every retry.

- **Pick.** Date, party size with the billable minimum shown ("Fri & Sat bill at least 4 · you pay for 4"), time and length. The form has a CAPTCHA checked on the server and daily limits per phone number, IP address and device.
- **Details.** Name, mobile and email. A line says the confirmation and reminders come by text to that number. An unticked box for marketing texts, separate from the booking.
- **Terms.** The policy version above the pay button: the deposit comes off the bill; the card is saved, and the rest of the tab and a no-show charge can go on it later, with how each amount is worked out and when; the refund cut-off; and "A 20% gratuity is added to room tabs."
- **Payment.** The payment page on its own origin, with the Payment Element (Apple Pay, Google Pay or card) and "Pay $50 deposit" for Jae & co. (5 guests at $10). Paying stores the policy version and its hash, the time, the IP address and the browser.
- **Confirmed.** The room size, date and time, the deposit paid, "Free to cancel until …", the gratuity sentence, a note that the confirmation text went to their number, and a link to manage the booking. The Booking confirmed text says the same.
- **Failures.** A declined card asks for another card on the same PaymentIntent. A hold that ran out before paying sends the guest back to pick a time. A payment that lands after the hold lapsed, when the room has gone, is refunded in full and the page says so. While the server waits for Stripe, the page says it is still checking and never shows a second pay button.
- **Payment link.** A staff or big-party booking sends a link (`POST /bookings/{b}/payment-link`). The guest opens it, accepts the policy and pays on their phone. The booking stays pending until `pending_until`, and the hold lapses if the link goes unpaid.

*Decided in [FB 5]. Spec: [Payment flows][spec-07], [Security and data retention][spec-12], [Money rules][spec-05].*

#### N2. Receipts, printed and web

- **Becomes:** Guest web (Next.js) for the public page; the receipt printer and the PDF job for print and email.
- **Lives in:** Receipt choices at the end of close-out ([N21](#n21-close-out-steps-and-card-states)), on [DeskRoom](#deskroom), [Room](#room) and [Rail](#rail); the link in the receipt text.
- **Ships in:** [M4].
- **Findings:** C22, C37, F47.

No board shows a receipt. Build one receipt that reads the same printed, texted, emailed and on the public page (`GET /v1/public/receipts/{token}`), for a room check and for a bar tab. The page link carries a token that is stored hashed and expires.

- **Room check.** Room time with minutes and rate, drinks and packages, comps and voids as COMP and VOID, tax lines by category, "Gratuity included (20%)", the deposit as a credit ("Deposit −$120.00"), the amount due, how it was paid, and the check number (#1042).
- **Additional tip.** Any tip line reads "Additional tip (optional)", never "Gratuity". A card surcharge, where a venue turns the fee on, is its own line "Credit card surcharge" with its tax. West 4's fee is off.
- **Bar tab.** Items and tax. "Gratuity included" appears only where the venue adds a gratuity to bar tabs; West 4 doesn't, and bar tabs tip on the reader.
- **Split and shares.** Each guest share shows as a line ("Paid by a guest · Kevin (share 1 of 12) $41.55"), and cash parts are recorded.
- **Training.** Printed tickets and receipts say TRAINING, and the check number starts with T-.
- **Web page.** Paid, and later refunded, states for the same check. The receipt PDF is also the first piece of dispute evidence.

*Decided in [FB 4.5]. Spec: [Money rules][spec-05], [Payment flows][spec-07], [API][spec-08].*

#### N3. Join a room

- **Becomes:** Guest web (Next.js), the guest's phone.
- **Lives in:** The first state of [Order](#order), before the room page.
- **Ships in:** [M3].
- **Findings:** C37, F27.

The canvas opens already inside Room 9 with "Code KX4M7" in the header. Build the join step first. A guest scans the QR code on the wall and enters the room's 5-character code, or opens the link in the host's Room code text, which joins them as the host. Everyone else joins as a friend. The code is traded once for a 128-bit session token in a cookie, and codes never contain the room number.

- **Enter the code.** The QR code opens the page. The guest types the 5 characters.
- **Wrong code.** The page says so. Ten wrong codes for one room rotate its code and alert staff.
- **Room closed.** A room with no session says so.
- **Host link.** The Room code text carries the join link. The host's token adds canceling and the host lock.
- **After a move.** The old code stops working, and joined phones show "You've moved to Room 11 · new code …".

*Decided in [FB 5]. Spec: [Devices, printing and offline][spec-09], [Tenancy and access][spec-02].*

#### N4. Room tablet (kiosk)

- **Becomes:** Guest web (Next.js) in managed kiosk mode on each room's tablet.
- **Lives in:** [Order](#order) on a tablet, plus the between-sessions screen.
- **Ships in:** [M3].
- **Findings:** C37, F27.

Each tablet is paired to one room and runs the guest web in managed kiosk mode. It works online only, has no PIN pad and no help link (the private help link is on guests' own phones).

- **Room available.** Between sessions. It takes no orders.
- **In session.** The clock, the running total from the server (refreshed every minute), the menu and call staff.
- **Bill ready.** After the check is presented: "Your bill is ready · ordering is closed".
- **Room 4.** Its tablet is off while the room is out of service, so 13 of 14 tablets are online.

*Spec: [Devices, printing and offline][spec-09], [Tenancy and access][spec-02].*

#### N5. Your bill

- **Becomes:** Guest web (Next.js), the guest's phone and the booking link.
- **Lives in:** A state of [Order](#order), and the page behind the guest's booking link.
- **Ships in:** [M4].
- **Findings:** F13, F15.

After staff Present the check, joined phones show "Your bill is ready · ordering is closed" with the bill link, and the guest's booking link opens the same page. New orders answer `409 ordering_closed`.

- **The bill.** The itemized total, the deposit (−$120.00), tax, the 20% gratuity and the amount due ($498.60 for Room 9).
- **Ways to pay.** "Pay with Amex ··1005" (this is how the guest confirms a card on file, [N8](#n8-confirm-the-card-on-file)), "Pay another way", "Pay cash to staff" (New York requires venues to take cash on site), and Pay my share when it is on ([N6](#n6-pay-my-share)).
- **Paid.** The receipt link ([N2](#n2-receipts-printed-and-web)).
- **Check reopened.** A manager can Reopen the check. Ordering opens again, and the bill shows the new revision.

*Decided in [FB 4.5]. Spec: [Payment flows][spec-07], [API][spec-08].*

#### N6. Pay my share

- **Becomes:** Guest web (Next.js); the payment step runs on its own origin.
- **Lives in:** The bill page ([N5](#n5-your-bill)) on [Order](#order).
- **Ships in:** [M4].
- **Findings:** K2.

The bill page offers Pay my share when the venue turns it on (`pay.payShare`, on at West 4, because an online card costs 2.9% + 30¢ against 2.7% + 5¢ in person). Each share is its own payment on the venue's account, allocated to the room's check and never more than the amount due. The booker's card still guarantees the rest.

- **Choose.** "My items" or "An even share (1 of N)". N starts at the party size. An even share divides what was left to pay when the check was presented into N shares in cents, with leftover cents to the first shares, so a share doesn't change as others pay. The guest sees their share of tax and gratuity.
- **Pay.** Apple Pay, Google Pay or card through the Payment Element on the payment page. There is no tip prompt, because the gratuity is on the check. A share saves no card.
- **On the room tab.** Staff see the payment land as a line: "Paid by a guest · Kevin (share 1 of 12) $41.55". Room 9's $498.60 ÷ 12 is $41.55 each.

*Decided in [FB 4.12] and [FB 4.5]. Spec: [Payment flows][spec-07], [Stripe setup][spec-06], [Money rules][spec-05].*

#### N7. Same again

- **Becomes:** Guest web (Next.js), the room page on phones and tablets.
- **Lives in:** A row in the menu state of [Order](#order).
- **Ships in:** [M3].
- **Findings:** K16.

One "Same again" row lists the room's last delivered rounds. One tap orders one again. It is an ordinary room order: it rings the bar, needs Accept, and the server checks the alcohol window, any cut-off and 86'd items like any other order.

- **Row.** The last delivered rounds, newest first, each with its items and total before tax.
- **After the tap.** The order shows the guest's words: "Sent to the bar · you can still cancel".

*Decided in [FB 4.12]. Spec: [Staff screens and the bar POS][spec-10], [API][spec-08].*

#### N8. Confirm the card on file

- **Becomes:** Guest web (Next.js), the guest's phone.
- **Lives in:** The bill page ([N5](#n5-your-bill)) on [Order](#order), and the guest's booking link.
- **Ships in:** [M4].
- **Findings:** F14, F15.

When staff choose Card on file at close-out, the guest confirms on their own phone. The charge is never more than the amount due, and an itemized receipt is texted at once.

- **Waiting for the guest.** Staff see "Waiting for Marcus to confirm on his phone · Cancel". The guest sees the bill with "Pay with Amex ··1005".
- **Guest has left.** Staff see "Ask a manager to approve". A manager approves on their own phone with a reason (`mit_reason`), and the request shows in [N18](#n18-approvals-inbox).
- **Declined.** The saved card is declined. Staff see "Declined · try another card or cash", and the guest is texted a payment link.

*Decided in [FB 4.5]. Spec: [Payment flows][spec-07].*

#### N9. The singer's queue page

- **Becomes:** Guest web (Next.js), the singer's phone. A planned board, `SingQueue.dc.html`, was never drawn.
- **Lives in:** Opened from "Sing at the bar" on [Main](#main) and [Waitlist](#waitlist), and from the QR code on the Up next TV ([N28](#n28-up-next-tv)).
- **Ships in:** [M6].
- **Findings:** C10, F6, K6.

Bar mode is on at West 4 with the offer "Buy a drink, get a song". The queue page is where a singer joins and watches their place. A singer has a display name and a phone number confirmed once with a code, and gets a tab only once they owe something. The page never shows another singer's phone number.

- **Join.** A display name and a phone number, confirmed once with a code. Staff can also add someone at the bar.
- **Song search.** Reads `song_catalog`. With no catalog yet, the singer types a title and artist.
- **My songs.** The singer's queued songs.
- **Your place.** The place counts the singers still to start before you. At 2 the page and a push say "2 singers before you". When the singer before you starts: "You're up next at the bar · come to the stage", by push and by text. A push needs the phone to allow it, and the open page always shows the alert. Ben T. is the seed's phone demo: place 3, "2 singers before you".
- **Credits.** Each drink bought earns one credit. A singer with no credit and no song price sees "Needs a drink credit" (Sofia R. in the seed). A cut-off from alcohol never stops anyone singing.
- **Send the singer a drink.** A guest or staff member sends a gift order, charged to the sender's tab, that rings the bar like any order. It checks the alcohol window and the receiving singer's tab, and the bartender checks ID at hand-off. The spec doesn't say which page starts it.

*Decided in [FB 4.11] and [FB 5]. Spec: [Song systems and texts][spec-11], [Tenancy and access][spec-02].*

### Staff screens, sheets and lists

Screens and states on the staff phones, the desktop app and the Up next TV.

#### N10. Check-in sheet

- **Becomes:** Staff app (React + Vite): the Board on desktop and the phone's Staff tab.
- **Lives in:** [Board](#board) (Arriving and Late bookings on their room's tile and panel, and [+ Walk-in]) and [Staff](#staff) (a booking's Details, and Sam O.'s row).
- **Ships in:** [M2].
- **Findings:** F3, F44.

One sheet, the same wherever it opens (`POST /bookings/{b}/check-in {party_size, ids_checked, room_id, start_at}`). [Mark no-show] sits beside Check in and is allowed only after the 15-minute grace. [+ Walk-in] opens the same sheet with a free room.

- **1 Party size.** The count, with the billable minimum: "3 guests · Fridays bill at least 4" (Sam O.).
- **2 IDs.** Checked "x of n", plus "The runner checks the rest". The board's "ID ✓ 4 of 4" reads from it.
- **3 Room.** Confirmed or changed.
- **4 Clock.** Start now, or at the booked time.
- **5 Deposit.** Applied to the check (−$40 for Sam O.).
- **6 Room code.** A new 5-character code is texted to the host with the join link.

*Decided in [FB 4.2]. Spec: [Staff screens and the bar POS][spec-10], [API][spec-08].*

#### N11. Waitlist drawer

- **Becomes:** Staff app (React + Vite): a drawer on the Board, and the phone's Waitlist tab.
- **Lives in:** [Board](#board) (from "Waitlist · 3") and [Staff](#staff).
- **Ships in:** [M2].
- **Findings:** F4, F43.

Each row shows the party size, joined time, quote and wait, with Offer a room, Text and Remove.

- **Offer a room.** Picks the smallest room that fits and is free for an hour, or a bigger one if no booking tonight needs it. It holds the room for 10 minutes, sends the Room ready text and shows a countdown. In the seed, Room 11 (free all night) goes to Amara B. (7).
- **Text failed.** A text that fails shows "Not delivered · Call (212)…".
- **Seat.** Opens check-in in the held room ([N10](#n10-check-in-sheet)).
- **Expired.** The room goes to the next party that fits.
- **Rows.** Amara B. (7), Nadia K. (6) and Chris P. (3, bills as 4).

*Decided in [FB 4.3]. Spec: [Staff screens and the bar POS][spec-10], [Song systems and texts][spec-11].*

#### N12. Move sheet

- **Becomes:** Staff app (React + Vite): the Board, and the room tab on desktop and phone.
- **Lives in:** [Board](#board), [DeskRoom](#deskroom), [Room](#room) and [Staff](#staff).
- **Ships in:** [M2].
- **Findings:** F22.

Lists only rooms that fit the party and are free for the time needed, with their free-until time. Occupied and too-small rooms are greyed out with the reason.

- **The move.** Opens a new clock segment and a new room code, sends the old room to cleaning, and shows joined phones "You've moved to Room 11 · new code …".
- **Seed.** Rob & Kim (7) in Room 7, 11 min past their end with the Parks booked at 11:00. The sheet lists Room 11, free all night.

*Decided in [FB 4.4]. Spec: [Staff screens and the bar POS][spec-10].*

#### N13. Party size control

- **Becomes:** Staff app (React + Vite): the Board panel, and the room tab on desktop and phone.
- **Lives in:** [Board](#board), [DeskRoom](#deskroom), [Room](#room) and [Staff](#staff).
- **Ships in:** [M2].
- **Findings:** F23.

+ and − change the party size. They show the new hourly rate and the billable minimum.

- **A change.** Closes the current clock segment and updates the "ID ✓ x of n" chip.
- **Lowering it.** After the gratuity applies, a lower party size needs approval ([N18](#n18-approvals-inbox)) and writes a reversal line.

*Decided in [FB 4.4]. Spec: [Staff screens and the bar POS][spec-10], [Money rules][spec-05].*

#### N14. Report a fault

- **Becomes:** Staff app (React + Vite): the Board and the room tab on desktop.
- **Lives in:** [Board](#board) and [DeskRoom](#deskroom); a guest's "TV or song isn't working" call ([N19](#n19-calls-list)) can be logged as a fault.
- **Ships in:** [M2].
- **Findings:** F24.

Logs a fault on the room. Open faults show on the room's tile.

- **Out of service.** The room shows "Out of service" with the note. Room 4: "Mic dead since Tue. Replacement ordered." (logged Tue Sep 22).
- **Pause the clock.** Needs approval ([N18](#n18-approvals-inbox)).
- **Comp 15 min.** A reason-only comp of room time.
- **Damage fee.** $150, added on the room tab only with a photo (camera or upload) and a reason. The line shows the photo's thumbnail.

*Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10], [Data model][spec-04].*

#### N15. Lost and found

- **Becomes:** Staff app (React + Vite): the Board.
- **Lives in:** [Board](#board).
- **Ships in:** [M2].
- **Findings:** F50.

A log of lost items, next to the room notes.

- **Entry.** "Found in Room 9 · kept at the bar · claimed by …", with a photo where staff take one.
- **Room notes.** Stay as they are. Room 6 keeps "TV remote goes missing. Check under the couch."

*Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10], [Data model][spec-04].*

#### N16. No more alcohol (cut off)

- **Becomes:** Staff app (React + Vite): the bar POS, the Board panel, and the room tab on desktop and phone.
- **Lives in:** [Rail](#rail) (a tab), [Board](#board), [DeskRoom](#deskroom) and [Room](#room) ("No more alcohol for this room"), and one guest in a room.
- **Ships in:** [M3].
- **Findings:** C5, F19, F20.

Cut off a tab, a room or one guest. It records who, why and when, and logs a refusal. A cut-off never stops anyone singing.

- **On every screen.** "Cut off by Andy at 10:30 PM" shows for that tab, room or guest, and alcohol is greyed out.
- **Orders.** Unaccepted alcohol orders are cancelled (`cut_off`).
- **The guest's phone.** Alcohol is hidden, and "Your server has paused alcohol for this room" shows.
- **Move targets.** A cut-off tab or room is greyed out as a target for alcohol, with the reason.
- **Runners.** A runner can't cut off. They return the order with a reason ("Someone looks too drunk"), and the manager on duty sees "Cut off Room 9?".
- **Seed.** Hana K.'s tab was cut off by Andy at 10:30 PM.

*Decided in [FB 4.7]. Spec: [Staff screens and the bar POS][spec-10], [Money rules][spec-05].*

#### N17. Clear-out check

- **Becomes:** Staff app (React + Vite): the Board and Close the night.
- **Lives in:** [Board](#board) and [Night](#night).
- **Ships in:** [M3].
- **Findings:** C4, F30.

At 4:30 AM (close plus the drinking-up time), the Board and Close the night ask for a clear-out check. `POST /nights/{date}/clear-out` records who walked the rooms and the bar, and when.

- **The prompt.** "Walk every room and the bar · no drinks left out", then [Done].
- **Recorded.** "Clear-out check · Andy · 4:31 AM". It is one of the checks before closing.

*Decided in [FB 4.7]. Spec: [API][spec-08], [Data model][spec-04].*

#### N18. Approvals inbox

- **Becomes:** Staff app (React + Vite): the phone of a manager or owner.
- **Lives in:** [Staff](#staff), in a passkey-protected session on the approver's own phone.
- **Ships in:** [M2].
- **Findings:** C12, F8, F11.

"Approvals · N" lists each request with its line, amount, reason, who asked and when, with [Approve] and [Decline]. A request is never decided on the requester's device or by the requester. Events: `approval.requested` and `approval.decided`.

- **Requester.** The line shows "Waiting for Andy", then the decision. Staff keep working. "Charge the remaining tabs" skips a tab waiting on an approval.
- **Routing.** To the manager on duty. Andy's own requests go to Abhishek, and the owner's go to a manager. A paper-slip tip over 25% goes to the manager on duty, or to the owner if that manager entered the slip.
- **Kinds.** Comps and voids over the limit, refunds, room-clock pauses, tips over the review limit, cash paid-outs over the limit, a lower party size after the gratuity, and charging a saved card without the guest's confirmation.
- **Seed.** Diego's void of 1 × Large bucket · 10 beers ($70) on Tariq A.'s tab shows "Approvals · 1" on Andy's phone.

*Decided in [FB 2] and [FB 4.6]. Spec: [Tenancy and access][spec-02], [Staff screens and the bar POS][spec-10], [Payment flows][spec-07].*

#### N19. Calls list

- **Becomes:** Staff app (React + Vite): the Board and every staff phone, with a push.
- **Lives in:** [Board](#board), [Staff](#staff) and [DeskRoom](#deskroom).
- **Ships in:** [M2].
- **Findings:** F26.

Room calls such as "Another mic, please", each with [On it]. The guest reads "Staff get it on their phones".

- **Seed.** Room 9 called for another mic.
- **A fault.** "TV or song isn't working" can be logged as a fault ([N14](#n14-report-a-fault)).

*Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10], [Devices, printing and offline][spec-09].*

#### N20. Help alert, "Manager needed" pin and incident log

- **Becomes:** Guest web (the private link) and the staff app (managers' phones and the Board).
- **Lives in:** The private link on [Order](#order), [Staff](#staff) (managers' phones only) and [Board](#board).
- **Ships in:** [M8].
- **Findings:** C12, F25.

The guest's "Need a manager, privately?" link alerts only the managers' phones. It never shows on a room tablet or any room screen.

- **Managers' phones.** The room and time, with [I'm on it] and notes that go to the incident log (`incident.opened`). The log is kept 3 years and shows on managers' phones only.
- **The Board.** A "Manager needed" pin that shows a count only, with no room and no reason.

*Decided in [FB 4.10]. Spec: [Staff screens and the bar POS][spec-10], [Devices, printing and offline][spec-09], [Security and data retention][spec-12].*

#### N21. Close-out steps and card states

- **Becomes:** Staff app (React + Vite): the room tab on desktop and phone, and the bar POS pay panel.
- **Lives in:** [DeskRoom](#deskroom), [Room](#room) and [Rail](#rail).
- **Ships in:** [M4].
- **Findings:** C12, F13, F14, F15, F16, F47.

Close-out is four steps. Room 9's numbers are in the demo seed and the money cases.

- **1 Present the check.** Finalizes the check (#1042) and locks ordering. Joined phones show "Your bill is ready · ordering is closed". It is refused while an order is ringing or asked to wait, and those are listed first: "2 × Margarita · Peach is ringing at the bar · accept or cancel it first". A manager can Reopen the check, and the next finalize writes a new revision.
- **2 Ways to pay.** Tap at the reader (pick Front desk S710 or Bar S710). Card on file ([N8](#n8-confirm-the-card-on-file)). Cash: the amount handed over (Exact, the next $5, $10 or $20, or Other), the change due in large type, "Wrong amount? Fix the change", and a cash-tip field. Split, even or by item, with each share in its own state. Pay my share lines ([N6](#n6-pay-my-share)). "Pay cash to staff" is always offered.
- **Card states.** Waiting ("Waiting for a tap on the front-desk reader · Cancel"), Paid, Declined ("Declined · try another card or cash"), Unknown ("Checking with Stripe · don't retry"), Reader offline ("Reader offline · use the bar reader"), Reader busy, Waiting for the guest, and on a bar tab "Hold raise declined".
- **3 Additional tip.** An "Additional tip (optional)" line, entered by staff, by cash or card.
- **4 Paid, then the receipt.** Text, Email, Print or No receipt ([N2](#n2-receipts-printed-and-web)). Then "Room 9 goes to cleaning", blocked while any order on the room is ringing, asked to wait or unpaid. An order accepted after the check is paid opens a new check.
- **Cash on a phone.** Cash taken on a staff phone goes into that person's staff bank. They drop it into a drawer (`POST /drawer-sessions/{s}/drop`) before they clock out, and the clock-out checklist asks for it ([N24](#n24-clock-in-duty-and-clock-out-checklist)).

*Decided in [FB 4.5]. Spec: [Payment flows][spec-07], [Money rules][spec-05]. See: [Money cases][see-cases].*

#### N22. Refund from check

- **Becomes:** Staff app (React + Vite): the phone (from a booking), the room tab on desktop (a paid check) and the bar POS (Closed tonight).
- **Lives in:** [Staff](#staff), [DeskRoom](#deskroom), [Room](#room) and [Rail](#rail).
- **Ships in:** [M4].
- **Findings:** C16, F8.

Staff pick a paid check, then the lines, then which payment to refund, then a reason, then [Send to Abhishek] when Andy asks. Only owners and managers ask, and someone else approves on their own phone ([N18](#n18-approvals-inbox)).

- **Progress.** "Waiting for Abhishek", then "Refund pending" until Stripe confirms, then "Refunded". A refund that fails goes back to the manager with Stripe's reason.
- **The cap.** Never more than the payment captured minus earlier refunds. Marcus T. has only his $120 deposit captured tonight, so his cap is $120.
- **Cash.** A cash refund is a drawer move.

*Decided in [FB 4.6]. Spec: [Payment flows][spec-07], [Tenancy and access][spec-02].*

#### N23. New bar tab: consent line and slip

- **Becomes:** Staff app (React + Vite): the bar POS, in the desktop app.
- **Lives in:** [Rail](#rail) (New tab).
- **Ships in:** [M6].
- **Findings:** C14.

The reader can't show our own consent line, so New tab shows it for the bartender to read out before the guest taps.

- **The line.** "We'll hold $50 on this card and add to it as you order. We charge your tab when you close out, or at 4:30 AM if it's still open. Add your tip on the reader." It is built from the tab settings in Admin → Bar POS ([N33](#n33-admin--bar-pos)).
- **Read to guest ✓.** Records who read it (`tabs.consent_read_by`) and the wording's version (`tabs.consent_text_version`).
- **Tab slip.** The printed slip repeats the same line.

*Decided in [FB 4.8]. Spec: [Payment flows][spec-07], [Staff screens and the bar POS][spec-10].*

#### N24. Clock-in duty and clock-out checklist

- **Becomes:** Staff app (React + Vite): sign-in and the time clock.
- **Lives in:** [Pin](#pin) and [Staff](#staff).
- **Ships in:** [M7].
- **Findings:** F29.

Clock-in asks for the duty (Bar, Front desk, Runner or Manager), and the tip pool uses it (`shifts.duty`). The bar POS shows "Maya · on break" during a break.

- **Clock-out checklist.** Each line links to its fix. Hand over open tabs (Maya has 3) and unsent drinks to someone still on. Make a cash drop, or count your own drawer (a drawer per person only). Declare cash tips. Clock-out finishes once the list is clear.

*Decided in [FB 4.13]. Spec: [Staff screens and the bar POS][spec-10].*

#### N25. Set your PIN

- **Becomes:** Staff app (React + Vite): the person's own phone, from an invite link.
- **Lives in:** Before [Pin](#pin); invites are sent from Admin → Team ([AdminDesk](#admindesk)).
- **Ships in:** [M1].
- **Findings:** C7.

Each person chooses their own PIN from the invite link on their own phone: 4 digits for staff and 6 for owners and managers. Common PINs such as 1234, 1111 and 2580 are refused. A reset sends a new link. Nobody sets or sees another person's PIN, and a PIN is never texted, emailed or shown.

- **Invite.** A link, then a phone number confirmed once with a code.
- **Choose.** A PIN, and the language ("English · Español").
- **Badge.** Pair the badge in Admin → Team by tapping it on the reader.
- **Before go-live.** M9 checks that nobody is waiting: everyone has set a new PIN and paired a badge. No PINs are imported.

*Spec: [Tenancy and access][spec-02].*

#### N26. Tips to enter

- **Becomes:** Staff app (React + Vite): the phone's Tips tab.
- **Lives in:** [Staff](#staff).
- **Ships in:** [M6].
- **Findings:** F30, F53.

The queue of paper tip slips for bar tabs printed as `awaiting_tip`. Each row keeps a photo of the signed slip. A tip over 25% or $50, or one entered more than 2 hours late, needs approval ([N18](#n18-approvals-inbox)).

- **Seed.** Dev S. (Visa ··3318), Tom W. (Mastercard ··0457) and Ana R. (Amex ··2204). Jess P.'s card, Visa ··4417, never shows here.
- **Close the night.** Shows "3 slips not entered · tips post to Sat Sep 26". Awaiting-tip tabs don't block the close.

*Decided in [FB 3f]. Spec: [Payment flows][spec-07], [Staff screens and the bar POS][spec-10].*

#### N27. KJ song-queue screen

- **Becomes:** Staff app (React + Vite) in the desktop app. A planned board, `KJ.dc.html`, was never drawn.
- **Lives in:** Opened from "Song queue · 6" on [Rail](#rail), from [Bar](#bar) and from the side menu.
- **Ships in:** [M6].
- **Findings:** C10, F6, K6.

Shows who is singing now, who is up next in order, the round, each singer's credits and flags, [Started], [Skip], move up or down with a reason, and [+ Singer] for someone at the bar. It follows `song_queue.updated`.

- **Started.** Posts the song line to the singer's tab ($0.00 when it uses a credit), or uses the credit of a singer with no tab, and writes the play log.
- **Skip.** Free. A prepaid credit comes back.
- **Override.** Moving a song needs a reason and is logged.
- **Flags.** "Needs a drink credit" when a singer has none and no song price is set.
- **Seed.** Round 3, 23 songs sung. Now singing: Luis M., "Mr. Brightside" (started 10:39 PM by Maya on a credit). Up next: Jess P., Kira, Ben T., Tariq A., Hana K., Sofia R.

*Decided in [FB 4.11] and [FB 5]. Spec: [Song systems and texts][spec-11], [Staff screens and the bar POS][spec-10].*

#### N28. Up next TV

- **Becomes:** A display device (`up_next_display`) at the bar, paired like a shared device. A planned board, `UpNext.dc.html`, was never drawn.
- **Lives in:** Linked from [N27](#n27-kj-song-queue-screen).
- **Ships in:** [M6].
- **Findings:** C10, F6, K6.

Shows who is singing now, the next 5 singers and a QR code to join ([N9](#n9-the-singers-queue-page)). It follows `song_queue.updated` and never shows a phone number.

*Decided in [FB 4.11] and [FB 5]. Spec: [Song systems and texts][spec-11], [Devices, printing and offline][spec-09].*

#### N29. Outage banners and queue mode

- **Becomes:** Staff app (React + Vite) in the desktop app: the Board, the bar POS and the bar orders screen; vendor banners also on staff phones.
- **Lives in:** [Board](#board), [Rail](#rail), [Bar](#bar), [Staff](#staff) and [Night](#night) (the review list), each with a "Demo:" control on the prototypes.
- **Ships in:** [M8].
- **Findings:** C11, C12, F12.

The Board's footer always shows the connection and the last sync ("Online · synced 4 s ago") and never says "works offline".

- **On backup internet.** Amber: "On backup internet · card readers may take up to 2 min to switch". Everything works, though a card payment may show "Checking with Stripe · don't retry" or "Reader offline".
- **Offline.** Pink: "Offline · read-only · orders queue with an offline code". Staff see the board, open tabs and the menu, and keep working orders already ringing.
- **Queue mode.** A manager reads an offline code (time-based from a per-device secret, or a printed one-time code). It opens queue mode until the connection returns or 4 hours pass. Each round shows "queued · not charged" with a staff name. Voids, refunds and the drawer stay locked.
- **Back online.** "Confirm replayed orders (3)". Each replayed order lands as asked to wait until a bartender accepts it.
- **Stripe or Twilio.** "Stripe is having trouble · card payments may fail" and "Texts are delayed".
- **Review after outage.** A list on Close the night for a manager: every order taken offline and its payment, failed replay checks first, and any break-glass card payments waiting in Unmatched payments ([N37](#n37-admin--payments-disputes-and-unmatched-payments)).
- **Break-glass card.** A one-page card to print and keep at each desk: take cards with Tap to Pay in Stripe's Dashboard app on the manager's phone, and match them afterwards. If Stripe is down, take cash.

*Decided in [FB 4.9]. Spec: [Devices, printing and offline][spec-09], [Stripe setup][spec-06].*

#### N30. Training band

- **Becomes:** Staff app (React + Vite): the bar POS, the Board and the room tab, and every other staff screen in training.
- **Lives in:** [Rail](#rail), [Board](#board), [Room](#room) and [DeskRoom](#deskroom), with a "Demo: training mode" toggle on the prototypes.
- **Ships in:** [M7].
- **Findings:** C37, F39.

Admin → Team → Training mode turns training on for a person, or for a device during a new hire's first shifts. A permanent band, "TRAINING · not real money", can't be closed.

- **Check numbers.** Practice checks are numbered T-0012 and so on, from their own counter.
- **Payments.** Card steps run on a simulated reader in Stripe's sandbox, and the drawer never opens.
- **Printouts.** Tickets and receipts say TRAINING.
- **Totals.** Practice checks stay out of the Z report, tax, exports, tip pools and the reason-only shift totals.

*Decided in [FB 4.14]. Spec: [Security and data retention][spec-12], [Staff screens and the bar POS][spec-10].*

#### N31. Occupancy warning and door counter

- **Becomes:** Staff app (React + Vite): the Board.
- **Lives in:** [Board](#board).
- **Ships in:** [M2].
- **Findings:** F51.

The headcount comes from check-ins, walk-ins and a door counter at the front desk, against `safety.occupancyLimit`.

- **No limit.** West 4 hasn't entered one: "Limit not set · Admin → Safety". Never a made-up number. The seed reads "98 inside" (77 in rooms, 5 on bar tabs, 16 waiting).
- **With a limit.** The Board warns when everyone inside reaches 90% of it (`safety.warnAtPct`).
- **Door counter.** A + and − at the front desk.

*Decided in [FB 4.10] and [FB 3a]. Spec: [Devices, printing and offline][spec-09], [Settings, rule packs and modules][spec-03].*

#### N32. No bar device connected

- **Becomes:** Staff app (React + Vite): every bar-role phone, and the Board.
- **Lives in:** [Board](#board) and [Bar](#bar).
- **Ships in:** [M3].
- **Findings:** F53.

The server tracks which bar devices are connected. If none is connected during opening hours, every bar-role phone buzzes at once. The Board alert beside it is the flows review's ask and isn't decided in the fix brief.

*Spec: [Devices, printing and offline][spec-09].*

### Admin, reports and Console

Admin sections and reports the canvas has no board for.

#### N33. Admin → Bar POS

- **Becomes:** Staff app and Admin (React + Vite), passkey session.
- **Lives in:** [AdminDesk](#admindesk), a new section.
- **Ships in:** [M6].
- **Findings:** C17, C24.

One settings screen edits the `pos` and `tabs` keys. Whether the front desk may use the bar POS when covering the bar is a permission in Admin → Team, not here.

- **Layout.** A 25-slot grid for each of the ten sections, per station, showing each item's button name. Publish saves a new `pos_layouts` version that starts at the next business date ("Starts Sat Sep 26").
- **Limits.** The reason-only limit for comps and voids: $25 each and $75 a shift per person. 0 sends every one for approval.
- **Locks.** Idle lock 3 min and Wipe screen 10 s.
- **Tip path.** Bar tabs tip on the reader (West 4) or on a paper slip. The slip stays as the fallback either way.
- **Drink tickets.** "Print tickets for drinks rung at the bar", off for West 4: whether Send prints a bar ticket for a bar tab's or a quick sale's drinks. Room orders, from guests or from staff, always print (D99).
- **Order aging.** Bar phones 30 s, amber and the Board alert 2 min, pink and the manager on duty 4 min, a text or call 6 min. The chime is on, and Mute lasts 1 min.
- **Tabs.** The $50 opening hold, the $600 flag, and the 4:30 AM cut-off. The consent line ([N23](#n23-new-bar-tab-consent-line-and-slip)) is built from them and saved as a `policy_versions` row.

*Decided in [FB 4.17]. Spec: [Staff screens and the bar POS][spec-10], [Settings, rule packs and modules][spec-03], [Data model][spec-04].*

#### N34. Admin → Bar mode

- **Becomes:** Staff app and Admin (React + Vite), passkey session.
- **Lives in:** [AdminDesk](#admindesk), a new section.
- **Ships in:** [M6].
- **Findings:** C10, K6.

The `barMode` settings, plus the songbook upload.

- **Song price.** "Song price · not set · songs need a drink credit" at West 4.
- **Drink credits.** "Buy a drink, get a song": each drink bought earns one credit. On at West 4.
- **Songs per round.** 1 at West 4.
- **Free nights.** Days with no song price.
- **Singer alerts.** A push at 2 singers before you, and the "You're up next" text.
- **Songbook upload.** A CSV with title, artist and code, loaded into `song_catalog`. West 4's Playbox catalog comes only from Playbox or West 4.

*Decided in [FB 4.11]. Spec: [Song systems and texts][spec-11], [Settings, rule packs and modules][spec-03].*

#### N35. Admin → Licenses

- **Becomes:** Staff app and Admin (React + Vite), passkey session.
- **Lives in:** [AdminDesk](#admindesk), a new section.
- **Ships in:** [M8].
- **Findings:** C6.

The license register: ASCAP, BMI, SESAC and GMR, and local licenses. Each has a number, holder, expiry, fee, conditions and a copy of the file. A renewal reminder job texts or emails before an expiry.

*Spec: [Data model][spec-04], [API][spec-08].*

#### N36. Admin → Safety

- **Becomes:** Staff app and Admin (React + Vite), passkey session.
- **Lives in:** [AdminDesk](#admindesk), a new section.
- **Ships in:** [M2].
- **Findings:** F25, F51.

The occupancy limit (`safety.occupancyLimit`, empty at West 4) and when the Board warns (`warnAtPct`, 90). In M8 it adds the help alert and the incident log settings ([N20](#n20-help-alert-manager-needed-pin-and-incident-log)).

*Decided in [FB 4.10]. Spec: [Settings, rule packs and modules][spec-03].*

#### N37. Admin → Payments, disputes and Unmatched payments

- **Becomes:** Staff app and Admin (React + Vite), passkey session; the owner sees Payments.
- **Lives in:** [AdminDesk](#admindesk), new sections; Unmatched payments opens from Close the night ([Night](#night)).
- **Ships in:** [M4].
- **Findings:** C37, F53.

Payments (owner only) is the Stripe account and payouts, and our plan from M8. The dispute inbox comes in M4. Payout matching and Unmatched payments come in M7.

- **Disputes.** `charge.dispute.created` opens an item with the evidence already gathered: the itemized receipt PDF, the room clock times, the booking and the policy version the guest accepted, damage photos, and who served. The manager submits before Stripe's due date.
- **Payouts.** Each payout is matched to our payments. Anything still unmatched goes to Unmatched payments.
- **Unmatched payments.** A list a manager works through from Close the night. Each payment shows its amount, card and time, and the manager picks the check it belongs to. Break-glass card payments land here.

*Spec: [Stripe setup][spec-06], [API][spec-08].*

#### N38. Reports and exports

- **Becomes:** Staff app (React + Vite): the phone and desktop Reports, owners and managers only.
- **Lives in:** [Reports](#reports) and [DeskReports](#deskreports).
- **Ships in:** [M7].
- **Findings:** C37, F53.

The canvas shows the week and eight-week trends only. Exports ask for the passkey again.

- **Tax quarter.** `GET /reports/tax-quarter`.
- **Payroll.** `GET /exports/payroll?from=&to=`. It splits gratuity (wages) from tips.
- **Accounting.** `GET /exports/accounting?date=`: one balanced journal per night and one per payout, as a file for QuickBooks.
- **Exceptions.** Every comp, void and refund, approved or not.
- **Sales, occupancy, bookings, staff actions.** The other report routes. Payouts is owner only.

*Spec: [API][spec-08], [Money rules][spec-05].*

#### N39. Admin → Console

- **Becomes:** Staff app and Admin (React + Vite), passkey session, owners only.
- **Lives in:** [AdminDesk](#admindesk), a new section; managers don't see it.
- **Ships in:** [M8].
- **Findings:** C8.

Where the owner approves support access from our staff.

- **Request.** Shows the reason, the scope (read, or write for one named action) and the length, up to 60 minutes. The owner approves or declines, and can end it at any time.
- **While open.** A banner shows in Admin. The session is read-only on masked views (no ID scans, no guest phone numbers). An approved write allows only its one named action, once.
- **Emergency actions.** Re-sync a payment, cancel a reader action, requeue a print, or close a stuck night. Each needs a second approver on our side and tells the owner at once.
- **Audit.** Every row records both identities.

*Spec: [Tenancy and access][spec-02], [API][spec-08].*

#### N40. Admin → Kitchen

- **Becomes:** Staff app and Admin (React + Vite), passkey session, managers and the owner.
- **Lives in:** [AdminDesk](#admindesk), a new section after Bar mode, listed only where the Console allows Kitchen & food (on or off, because the notice has to be set before the switch turns on).
- **Ships in:** [K-01](backlog/K-kitchen.md).

The `kitchen` settings key, through Save and publish: the allergy notice in English and Spanish ("Allergy notice · not set · Admin → Kitchen" while it's empty; both languages or neither), the last order time (empty: food follows room ordering) and the Not sent reminder in minutes (5 by default, 1 to 60). Admin → Features keeps Kitchen & food off and reads "Kitchen · needs a kitchen printer and the allergy notice", naming only what's missing, until both are there.

*Spec: [Kitchen and food](spec/16-kitchen.md) · The Kitchen module.*

## Finding map

Every finding that touches a screen, and where it landed. A screen name links to that screen's build notes, and an N number links to its entry under [Not on the canvas](#not-on-the-canvas--build-from-the-spec).

### Flows review, F1 to F55

| Finding | What | Lands on |
| --- | --- | --- |
| F1 | Order pipeline: one set of words, hand-off to a runner | [Order](#order), [Staff](#staff), [Bar](#bar), [Rail](#rail), [DeskRoom](#deskroom) |
| F2 | Ask the room to wait (was "Hold") must still need Accept | [Order](#order), [Bar](#bar), [Rail](#rail) |
| F3 | Check-in: party size, IDs, room, clock, deposit, room code | [Staff](#staff), [Board](#board), [N10](#n10-check-in-sheet) |
| F4 | Waitlist: offer a room, hold it, seat the party | [Waitlist](#waitlist), [Staff](#staff), [Board](#board), [N11](#n11-waitlist-drawer) |
| F5 | Booking steps after the deposit button | [Book](#book), [Manage](#manage), [N1](#n1-booking-steps-after-the-price) |
| F6 | Bar mode screens | [Main](#main), [Waitlist](#waitlist), [Rail](#rail), [Setup](#setup), [N9](#n9-the-singers-queue-page), [N27](#n27-kj-song-queue-screen), [N28](#n28-up-next-tv) |
| F7 | Phone "Close out" marks a room paid with no payment | [Staff](#staff) |
| F8 | Refund from a paid check, with approval | [Staff](#staff), [Rail](#rail), [DeskRoom](#deskroom), [N18](#n18-approvals-inbox), [N22](#n22-refund-from-check) |
| F9 | A paid split share is forgotten on the Rail | [Rail](#rail) |
| F10 | A reopened tab still offers "Close to card" | [Rail](#rail) |
| F11 | Comp and void limit, and the approvals inbox | [Staff](#staff), [Room](#room), [Rail](#rail), [DeskRoom](#deskroom), [N18](#n18-approvals-inbox) |
| F12 | Outage states | [Staff](#staff), [Board](#board), [Night](#night), [Bar](#bar), [Rail](#rail), [N29](#n29-outage-banners-and-queue-mode) |
| F13 | Present the check before close-out | [Order](#order), [Room](#room), [DeskRoom](#deskroom), [N5](#n5-your-bill), [N21](#n21-close-out-steps-and-card-states) |
| F14 | Card payment states | [Room](#room), [Rail](#rail), [DeskRoom](#deskroom), [N8](#n8-confirm-the-card-on-file), [N21](#n21-close-out-steps-and-card-states) |
| F15 | Card on file: the guest's bill and confirmation | [Order](#order), [Room](#room), [DeskRoom](#deskroom), [N5](#n5-your-bill), [N8](#n8-confirm-the-card-on-file), [N21](#n21-close-out-steps-and-card-states) |
| F16 | Cash on room close-out: change and cash tip | [Room](#room), [DeskRoom](#deskroom), [N21](#n21-close-out-steps-and-card-states) |
| F17 | Bar reader and bar drawer | [Board](#board), [AdminDesk](#admindesk), [Night](#night), [Rail](#rail), [Setup](#setup) |
| F18 | Move a bar tab into a room | [Rail](#rail) |
| F19 | Moves onto cut-off tabs and the hold raise | [Rail](#rail), [N16](#n16-no-more-alcohol-cut-off) |
| F20 | Cut off, and the 4 AM stop | [Order](#order), [Staff](#staff), [Room](#room), [Board](#board), [Bar](#bar), [Rail](#rail), [DeskRoom](#deskroom), [N16](#n16-no-more-alcohol-cut-off) |
| F21 | Quick-add chips bypass the bar | [Room](#room), [DeskRoom](#deskroom) |
| F22 | Move a room that is running long | [Order](#order), [Staff](#staff), [Room](#room), [Board](#board), [DeskRoom](#deskroom), [N12](#n12-move-sheet) |
| F23 | Party size control | [Staff](#staff), [Room](#room), [Board](#board), [DeskRoom](#deskroom), [N13](#n13-party-size-control) |
| F24 | Faults, clock pause, comp time, damage-fee photo | [Order](#order), [Room](#room), [Board](#board), [DeskRoom](#deskroom), [N14](#n14-report-a-fault) |
| F25 | Private help alert and incident log | [Order](#order), [Staff](#staff), [Board](#board), [N20](#n20-help-alert-manager-needed-pin-and-incident-log), [N36](#n36-admin--safety) |
| F26 | Room calls reach staff phones | [Order](#order), [Staff](#staff), [Board](#board), [DeskRoom](#deskroom), [N19](#n19-calls-list) |
| F27 | Join a room | [Order](#order), [N3](#n3-join-a-room), [N4](#n4-room-tablet-kiosk) |
| F28 | Diego's role | [Pin](#pin), [AdminDesk](#admindesk), [Night](#night), [Rail](#rail), [Setup](#setup) |
| F29 | Clock-in duty and clock-out checklist | [Pin](#pin), [N24](#n24-clock-in-duty-and-clock-out-checklist) |
| F30 | Close the night: missing checks and slip tips | [Staff](#staff), [Night](#night), [N17](#n17-clear-out-check), [N26](#n26-tips-to-enter) |
| F31 | Z report gratuity from room checks only | [Night](#night) |
| F32 | A party of 3 on Friday and Saturday | [Book](#book), [Manage](#manage), [Waitlist](#waitlist), [N1](#n1-booking-steps-after-the-price) |
| F33 | One seed for tonight on every screen | [Manage](#manage), [Waitlist](#waitlist), [Staff](#staff), [Calendar](#calendar), [Messages](#messages), [Board](#board), [AdminDesk](#admindesk), [Night](#night), [Bar](#bar), [Rail](#rail), [DeskCalendar](#deskcalendar), [DeskMessages](#deskmessages) |
| F34 | Big-party link double-books the VIP room | [Calendar](#calendar), [DeskCalendar](#deskcalendar) |
| F35 | Bar orders screen is a dead end | [Bar](#bar) |
| F36 | Escalation copy, Board alert, badge count, print failures | [Board](#board), [AdminDesk](#admindesk), [Bar](#bar), [Rail](#rail) |
| F37 | Module effects and dependencies | [Main](#main), [Book](#book), [Staff](#staff), [Board](#board), [AdminDesk](#admindesk), [Bar](#bar), [Setup](#setup), [SiteBuilder](#sitebuilder), [Console](#console) |
| F38 | Setup hardware, and Setup, Console and Admin agreeing | [AdminDesk](#admindesk), [Setup](#setup), [Console](#console) |
| F39 | Training mode | [Room](#room), [Board](#board), [AdminDesk](#admindesk), [Night](#night), [Rail](#rail), [DeskRoom](#deskroom), [N30](#n30-training-band) |
| F40 | Demo "now" on every screen | [Main](#main), [Book](#book), [Manage](#manage), [Pin](#pin), [Reports](#reports), [Night](#night), [Rail](#rail), [DeskCalendar](#deskcalendar) |
| F41 | Words that mean two things | [Order](#order), [Staff](#staff), [Room](#room), [Messages](#messages), [AdminDesk](#admindesk), [Night](#night), [Bar](#bar), [Rail](#rail), [DeskRoom](#deskroom), [DeskMessages](#deskmessages) |
| F42 | Small errors on Close the night | [Night](#night) |
| F43 | Waitlist page details | [Waitlist](#waitlist), [N11](#n11-waitlist-drawer) |
| F44 | Room 5 IDs and walk-in names | [Bar](#bar), [Rail](#rail), [N10](#n10-check-in-sheet) |
| F45 | Amounts and price wording | [Main](#main), [Rooms](#rooms), [Menu](#menu), [Board](#board), [Rail](#rail) |
| F46 | Sign-in inconsistencies | [Pin](#pin), [Admin](#admin), [DeskReports](#deskreports) |
| F47 | Receipt choices and the additional tip | [Room](#room), [DeskRoom](#deskroom), [N2](#n2-receipts-printed-and-web), [N21](#n21-close-out-steps-and-card-states) |
| F48 | Wrong actions on the phone's Details sheet | [Staff](#staff) |
| F49 | Cleaning details on the Board | [Board](#board) |
| F50 | Lost-item log | [Board](#board), [N15](#n15-lost-and-found) |
| F51 | Occupancy warning and door counter | [Board](#board), [AdminDesk](#admindesk), [N31](#n31-occupancy-warning-and-door-counter), [N36](#n36-admin--safety) |
| F52 | Booking changes: date, and a venue cancel | [Manage](#manage), [Calendar](#calendar), [DeskCalendar](#deskcalendar) |
| F53 | Spec flows with no screen | [Staff](#staff), [Reports](#reports), [Board](#board), [AdminDesk](#admindesk), [Night](#night), [Bar](#bar), [DeskReports](#deskreports), [N26](#n26-tips-to-enter), [N32](#n32-no-bar-device-connected), [N37](#n37-admin--payments-disputes-and-unmatched-payments), [N38](#n38-reports-and-exports) |
| F54 | Bar POS side menu and 86 | [Rail](#rail) |
| F55 | Messages and reports copy | [Messages](#messages), [Reports](#reports), [DeskMessages](#deskmessages), [DeskReports](#deskreports) |

### Completeness review, findings that touch a screen

| Finding | What | Lands on |
| --- | --- | --- |
| C2 | Front desk role and permissions | [Pin](#pin), [Staff](#staff), [AdminDesk](#admindesk), [Night](#night), [Rail](#rail), [Setup](#setup) |
| C4 | Clear-out check, and unaccepted orders after 4 AM | [Board](#board), [Night](#night), [Bar](#bar), [Rail](#rail), [N17](#n17-clear-out-check) |
| C5 | Cut off a room or one guest | [Order](#order), [Room](#room), [Board](#board), [DeskRoom](#deskroom), [N16](#n16-no-more-alcohol-cut-off) |
| C6 | License register | [AdminDesk](#admindesk), [Setup](#setup), [N35](#n35-admin--licenses) |
| C7 | PINs are chosen by each person, not imported | [Pin](#pin), [AdminDesk](#admindesk), [N25](#n25-set-your-pin) |
| C8 | A minimal Console in phase 1 | [AdminDesk](#admindesk), [Setup](#setup), [Console](#console), [N39](#n39-admin--console) |
| C9 | Staff languages | [Pin](#pin), [AdminDesk](#admindesk) |
| C10 | Bar mode screens | [Main](#main), [AdminDesk](#admindesk), [Rail](#rail), [Setup](#setup), [N9](#n9-the-singers-queue-page), [N27](#n27-kj-song-queue-screen), [N28](#n28-up-next-tv), [N34](#n34-admin--bar-mode) |
| C11 | Offline and backup-internet states | [Board](#board), [Night](#night), [Bar](#bar), [Rail](#rail), [N29](#n29-outage-banners-and-queue-mode) |
| C12 | Exception states and the approver's phone | [Staff](#staff), [Room](#room), [Rail](#rail), [DeskRoom](#deskroom), [N18](#n18-approvals-inbox), [N20](#n20-help-alert-manager-needed-pin-and-incident-log), [N21](#n21-close-out-steps-and-card-states), [N29](#n29-outage-banners-and-queue-mode) |
| C13 | Booking details, payment, confirmation and saved-card wording | [Book](#book), [Manage](#manage), [AdminDesk](#admindesk), [N1](#n1-booking-steps-after-the-price) |
| C14 | Bar tab consent line and slip | [Rail](#rail), [N23](#n23-new-bar-tab-consent-line-and-slip) |
| C15 | Room desktop comps and voids | [Room](#room), [Rail](#rail), [DeskRoom](#deskroom) |
| C16 | Phone refunds | [Staff](#staff), [Rail](#rail), [DeskRoom](#deskroom), [N22](#n22-refund-from-check) |
| C17 | Admin: Bar POS, tab settings, alarm toggle, menu editor | [AdminDesk](#admindesk), [N33](#n33-admin--bar-pos) |
| C18 | Badges and NFC readers in Admin and Setup | [AdminDesk](#admindesk), [Setup](#setup) |
| C19 | Where bar cash goes | [Board](#board), [AdminDesk](#admindesk), [Night](#night), [Rail](#rail), [Setup](#setup) |
| C22 | Receipts | [Room](#room), [Messages](#messages), [AdminDesk](#admindesk), [DeskRoom](#deskroom), [DeskMessages](#deskmessages), [N2](#n2-receipts-printed-and-web) |
| C24 | Escalation and module wording | [AdminDesk](#admindesk), [Bar](#bar), [Rail](#rail), [Setup](#setup), [Console](#console), [N33](#n33-admin--bar-pos) |
| C25 | Badge-era wording, and Pin against Admin | [Pin](#pin), [Setup](#setup) |
| C28 | Demo data disagrees between screens | [Staff](#staff), [Calendar](#calendar), [Messages](#messages), [Board](#board), [AdminDesk](#admindesk), [Night](#night), [Rail](#rail), [DeskCalendar](#deskcalendar), [DeskMessages](#deskmessages), [Console](#console) |
| C29 | Z report gratuity includes bar sales | [Night](#night) |
| C30 | Split rounding on the Rail | [Rail](#rail) |
| C31 | Happy hour banner and free-text line | [Menu](#menu), [AdminDesk](#admindesk) |
| C32 | Price wording and "stay as long as you like" | [Main](#main), [Rooms](#rooms), [Menu](#menu), [Order](#order), [Room](#room), [Messages](#messages), [AdminDesk](#admindesk), [DeskRoom](#deskroom), [DeskMessages](#deskmessages) |
| C34 | Text lists and the missing "You're up next" | [Messages](#messages), [AdminDesk](#admindesk), [Bar](#bar), [DeskMessages](#deskmessages) |
| C36 | Connections nobody specified | [AdminDesk](#admindesk) |
| C37 | Other missing screens and small gaps | [Parties](#parties), [Order](#order), [Calendar](#calendar), [Reports](#reports), [Admin](#admin), [AdminDesk](#admindesk), [DeskCalendar](#deskcalendar), [DeskReports](#deskreports), [N2](#n2-receipts-printed-and-web), [N3](#n3-join-a-room), [N4](#n4-room-tablet-kiosk), [N30](#n30-training-band), [N37](#n37-admin--payments-disputes-and-unmatched-payments), [N38](#n38-reports-and-exports) |

### Competitive review, findings built in phase 1

| Finding | What | Lands on |
| --- | --- | --- |
| K1 | Mic power outlet trial | [AdminDesk](#admindesk) |
| K2 | Pay my share | [Order](#order), [Room](#room), [AdminDesk](#admindesk), [DeskRoom](#deskroom), [N6](#n6-pay-my-share) |
| K4 | Minimum spend (off at West 4) | [Order](#order), [Board](#board), [AdminDesk](#admindesk) |
| K6 | Singer alerts and the KJ songbook upload | [AdminDesk](#admindesk), [Rail](#rail), [N9](#n9-the-singers-queue-page), [N27](#n27-kj-song-queue-screen), [N28](#n28-up-next-tv), [N34](#n34-admin--bar-mode) |
| K13 | Time bands and billing increments | [AdminDesk](#admindesk) |
| K16 | Same again | [Order](#order), [N7](#n7-same-again) |

### Findings that don't land on a screen

These are spec, blueprint or planning items, or later-phase gaps, so no board is involved.

| Finding | What | Where it went |
| --- | --- | --- |
| C1 | Phase 1 deliverables with no milestone | Every phase 1 deliverable now has a milestone and a done-when: [Milestones](milestones.md) (D81 in [decisions](decisions.md)). |
| C3 | Blueprint must-fix codes | The codes are GA-M1 to GA-M11, mapped to spec sections and milestones in [Milestones](milestones.md#must-fix-items-and-where-they-close) (D80). |
| C20 | Settings types and duplicate stores | Each fact lives in one place: [Settings, rule packs and modules](spec/03-settings-rule-packs-modules.md). |
| C21 | Missing routes and events | Added to the [API](spec/08-api.md). |
| C23 | Module status words | Statuses are now Not started, Specified no screen, In progress and Prototyped (canvas): [Blueprint](blueprint.md#every-module) (D79). |
| C26 | Stale blueprint passages | Fixed in the [blueprint](blueprint.md). |
| C27 | Open-question lists | One list: [Open technical questions](spec/14-open-questions.md). |
| C33 | Spec details: tab states, tax categories, ID checks | Settled in the [Data model](spec/04-data-model.md) and [Money rules](spec/05-money-rules.md). |
| C35 | Blueprint module contents with no spec | Marked phase 2 or added to the spec: [Milestones, not in phase 1](milestones.md#not-in-phase-1). |
| K3 | Packages and add-ons sold in the booking | Phase 2. Packages are ordered from the room in phase 1. |
| K5 | Gift cards, stored value and prepaid hours | The prepaid-value ledger is in the data model from M4, with no screen. Gift cards are phase 2 and stored value phase 3. |
| K7 | Inventory counts and automatic 86 | Phase 2. |
| K8 | Noraebang readiness | Phase 3, before the pilots. |
| K9 | Flushing KTV readiness | Two data-model items are in phase 1 with no screens (booked-by, and merging two sessions onto one check). The rest is phase 3. |
| K10 | Card payments when the venue is offline | The native-app decision is phase 2. |
| K11 | Guest CRM, loyalty and marketing automation | Guest profiles are phase 2. Loyalty and campaigns are phase 3. |
| K12 | Booking conversion | Phase 2. |
| K14 | Kitchen display parity | Phase 2, with the kitchen module. |
| K15 | One handheld for the order and the card | Phase 2, with the native app. |
| K17 | Guests extend or move themselves | Phase 2. |
| K18 | Events and ticketing | Phase 3. |
| K19 | Online ordering, takeout and delivery | Later, for kitchen venues. |
| K20 | Scheduling | Later. The time-clock export is enough. |
| K21 | Automatic answers to inquiries | Later. |

Counts: 55 flows findings, 28 completeness findings and 6 competitive findings land on a screen, 9 completeness findings and 15 competitive findings don't, and 27 screens carry 226 build notes, with 39 more screens and states built from the spec alone.

<!-- link definitions -->

[FB 1]: archive/fix-brief-sep28.md#1-demo-time
[FB 2]: archive/fix-brief-sep28.md#2-the-team-tonight-and-the-roles
[FB 3a]: archive/fix-brief-sep28.md#3a-rooms-at-1041-pm
[FB 3b]: archive/fix-brief-sep28.md#3b-bookings-tonight-deskcalendar-the-phones-calendar-and-staff--tonight-all-list-exactly-these
[FB 3c]: archive/fix-brief-sep28.md#3c-waitlist-at-1041
[FB 3d]: archive/fix-brief-sep28.md#3d-board-alerts-at-1041-most-urgent-first
[FB 3e]: archive/fix-brief-sep28.md#3e-room-orders-bar-rail-staff-runs-board-and-order-all-show-these
[FB 3f]: archive/fix-brief-sep28.md#3f-bar-tabs-rail-and-nights-per-person-demo
[FB 3g]: archive/fix-brief-sep28.md#3g-cash-drawers-and-devices-at-west-4
[FB 3i]: archive/fix-brief-sep28.md#3i-automatic-texts-admin--texts-deskmessages-and-phone-messages-all-list-exactly-these-14
[FB 4.1]: archive/fix-brief-sep28.md#41-room-order-pipeline-f1-f2-one-set-of-words-on-every-screen
[FB 4.2]: archive/fix-brief-sep28.md#42-check-in-f3-on-the-board-and-the-phone
[FB 4.3]: archive/fix-brief-sep28.md#43-waitlist-f4
[FB 4.4]: archive/fix-brief-sep28.md#44-room-move-f22-and-party-size-f23
[FB 4.5]: archive/fix-brief-sep28.md#45-room-close-out-f13f16-f47-k2-on-deskroom-and-the-room-phone
[FB 4.6]: archive/fix-brief-sep28.md#46-comps-voids-refunds-f8-f11-c15-c16
[FB 4.7]: archive/fix-brief-sep28.md#47-cut-off-and-the-4-am-stop-f19-f20-c4-c5
[FB 4.8]: archive/fix-brief-sep28.md#48-bar-tabs-f9-f10-f18-f19-c14-c30
[FB 4.9]: archive/fix-brief-sep28.md#49-offline-and-vendor-outages-f12-c11
[FB 4.10]: archive/fix-brief-sep28.md#410-faults-damage-lost-items-help-alert-calls-f24f26-f50-f51
[FB 4.11]: archive/fix-brief-sep28.md#411-bar-mode-f6-c10-k6
[FB 4.12]: archive/fix-brief-sep28.md#412-guest-extras-in-phase-1-k2-k16-k4
[FB 4.13]: archive/fix-brief-sep28.md#413-clock-in-and-clock-out-f29
[FB 4.14]: archive/fix-brief-sep28.md#414-training-mode-f39
[FB 4.15]: archive/fix-brief-sep28.md#415-languages-c9
[FB 4.16]: archive/fix-brief-sep28.md#416-modules-f37
[FB 4.17]: archive/fix-brief-sep28.md#417-vocabulary-f41-c24-c25
[FB 4.18]: archive/fix-brief-sep28.md#418-close-the-night-f30-f31-f42-in-nightdchtml
[FB 5]: archive/fix-brief-sep28.md#5-new-boards-file-names-fixed-now-so-everyone-can-link-to-them
[FB 6]: archive/fix-brief-sep28.md#6-rules-for-every-worker
[M1]: milestones.md#m1--foundations
[M2]: milestones.md#m2--rooms-and-the-board
[M3]: milestones.md#m3--room-orders-and-the-bar-screen
[M4]: milestones.md#m4--payments-and-receipts
[M5]: milestones.md#m5--guest-site-and-online-booking
[M6]: milestones.md#m6--bar-pos-tabs-and-bar-mode
[M7]: milestones.md#m7--close-the-night-and-the-books
[M8]: milestones.md#m8--offline-safety-and-operations
[see-cases]: ../seed/money-cases.json
[see-milestones]: milestones.md
[see-seed]: demo-seed.md
[spec-01]: spec/01-scope-architecture.md
[spec-02]: spec/02-tenancy-access.md
[spec-03]: spec/03-settings-rule-packs-modules.md
[spec-04]: spec/04-data-model.md
[spec-05]: spec/05-money-rules.md
[spec-06]: spec/06-stripe-setup.md
[spec-07]: spec/07-payment-flows.md
[spec-08]: spec/08-api.md
[spec-09]: spec/09-devices-printing-offline.md
[spec-10]: spec/10-staff-screens-bar-pos.md
[spec-11]: spec/11-song-systems-texts.md
[spec-12]: spec/12-security-retention.md
[spec-14]: spec/14-open-questions.md
