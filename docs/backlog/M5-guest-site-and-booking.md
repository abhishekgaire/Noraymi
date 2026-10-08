# M5 · Guest site and online booking

Sep 29, 2026 · the backlog for milestone M5 of the [phase 1 milestones](../milestones.md#m5--guest-site-and-online-booking). One ticket is one Claude Code session of 1 to 3 days. Build what the [spec](../spec/README.md) says; where a canvas board differs, [screens](../screens.md) says what to build instead, and the [demo seed](../demo-seed.md) gives every name and number the tests check.

**Goal (usable when done):** West 4's site, booking with a deposit, and manage or cancel.

**Depends on:** M4 (the payment core, the payment origin and refunds).

**Size:** 2 weeks in milestones.md. The 17 tickets below are 3 S and 14 M: about 30 to 45 working days (S ≤ 1 day, M 2–3 days). See [Open points](#open-points).

Definition of done: see CLAUDE.md.

## Done when

Copied from [milestones.md](../milestones.md#m5--guest-site-and-online-booking):

- A guest books Jae & co.'s booking (5 guests, Fri Sep 25, 11:00 PM, 2 hr, small tier) on the sandbox: the summary shows the full price with tax and the 20% gratuity before paying, the accepted policy version is stored, the $50 deposit is paid on our payment origin, and the confirmation text and page agree. Manage then changes the booking and cancels it, with the refund following the 24-hour rule in New York time.
- The payment page passes its header, script and changed-script checks ([Security and data retention](../spec/12-security-retention.md) 1).
- With Online booking & deposits off, the hero's "Book a room" reads "Call to book" with West 4's number, and existing bookings' manage links still work.
- The menu page, the PDF and the room page show the same items and prices, and a hidden item is gone from all three.
- The automated accessibility checks pass, and the screen-reader pass finds nothing that blocks a task.

## Suggested order

The IDs run in build order. Tickets on the same line can run side by side once the line before is done.

1. The site: M5-01 → M5-02; M5-03; M5-04, M5-05.
2. Booking: M5-06 → M5-07 → M5-08 → M5-09 → M5-10.
3. After booking: M5-11 → M5-12; M5-13.
4. Around it: M5-14; M5-15; M5-16 → M5-17.

M5 needs only M4, so it can run before or after M6. If it runs first, the site's "Sing at the bar" link waits behind a venue flag until M6's queue page ships.

## Every ticket

These come from the spec and apply to every ticket below, on top of the definition of done:

- Guest pages are server-rendered (Next.js in `apps/guest`), read "now", "tonight" and the business date from the venue's clock (America/New_York), and never the device's.
- Every public form and money route checks the server-side CAPTCHA and daily limits where the spec says, and money routes take an `Idempotency-Key`.
- Every new route and job joins M1's principal suite and venue-wall suite; guest token routes send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- Every amount comes from `packages/rules` in integer cents.
- Guest routes for existing bookings (manage, cancel and refund status) work whatever the modules say.
- Staff strings are in the English and Spanish catalogs; guest pages ship in English (West 4's setting), with their strings in the catalog too.
- Every guest page passes the WCAG 2.2 AA checks in CI (M5-16).

## Tickets

### M5-01 · Render the guest site from site_versions

- **Status:** done
- **Size:** M
- **Depends on:** M3 (`apps/guest`, the menu); M1 (settings, modules, `closures`)
- **Spec:** [Scope and architecture](../spec/01-scope-architecture.md) (Guest web); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`site_versions`, `website.priceWording`, `hours`, what each module hides); [Song systems and texts](../spec/11-song-systems-texts.md) (Songbook); [screens: Main](../screens.md#main), [Rooms](../screens.md#rooms), [Parties](../screens.md#parties)
- **Build:**
  - `site_versions` (version, status draft or published, content, created_by, published_at, published_by), and `apps/guest` server-rendering the published version for the venue's slug: the homepage (the hero, the numbers, the songbook section, "Sing at the bar", house rules, hours and address, and the Rooms and Book sections) and the private parties page (what the venue hosts, room sizes, a rough cost estimator, drink packages from the menu, and the enquiry form from M5-04).
  - Live facts come from their one place: hours and "Open now" from `hours` and `closures` in America/New_York; prices from `prices`; the menu and packages from the menu tables; the phone number from `phone.callNumber`.
  - Price wording follows `website.priceWording`: `plusTaxAndGratuity` (West 4) reads "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour"; `allIn` shows totals that include tax and gratuity, ready in case the lawyer says NYC's junk-fee rules need it.
  - The Rooms section's head-count picker shows which room size fits and what it costs, with tonight's billable minimum (4 on a Friday).
  - The song-search section shows only its heading and West 4's song count (from the site content) until `song_catalog` has rows; then a search box using `GET /v1/public/venues/{slug}/songs?q=` (M6).
  - "Sing at the bar" opens the singer's queue page (M6); until that page ships, the section waits behind a venue flag.
  - Sections follow the modules, as the table of what each module hides says; the site sits behind the CDN and refreshes on `settings.changed` and `menu.changed`.
- **Acceptance:**
  - [x] With the clock pinned at Fri Sep 25, 10:41 PM, the homepage reads open until 4 AM.
  - [x] Every price line reads "$10 a person an hour, plus tax and a 20% gratuity" and "VIP room $250 an hour"; switching `website.priceWording` to `allIn` changes every one of them.
  - [x] The Rooms picker for 3 guests on a Friday shows a small room billed for 4.
  - [x] With no catalog, the song section shows its heading and song count and no search box.
  - [x] Each page's HTML carries its content with JavaScript off.
- **Tests:** Playwright on staging with the pinned clock; server-render snapshots; module-effects tests; `packages/rules` unit tests for the price wording.
- **Notes:** Canvas differences: "Open now" from the device clock ([Main note 3](../screens.md#main)), the price wording ([Main note 4](../screens.md#main), [Rooms note 1](../screens.md#rooms)), the songbook search ([Main note 5](../screens.md#main)) and "Sing at the bar" linking nowhere ([Main note 1](../screens.md#main)). The spec doesn't give the `allIn` wording itself, only that it shows totals that include tax and gratuity; flagged. West 4's domain moves in M9, so M5 runs on staging hosts.
  - **Built (M5-01):** migration 0071 (`site_versions`, one draft at a time, every published version kept); the content's shape (`packages/shared/src/site.ts`: hero, numbers, songbook, Sing at the bar with its `live` flag, house rules, find us, rooms, parties), and West 4's words as published version 1 in the seed (`seed/west4-friday.json` → `site`, taken from the Main, Rooms and Parties boards; prices moved out of the words, since they're live facts). `GET /v1/public/venues/{slug}/site?guests=&hours=` returns the words and every live fact: open now from `hours` and `closures` on the venue's clock, the price lines' numbers from `prices`, the gratuity and the rule pack's tax, room sizes from the rooms, tonight's billable minimum, the menu's price ranges, packages, the phone number, the parties estimate, and which modules leave sections on (the website module off answers not found). `packages/rules/src/site.ts`: `allInCents` and `roomFor`, unit-tested.
  - Pages (`apps/guest`, server-rendered): `/` (the venue in `SITE_VENUE`, West 4 by default), `/v/{slug}` and `/v/{slug}/parties`. The Rooms picker's − and + and the estimator's are links (`?guests=`, `&hours=`), so they work with JavaScript off. Booking off: the hero reads "Call to book · (212) 255-0011" and Book links go. Waitlist off: no "Join the waitlist". Rooms off: no Rooms section. Packages off or none entered: no packages section.
  - **Flagged:** the `allIn` wording isn't in the spec; built as "$12.89 a person an hour, tax and the 20% gratuity included" and "VIP room $322.19 an hour, tax and gratuity included" (tax on the price, the gratuity untaxed). West 4 has no packages entered yet, so the parties page's "Drinks, sorted." section stays hidden until it does. The canvas's line "A deposit holds your room, refunded if you cancel 24 hours ahead" waits for M5-06's policy, so the number reads the price only.
  - **Not here:** "Full menu" links to `/v/{slug}/menu` (M5-03), Book to `/v/{slug}/book` (M5-07), the enquiry form to M5-04; Sing at the bar stays hidden until M6's queue page (`singAtTheBar.live` false). Pages render on each request, so a settings or menu change shows at once; caching them in a CDN waits for West 4's domain (M9), and the API's site read already says `s-maxage=60`.
  - Tests: `apps/api/src/routes/site.int.test.ts` (open until 4 AM, the words and phone, both wordings, the estimate, the picker, the songbook, modules); `e2e/guest.spec.ts` (the site: open line, price lines, picker for 3 → small room billed for 4, songbook with no search; JavaScript off with the parties estimate; all in and booking off); `e2e/a11y-guest.spec.ts` (axe on both pages).


### M5-02 · Build Admin → Website

- **Status:** done
- **Size:** M
- **Depends on:** M5-01; M2 (`POST /files`)
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (One place for each fact, `website`); [Security and data retention](../spec/12-security-retention.md) 14; [milestones: Admin by milestone](../milestones.md#admin-by-milestone); [screens: SiteBuilder note 2](../screens.md#sitebuilder), [AdminDesk note 15](../screens.md#admindesk)
- **Build:**
  - Admin → Website (passkey session) edits one draft `site_versions` row: the words, the photos (`POST /files`, each with alt text), which sections show (only sections whose module is on), the song count, and how prices are worded (`website.priceWording`).
  - Publish makes the draft live and keeps every published version, and any earlier version can be published again to undo a publish.
  - The site hides any promotion the promotion checks refuse; the happy-hour line comes only from dated `price_rules`, so Admin has no free-text happy-hour line.
  - Routes: `GET /site-versions`, `PUT /site-versions/draft`, `POST /site-versions/draft/publish` and `POST /site-versions/{v}/republish`.
  - Styles, section order and domains wait for the website builder in phase 2.
- **Acceptance:**
  - [x] New hero words, published, show on the live homepage within a minute, and the previous version can be published again.
  - [x] A photo without alt text can't be saved.
  - [x] A section whose module is off can't be switched on here, and Admin says why.
  - [x] No PIN session opens Admin → Website.
- **Tests:** API and end-to-end tests; principal suite.
- **Notes:** The API names no routes for `site_versions`; the four above are the cautious default, flagged. The canvas's free-text "Happy hour line" goes ([AdminDesk note 15](../screens.md#admindesk)); price rules are edited in Admin → Menu (M3).
  - Built: `/v1/venues/{v}/site-versions` (GET, `PUT draft`, `POST draft/publish`, `POST {n}/republish`), owner or manager in a passkey session (`admin.access`), website module on. Publishing gives the draft the next version number; republishing copies an earlier version's words into a new published version, so the history is never rewritten and the site always shows the highest number. Each publish emits `settings.changed` (entity `site`). The public site is cached for 60 seconds, so a publish shows within a minute.
  - Content gains `hidden` (sections Admin turned off) and `photos` (`file_id`, `alt` required and trimmed, `place`: hero, rooms or parties). Sections and their modules: Sing at the bar → Bar mode, Rooms → Rooms, Packages → Packages; numbers, songbook, menu, house rules, find us and private parties need no module. A section whose module is off stays hidden whatever the content says, and switching it on is refused with "Turn on {module} in Features first." Hiding it is always allowed. With Private parties hidden, the parties page answers 404 and the footer link goes.
  - Photos: a new `site_photo` file kind (migration 0072: JPEG, PNG or WebP up to 10 MB; no HEIC, because browsers can't show it). A photo has to be a `site_photo` file of this venue; it's attached on save. The site gets one-hour signed links.
  - `website.priceWording` is edited on the same screen but saved with Save and publish, like every other setting; the site's words go through the screen's own Save draft and Publish.
  - The happy-hour line has no free-text field (note 15). Staff wording for this screen is in both catalogs; the site's own words stay the venue's (English at West 4).
  - Flagged: the route names (above); which sections need which module (cautious default); words editable here are the hero, rooms, parties and song count (the numbers, house rules and find-us words are kept from the seed until the phase 2 builder).

### M5-03 · Serve the menu page and the PDF from one menu list

- **Status:** done
- **Size:** M
- **Depends on:** M5-01; M3 (the menu, the menu PDF job, the room page)
- **Spec:** [API](../spec/08-api.md) (Menu: `GET /v1/public/venues/{slug}/menu`); [Security and data retention](../spec/12-security-retention.md) 14 (HTML first, tagged PDF); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (promotion checks, `price_rules`); [screens: Menu](../screens.md#menu)
- **Build:**
  - The menu page, server-rendered from `GET /v1/public/venues/{slug}/menu`, the same list room ordering and the PDF job read: categories, items with their variants, options and prices, packages (with Packages & specials on), the room price line, hours, house rules and the PDF link.
  - An item that's out stays in its place, greyed and marked "86'd tonight", until restored or the night closes; a hidden item (`menu_items.shown` false) is gone.
  - The happy-hour banner comes from dated `price_rules` and hides when there are none; any promotion the checks refuse is hidden.
  - `menu.changed` purges the page's cache, and M3's job renders the PDF again.
- **Acceptance:**
  - [x] The menu page, the PDF and Room 9's room page show the same items and prices.
  - [x] An item hidden in Admin → Menu is gone from the page, the PDF and the room page within a minute.
  - [x] Hoegaarden, Casamigos Blanco and Casamigos · bottle show "86'd tonight" on the page.
  - [x] With no price rules, no happy-hour banner shows.
- **Tests:** a comparison test that renders the page, reads the PDF's text and calls the room page's menu route, and fails on any difference; end-to-end.
- **Notes:** [Menu notes 1 to 4](../screens.md#menu). The allergy notice and allergen fields are phase 2.
  - One list: `guestMenu()` (`apps/api/src/menu/guest-menu.ts`) is what `GET /v1/public/venues/{slug}/menu` (the menu page and the room page) returns and what the menu PDF job prints, credit prices included while a surcharge is on (before, the PDF printed cash prices). The public route now also carries `packages` and `happy_hours`.
  - Promotions: `livePromotions()` re-runs the rule pack's promotion checks on every shown package and every happy-hour price rule in date today, and drops any the checks refuse, so a rule saved under an older pack (or straight into the table) is never advertised. With Packages & specials off, there are none. The site's packages (M5-01) go through the same filter. Only `happy_hour` rules make the banner; `special` and `hourly` rules don't (flagged).
  - The page: `/menu` (the bare domain) and `/v/{slug}/menu`, server-rendered with no cache, so a hide or an 86 shows on the next load; there's no CDN copy to purge yet (`menu.changed` re-renders the PDF, as in M3-05). 86'd rows stay in place, struck through and greyed (still past 4.5:1 in light and dark), reading "86'd tonight". The PDF link shows once a PDF exists. The PDF prints packages under "Packages".
  - Test: the end-to-end comparison reads the page's rows, the room page's menu route and the PDF's text (printed by the job's own code, `menu/pdf-text.ts`, then read by pdf.js), before and after hiding Bud Light; an integration test covers the banner, refused and out-of-date rules, and the module; the menu page joins the accessibility checks.

### M5-04 · Take private-party enquiries into Messages

- **Status:** done
- **Size:** S
- **Depends on:** M5-01; M2 (Messages, `conversations`, the CAPTCHA)
- **Spec:** [API](../spec/08-api.md) (Enquiries); [Data model](../spec/04-data-model.md) (`enquiries`, `conversations`); [Song systems and texts](../spec/11-song-systems-texts.md) (Two-way inbox); [milestones: GA-N1](../milestones.md#must-fix-items-and-where-they-close); [screens: Parties note 1](../screens.md#parties)
- **Build:**
  - The enquiry form on the private parties page takes a name, a mobile number, the party size, a date and a message, and says "We reply by text".
  - `POST /v1/public/venues/{slug}/enquiries` (with the CAPTCHA and daily limits, M5-05) writes an `enquiries` row and its `conversations` row, so the enquiry lands in Messages on desktop and phone as unread, and `message.received` updates the Board and the badges.
  - `GET /enquiries` for staff.
  - Staff answer in the thread: free text only as a reply in an open service conversation, with links and promotions blocked; a deposit goes out through the Payment link text (M5-13).
- **Acceptance:**
  - [x] An enquiry for 22 guests lands in Messages as an unread thread with its party size, date and message.
  - [x] The form won't take an email address in place of a mobile number.
  - [x] A staff reply with a link is blocked, and the Payment link text is offered instead.
- **Tests:** integration; CAPTCHA test; end-to-end.
- **Notes:** The canvas takes "phone or email", but the inbox is texts only ([Parties note 1](../screens.md#parties)); whether an email-only enquiry is allowed is undecided, so the form takes a mobile number (cautious default). Packages on the page are menu items ordered from the room; selling them in the booking is phase 2 (K3).
  - Built: migration 0073 (`enquiries`, and `enquiry` as a conversation context); `POST /v1/public/venues/{slug}/enquiries` (website module) finds or makes the guest by mobile number, opens a conversation of its own, puts the guest's message in as its first incoming text (so it's unread, opens the 24-hour reply window, and is assigned to the manager on duty), and sends `message.received`; `GET /v1/venues/{v}/enquiries` (owner, manager and staff with Messages) lists them newest first. The thread shows "Party enquiry · 22 guests · Sat, Oct 10" above the texts.
  - The form takes a name, a US mobile number (+1 only), guests, a date (tonight or later, on the venue's clock) and anything else. An address with "@" is refused in the form and by the server ("We reply by text…"). The canvas's occasion chips aren't built: `enquiries` has no field for them, and the guest can say it in the message (flagged).
  - A reply with a link was already refused (M2-30); its message now points to the Payment link text. The button that sends it from the thread comes with M5-13.
  - **Not built here: the CAPTCHA and daily limits.** They're M5-05, which waits on M2-27 (blocked on the founder: the CAPTCHA provider and the limit numbers). Until then the route runs without them, like the waitlist page.

### M5-05 · Guard booking and enquiries with the CAPTCHA and daily limits

- **Status:** blocked
- **Size:** S
- **Depends on:** M2 (the server-checked CAPTCHA and daily limits)
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 8; [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) step 1; [API](../spec/08-api.md) (Bookings, Enquiries)
- **Build:**
  - The server-checked CAPTCHA and the daily limits per phone number, IP address and device (built in M2 for the waitlist and phone codes) on `POST /v1/public/venues/{slug}/bookings` and `POST /v1/public/venues/{slug}/enquiries`.
  - One PaymentIntent per booking: a unique link from each booking to its deposit payment, which every retry reuses (M5-09).
  - Only +1 numbers.
- **Acceptance:**
  - [ ] A booking without a valid CAPTCHA token is refused by the server.
  - [ ] Past the daily limit for one phone number, IP address or device, a new booking is refused with the reason.
  - [x] Five payment retries on one booking leave one PaymentIntent in Stripe. (Built and tested with M5-09: `booking-deposit.int.test.ts`.)
- **Tests:** integration; a test that drives each limit to its edge.
- **Notes:** Radar rules and our per-venue decline-rate alarm (Security 8) come with watching production in M8.
  - Blocked with M2-27 on the founder: which CAPTCHA provider, and the daily limits per phone number, IP address and device. Nothing is invented meanwhile. The other two lines don't wait: one PaymentIntent per booking is built with the deposit payment (M5-09), and booking takes +1 numbers only (M5-08), as enquiries already do (M5-04).

### M5-06 · Build Admin → Deposits & cancelling, with the policy guests accept

- **Status:** done
- **Size:** M
- **Depends on:** M1 (settings, the rule pack); M4-09 (forfeit lines)
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`DepositRule`); [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) (What the guest sees on the booking page); [Data model](../spec/04-data-model.md) (`policy_versions`); [screens: AdminDesk notes 16 and 17](../screens.md#admindesk), [Book note 2](../screens.md#book)
- **Build:**
  - Admin → Deposits & cancelling edits `deposit`: on; mode (first hour, per person, flat, percent or cardHold); value; `refundHours` (24 at West 4); `late` (keep, half or refund); `noShow` (keep, first hour or nothing); `graceMin` (15); and `bigParty` (from 20 guests, a flat $250 deposit, a 24-hour refund window). Every save runs the rule-pack checks.
  - Each save builds the words guests read from these settings and writes a new `policy_versions` row (kind deposit, version, text, hash, published_at): the deposit comes off the bill; the card is saved, and the rest of the tab and a no-show charge can go on it later, with how each amount is worked out and when; the refund cut-off; and "A 20% gratuity is added to room tabs." Book and Manage both read it.
  - With Online booking & deposits off, the section reads "Online booking is off".
- **Acceptance:**
  - [x] West 4 shows a first-hour deposit, 24 hours, keep on a late cancel, keep on a no-show, a 15-minute grace, and $250 from 20 guests.
  - [x] A save writes a new policy version; the booking page shows its words above the pay button, and a booking made before the save keeps the version it accepted.
  - [x] The policy names the saved card, the later charges, how each is worked out and when.
- **Tests:** settings validation; policy hashing and versioning; end-to-end.
- **Notes:** The seed doesn't give West 4's late-cancel and no-show outcomes; the Book, Manage and AdminDesk boards all use keep and keep (`DEPOSIT = { late: "keep", noShow: "keep" }`), so load those, flagged. The canvas policy never mentions the saved card ([Book note 2](../screens.md#book)) and has no cardHold mode ([AdminDesk note 16](../screens.md#admindesk)).
  - Built: migration 0074 (`policy_versions`: kind, version, text, SHA-256 hash, published_at and by; insert-only; `bookings.policy_version_id`, there since 0029, now points at it). `depositPolicyText()` in `packages/rules` builds the words from `deposit` and the gratuity in `pay`; every save of either key (in the same transaction) publishes the next version when the words change, and keeps the current one when they don't. The seed publishes West 4's version 1 (first hour, 24 hours, keep, keep, 15 minutes, $250 from 20).
  - Routes (not in the API table, flagged): `GET /v1/venues/{v}/policy-versions` for Admin, and `GET /v1/public/venues/{slug}/policy` for Book and Manage, readable whatever the modules say so existing bookings keep their terms.
  - The rule-pack checks on save gain `checkDeposit`: each mode's value has to mean what the mode says (whole cents above $0, a whole percent 1 to 100, none for the first hour and a card hold), whole-hour cut-offs up to 30 days, and big parties from 2 guests. The rule pack itself sets no deposit limits.
  - Policy wording: the deposit sentence by mode; the big-party sentence; the saved card (the rest of the tab, the amount due and never more, after the guest confirms on their phone, or with a manager's approval if they've left, and an itemized receipt texted at once, from Payment flows · Card on file); the refund cut-off; the late cancel; the no-show with its grace minutes and, for "first hour", "up to the first hour's room time in total, the deposit included"; and the gratuity sentence. A card hold says nothing is charged. These are our words from the spec, not a lawyer's (flagged).
  - The booking page's Terms step reads the public route in M5-08 and M5-09; until the booking page exists, the second acceptance line is checked through that route and a seed booking that keeps version 1.

### M5-07 · Quote a booking and hold a real room for 10 minutes

- **Status:** done
- **Size:** M
- **Depends on:** M5-05, M5-06; M2 (room assignment, `room_blocks`, bookings)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) step 1 and the booking page's steps; [Money rules](../spec/05-money-rules.md) rules 2, 3 and 11; [Data model](../spec/04-data-model.md) (Room assignment, `room_blocks`, `bookings.pending_until`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`prices.booking`, `website.priceWording`); [API](../spec/08-api.md) (`GET /v1/public/venues/{slug}/availability`, `POST /v1/public/venues/{slug}/bookings`); [Security and data retention](../spec/12-security-retention.md) 14; [screens: Book](../screens.md#book), [N1](../screens.md#n1-booking-steps-after-the-price)
- **Build:**
  - Pick: the date, the party size with the billable minimum shown ("Fri & Sat bill at least 4 · you pay for 4" for 3 on a Friday), the time and the length, within `prices.booking` (minimum and maximum hours, maximum guests, start slots); "Tonight" and the minimum come from the venue's clock.
  - `GET /v1/public/venues/{slug}/availability` lists the slots with a free real room of the right size. On the fall-back night the grid shows both 1 AM hours, labeled EDT and EST; on the spring-forward night it refuses times that don't exist.
  - The full-price summary before paying: room time for the booked length at billable guests, tax and the 20% gratuity (from `packages/rules`), and the deposit, worded by `website.priceWording`.
  - `POST /v1/public/venues/{slug}/bookings` assigns a real room (the smallest free room that fits, and a bigger tier only when no booking that needs it would be left without one), creates a pending booking with `pending_until` 10 minutes out, and a `hold` room block that lapses with it; a countdown shows on every later step, announced to screen readers.
  - At one minute left the page offers "More time" (10 more minutes, at least ten times), which extends the hold.
  - A job releases lapsed holds. Parties above `prices.booking.maxGuests` are sent to the enquiry form.
- **Acceptance:**
  - [x] Jae & co. (5 guests, Fri Sep 25, 11:00 PM, 2 hours) see room time $100.00, tax $8.88 and the 20% gratuity $20.00 ($128.88) and a $50.00 deposit before paying.
  - [x] Picking the slot holds a small room for 10 minutes with a countdown, and no second guest can hold that room for an overlapping time.
  - [x] A party of 3 on a Friday can book, reads "Fri & Sat bill at least 4 · you pay for 4" and pays a $40.00 deposit.
  - [x] On Nov 1, 2026 the grid shows 1:00 AM EDT and 1:00 AM EST; on Mar 14, 2027 no 2:30 AM slot can be picked.
  - [x] A lapsed hold frees the room within a minute.
- **Tests:** the money-cases group `deposits` (the `deposit_party*` cases: $40.00 for 3 or 4 on a Friday, $30.00 for 3 on a weeknight, $120.00 for 12, $190.00 for 19, $250.00 from 20); the `billable_guests` and `business_date` groups against the quote; daylight-saving tests; a concurrency test on holds (the room-block exclusion).
- **Notes:** The canvas stops the guests stepper at 4 on Fridays ([Book note 3](../screens.md#book)) and reads the device date ([Book note 4](../screens.md#book)). Spec gaps: Security 14 says countdowns can be extended but not how; "More time" above is the cautious default, following WCAG 2.2's timing rule. West 4's `prices.booking` limits aren't in the seed; they're set in Admin → Hours & prices (M2).
  - Built: `bookingQuote()` in `packages/rules` (room time minute by minute at the rate in force, tax, the gratuity before tax, the deposit), tested with Jae's $128.88 and the `deposit_party*` cases; `GET /v1/public/venues/{slug}/availability` and `POST /v1/public/venues/{slug}/bookings`, plus `GET /v1/public/bookings/{token}/hold` and `POST …/more-time` (the cautious default: the API table names only the first two). Online booking & deposits must be on (404 `booking_off` otherwise).
  - Migration 0075: a web booking can have no guest while it's pending or cancelled (the name comes at Details, M5-08), and `hold_extensions` counts More time (10 minutes each, ten times). The hold is a `hold` room block with `expires_at`; the hold sweep (every 15 seconds) now also cancels web bookings whose hold lapsed. The booking's 128-bit link token is stored hashed in `manage_token_hash` and becomes the manage link.
  - Rooms: online holds take only rooms marked bookable online, smallest that fits first. At West 4 the VIP room isn't bookable online, so 21 to 40 guests are sent to the enquiry form with 41 and up (flagged: the founder may want the VIP room online).
  - Fixed on the way: parallel holds deadlocked on the room-block exclusion index (Postgres 40P01, a 500). Room assignment now takes a per-venue lock for the rest of its transaction, so holds take turns and each gets its own room or "no room".
  - Tonight (Sep 25) every small room is booked from 11 PM, so a hold for Jae at 11 PM gets a medium room; the "small room" acceptance is tested on Fri Oct 2.
  - Also fixed: the staff Spanish-screen e2e check flagged "Teléfono con Tap to Pay" (M4-29) as English because the loose pattern "{opens} to {closes}" matched it; a text that is exactly a Spanish catalog string now counts as Spanish.

### M5-08 · Take the guest's details, consents and the policy they accept

- **Status:** done
- **Size:** M
- **Depends on:** M5-06, M5-07; M2 (texts and STOP)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) step 2 and the Details and Terms steps; [Song systems and texts](../spec/11-song-systems-texts.md) (Consent and timing); [Data model](../spec/04-data-model.md) (`guests`, `consents`, the `bookings` acceptance columns); [milestones: GA-M3 and GA-M5](../milestones.md#must-fix-items-and-where-they-close); [screens: N1](../screens.md#n1-booking-steps-after-the-price)
- **Build:**
  - Details: name, mobile (+1 only) and email; a line saying the confirmation and reminders come by text to that number; and an unticked box for marketing texts, separate from the booking.
  - A ticked box writes a `consents` row (channel sms, kind marketing, given_at, source the booking form, `text_version` of the box's wording, ip); an unticked one writes nothing. Marketing texts stay off at West 4 until their campaign goes live (M8).
  - A `guests` row for the venue (never shared across venues), matched by phone within the venue.
  - Terms: the current deposit policy version above the pay button, with this booking's refund cut-off worked out and "A 20% gratuity is added to room tabs."
  - Paying (M5-09) records on the booking the policy version (`policy_version_id`) and its hash, the time (`accepted_at`), the IP address (`accepted_ip`) and the browser (`accepted_ua`).
- **Acceptance:**
  - [x] Once Jae pays, his booking stores the policy version and hash he saw, with the time, the IP address and the browser.
  - [x] The marketing box starts unticked; left that way it stores no consent, and ticked it stores the wording's version, the IP and the time.
  - [x] A number outside +1 is refused.
- **Tests:** integration; end-to-end.
- **Notes:** GA-M3's opt-in lands here; West 4's marketing campaign goes live in M8. This is GA-M5's stored terms.
  - Built: `POST /v1/public/bookings/{token}/details` (not in the API table, flagged like M5-07's hold routes) takes name, a +1 mobile, email and the marketing box; refused with `phone` for anything but +1 and `hold_over` once the hold has run out. The guest is matched by phone within the venue (`findOrCreateGuest`, erased guests never matched); a returning guest keeps the name they first gave, and an email is added only where none was kept. The hold's view (`GET …/hold`) now carries the guest, the current deposit policy (id, version, text, hash), this booking's cut-off in words, any acceptance, and the marketing box.
  - The marketing box: shown only while Marketing texts is on (the module hides `booking.marketingOptIn`), so it is off at West 4 until M8's campaign goes live. Its exact words are kept as a `policy_versions` row of the new kind `marketing_opt_in` (migration 0130), and a ticked box writes one `consents` row (sms, marketing, `given_at`, source `booking_form`, `text_version` = that version's id, the IP address). Unticked, or ticked while the module is off, nothing is written; saving twice doesn't write the same proof twice. The wording ("Also text me news and offers from West 4. Optional, and not needed for this booking. Reply STOP anytime.") is ours, not a lawyer's: flagged for the founder.
  - Terms: the policy's words, its version, and "Free to cancel until …" from `cutoffWords()` in `packages/rules` (elapsed hours, the venue's time zone; a cut-off more than six days out adds its date, "Thu, Oct 1 11:00 PM", so the weekday can't be misread: cautious default, flagged; the zone is named when the cut-off and the start sit on different sides of a clock change).
  - `acceptTerms()` records the version, the time, the IP address and the browser on the booking, and refuses a version that is no longer current (`policy_changed`) or a booking with no guest yet (`details`). The hash isn't copied onto the booking: the data model has no column for it, and `policy_versions` is insert-only, so `policy_version_id` fixes the hash for good. M5-09's payment page calls it as the guest pays.
  - The IP address is the client's from `X-Forwarded-For`, `TRUSTED_PROXY_HOPS` proxies in (the guest site's /v1 rewrite is one).
  - Tests: `booking-details.int.test.ts` (+1 only, matching by phone, the consent and its proof, acceptance); `booking-cutoff.test.ts`; Playwright "Book: Jae's details, the marketing box and the terms".


### M5-09 · Pay the deposit on the payment page

- **Status:** done
- **Size:** M
- **Depends on:** M5-08; M4-05, M4-15
- **Spec:** [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) steps 2 and 3, and Failures; [Stripe setup](../spec/06-stripe-setup.md) step 10; [Money rules](../spec/05-money-rules.md) rule 11; [API](../spec/08-api.md) (`POST /v1/public/pay/{token}`); [screens: N1](../screens.md#n1-booking-steps-after-the-price)
- **Build:**
  - The booking hands off to the payment page (M4-15) with a pay token. `POST /v1/public/pay/{token}` creates the booking's one PaymentIntent on West 4's account (`payment_method_types[]=card`, `setup_future_usage=off_session` and a Customer on the venue's account), or returns the same one on every retry.
  - The Payment Element (Apple Pay, Google Pay or card) and "Pay $50 deposit", with the countdown still running.
  - A declined card asks for another card on the same PaymentIntent. While the server waits for Stripe's answer, the page says it's still checking and never shows a second pay button. A hold that ran out before paying sends the guest back to pick a time.
  - The payment row: method `card_online`, with `booking_id`, and attempts with `portion_key` 'deposit'; the saved card goes in `bookings.payment_method_id`.
  - Until check-in, the deposit is money held for the guest (customer deposits), not a sale.
- **Acceptance:**
  - [x] Jae pays the $50.00 deposit on the sandbox payment origin with a test card, and Stripe shows one PaymentIntent with `setup_future_usage=off_session` and a Customer on West 4's account.
  - [x] A declined card, then a good one, leaves one PaymentIntent with two attempts.
  - [x] While Stripe's answer is pending, the page says it's still checking and shows no second pay button.
  - [x] Letting the hold run out before paying sends Jae back to pick a time.
- **Tests:** sandbox integration (a decline, then success); Playwright on the payment origin; chaos: killed after Stripe's success and before our record, the reconciler (M4-12) settles it.
- **Notes:** The payment page's header and script checks run again here for the deposit flow (M5-17).
  - Built: Terms' "Pay $50.00 deposit" calls `POST /v1/public/bookings/{token}/pay` (not in the API table, flagged), which makes the booking's one deposit payment (card_online, `booking_id`, first attempt with `portion_key` 'deposit') under the booking's row lock, then hands out a new pay link to that same payment on each call (`pay_links.purpose` 'deposit', lasting until the booked start). The browser goes to the payment origin with the booking's link in the URL fragment, which never reaches a server (M5-10 uses it to come back).
  - The PaymentIntent: `payment_method_types[]=card` (Apple Pay and Google Pay arrive as cards), `setup_future_usage=off_session`, a Customer on West 4's account (key `<payment_id>:customer`), `booking_id` in its metadata, key `<payment_id>:create`. Every link and every reload answers the same one.
  - The payment page for a deposit: "Your deposit · $50.00", the hold's countdown with More time (`POST /v1/public/pay/{token}/more-time`, since the pay host only serves `/v1/public/pay/`), the policy and the cut-off above "Pay $50.00 deposit". Pressing Pay first calls `POST /v1/public/pay/{token}/start` (new, flagged): it records the accepted policy version, time, IP address and browser (M5-08's `acceptTerms`), refuses a stale policy or a lapsed hold (the page reloads to say so), and starts a new attempt after a decline, so another card goes on the same PaymentIntent. A hold that ran out shows "Your hold ran out…" and "Pick a time again" (`status: lapsed`), and no PaymentIntent is made for it.
  - On capture, the PaymentIntent's card goes in `bookings.payment_method_id` (the state machine now reads `payment_method`).
  - The reconciler reads a deposit's attempt as before but never cancels it while the booking's hold stands (the guest may be typing a card for 10 minutes or more, past the reconciler's 2 minutes); once the hold has run out, an unpaid PaymentIntent is canceled. A payment Stripe took that we never recorded is captured by the reconciler (the chaos case).
  - Customer deposits: a captured payment with a booking is already counted as deposits taken (customer deposits) in the night's journal and moves to the check at check-in (M7-15, M4), so no change was needed.
  - Fixed on the way: `pnpm seed` didn't wipe `consents`, so a consent naming a guest made at runtime blocked the next seed; it now starts the night with none.
  - Tests: `booking-deposit.int.test.ts` (the PaymentIntent's settings, the policy accepted, the saved card, five links and a decline then a good card leaving one PaymentIntent with two attempts, More time, the lapse, the reconciler leaving a live deposit alone, the chaos case); Playwright "Book: Jae pays the $50.00 deposit on the payment page". The real-sandbox run (Stripe test mode, not the fake) is part of M5-17's proof.


### M5-10 · Confirm the booking and send the confirmation

- **Status:** todo
- **Size:** M
- **Depends on:** M5-09; M4-03, M4-12; M2 (texts)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) steps 3 and 4, Confirmed and Failures; [Money rules](../spec/05-money-rules.md) rule 2; [Song systems and texts](../spec/11-song-systems-texts.md) (the Booking confirmed text); [Security and data retention](../spec/12-security-retention.md) 9; [screens: N1](../screens.md#n1-booking-steps-after-the-price), [Manage note 4](../screens.md#manage)
- **Build:**
  - The booking confirms when the server, fetching the PaymentIntent itself on the page's return from Stripe, sees it succeeded, or on `payment_intent.succeeded`, whichever comes first; the reconciler checks any booking still pending after 2 minutes.
  - A payment that lands after the hold lapsed: the room is checked again; if it's gone, the payment is refunded in full automatically and the page says so; if it's still free, the booking confirms with a new block.
  - At first confirmation, `bookings.refund_cutoff_at` is fixed at the booked start minus `refundHours` (the big-party window for a big party), worked out in New York time; no later change can push it later.
  - The Confirmed state: the room size, date and time, the deposit paid, "Free to cancel until …", the gratuity sentence, that the confirmation text went to their number, and a link to manage the booking.
  - The Booking confirmed text says the same, for example "Booked. Room for 5 at 11:00 PM, Fri Sep 25. A 20% gratuity is added to room tabs. Deposit $50 paid, comes off your bill. Free to cancel until Thu 11:00 PM: west4karaoke.com/b/…".
  - The manage link carries a 128-bit token stored hashed (`bookings.manage_token_hash`) and expires after the booking.
- **Acceptance:**
  - [ ] Booked on Wed Sep 23 for Fri 11:00 PM, Jae's confirmation page and text both say "Free to cancel until Thu 11:00 PM" and $50 paid.
  - [ ] With the page closed right after paying, the webhook confirms the booking; with the webhook held back too, the reconciler confirms it on its next run.
  - [ ] A payment that lands after its hold lapsed, with the room taken, is refunded in full and the page says so.
  - [ ] A booking whose cut-off falls across the Nov 1, 2026 change shows its cut-off with EDT or EST.
- **Tests:** sandbox integration for the return path, the webhook path and the reconciler path; daylight-saving unit tests for the cut-off; text rendering tests; principal suite for the manage token.
- **Notes:** Spec gap: `refundHours` is a duration, and rule 2 counts durations in elapsed time, while GA-M5 asks for "refund cut-offs in New York time"; across a daylight-saving change the two differ by an hour. Cautious default: elapsed hours (Temporal's hour arithmetic), shown in New York time with EDT or EST; flagged for the founder.

### M5-11 · Change a booking on the manage page

- **Status:** todo
- **Size:** M
- **Depends on:** M5-10; M2 (room assignment, running late)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) steps 4 and 5; [Money rules](../spec/05-money-rules.md) rules 3 and 11; [API](../spec/08-api.md) (`GET` and `PATCH /v1/public/bookings/{token}`); [screens: Manage](../screens.md#manage)
- **Build:**
  - The manage page, linked from the confirmation page and the Booking confirmed text: the booking, its deposit, "Free to cancel until …", and Change time, Change date, Change party size, Running late and Cancel.
  - Change time or date: a real room for the new slot (assignment), the deposit kept, and the refund cut-off never later than it was.
  - A bigger party or a bigger room works the deposit out again from billable guests and collects the difference on this screen (its own payment on the payment page). A smaller party gets the excess back only before the cut-off; after it the deposit already paid stays and comes off the bill at check-in, and where the check could close for less than the deposit the page says the rest will be kept before the guest confirms.
  - Running late: "We'll hold your room until … That's our 15-minute grace." sets `running_late_until` and shows on the Board.
  - Big parties (20 or more) follow the big-party deposit.
- **Acceptance:**
  - [ ] Before the cut-off, Jae goes from 5 to 6 guests: the deposit becomes $60.00 and he pays $10.00 on the payment page.
  - [ ] Before the cut-off, he goes from 6 to 3: the deposit becomes $40.00 (Friday bills 4) and $20.00 is refunded; after the cut-off, the $60.00 stays and the page says so.
  - [ ] Moving Jae to Saturday keeps his deposit, gives him a small room free then, and keeps his cut-off at Thu 11:00 PM.
  - [ ] Running late reads "We'll hold your room until 11:15 PM", and the Board shows the booking as late.
- **Tests:** the money-cases group `deposits`; sandbox integration for the difference and the refund; end-to-end.
- **Notes:** The canvas shows Jae as 7 guests at 10:00 PM for $70 ([Manage note 1](../screens.md#manage)), stops the stepper at 4 ([Manage note 2](../screens.md#manage)) and changes the time only on the same night ([Manage note 3](../screens.md#manage)). The policy's refund of an excess isn't a staff refund, so it needs no approval.

### M5-12 · Cancel by the refund cut-off, charge no-shows, and let the venue cancel

- **Status:** todo
- **Size:** M
- **Depends on:** M5-11; M4-09, M4-21; M2 (Mark no-show, closures, the Calendar)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) steps 4 and 6; [Money rules](../spec/05-money-rules.md) rules 11 and 16; [API](../spec/08-api.md) (`DELETE /v1/public/bookings/{token}`, `POST /bookings/{b}/no-show`, `POST /closures`); [Song systems and texts](../spec/11-song-systems-texts.md) (Deposit refund and Payment link texts); [screens: Calendar note 4](../screens.md#calendar), [DeskCalendar note 4](../screens.md#deskcalendar)
- **Build:**
  - `DELETE /v1/public/bookings/{token}`: before the cut-off, the deposit is refunded in full automatically; after it, the accepted policy version decides (keep, half or refund); the room block is released.
  - A kept amount becomes a `fee` check with the next check number and a `forfeit` line (M4-09). A refund goes through the refund engine (M4-21) with no staff approval, since the accepted policy decides it; the manage page shows "Refund pending" and then "Refunded", and the Deposit refund text goes out.
  - No-show (staff's Mark no-show after the grace, from M2): the policy's no-show outcome keeps the deposit, or charges up to the first hour in total off-session on the saved card; a failed off-session charge texts the guest a pay link (the Payment link text).
  - The venue cancels: closing or blocking a booked date (`POST /closures`) lists the bookings it affects with "Cancel and refund all"; a cancellation by the venue always refunds in full, and the guests are texted.
  - Manage, cancel and refund status keep working with the booking module off.
- **Acceptance:**
  - [ ] Jae (booked Wed for Fri 11:00 PM) cancels on Thu at 10:00 PM: $50.00 is refunded automatically, the page shows "Refunded" once Stripe confirms, and the Deposit refund text goes out.
  - [ ] Jae cancels on Fri at 10:41 PM, after Thu 11:00 PM: the $50.00 is kept as a `forfeit` line on a `fee` check with the next number, and nothing is refunded.
  - [ ] The Nguyens, marked no-show after 11:15 PM, keep their $60.00 deposit as a forfeit.
  - [ ] Blocking a date with three bookings lists them, and "Cancel and refund all" refunds each in full and texts each guest.
  - [ ] Refund status on the manage page works with Online booking & deposits off.
- **Tests:** sandbox refunds and an off-session no-show charge that fails (Stripe's test card that attaches but declines, 4000 0000 0000 0341); daylight-saving cut-off tests; end-to-end.
- **Notes:** Spec gap: `noShow: "nothing"` doesn't say whether the deposit comes back. Since keep is its own option, the cautious default is that "nothing" refunds the deposit and charges nothing; flagged. Whether a kept deposit is taxable, and needs its own check number, is with the accountant (gate); it gets its own `fee` check number, as the spec says.

### M5-13 · Send payment links for staff and big-party bookings, and save cards for cardHold

- **Status:** todo
- **Size:** M
- **Depends on:** M5-09, M5-10; M2 (staff bookings, the Calendar and DeskCalendar)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online) step 7; [Data model](../spec/04-data-model.md) (`bookings.pending_until`, `room_blocks`); [API](../spec/08-api.md) (`POST /bookings/{b}/payment-link`); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`DepositRule` mode cardHold, `bigParty`); [Song systems and texts](../spec/11-song-systems-texts.md) (the Payment link text); [screens: Calendar notes 2 and 3](../screens.md#calendar), [DeskCalendar notes 2 and 3](../screens.md#deskcalendar), [N1](../screens.md#n1-booking-steps-after-the-price)
- **Build:**
  - `POST /bookings/{b}/payment-link` for a staff or big-party booking: the booking stays pending until `pending_until` (24 hours after the link is sent, never later than the start), its room block is a hold that lapses with it, and the Payment link text goes out ("West 4 is holding the VIP room for 22 on Fri Sep 25 at 9:30 PM. Agree to the terms and pay the $250.00 deposit here: west4karaoke.com/b/…").
  - The guest opens it, accepts the policy (stored as in M5-08) and pays on the payment page; the booking confirms as in M5-10; an unpaid link lapses and releases the room.
  - The big-party dialog on the Calendar and DeskCalendar shows the room and how long it's free, refuses overlapping or past slots, and places the pending hold.
  - cardHold mode, for venues that take no deposit: the payment page saves the card with a SetupIntent (`usage=off_session`, a Customer on the venue's account) under the same consent record and charges nothing.
- **Acceptance:**
  - [ ] Andy sends a payment link for 22 guests in the VIP room: the Payment link text goes out, the room is held for 24 hours (or until the start), and paying $250.00 confirms the booking.
  - [ ] The dialog refuses 24 guests in the VIP room at 9:00 PM for 3 hours while Bianca L.'s party holds it from 9:30 PM, and refuses a slot already past.
  - [ ] An unpaid link lapses at `pending_until` and frees the room.
  - [ ] On a test venue in cardHold mode, a booking saves the card, charges $0.00 and stores the policy version.
- **Tests:** sandbox integration (a link paid, a link lapsed, a SetupIntent); end-to-end on the Calendar.
- **Notes:** [Calendar note 2](../screens.md#calendar) says the spec doesn't fix a payment link's hold length; the data model does (24 hours, never later than the start). Spec gap: SetupIntent events aren't on the Venue payments endpoint's list in [Stripe setup](../spec/06-stripe-setup.md) step 6; add `setup_intent.succeeded` and `setup_intent.setup_failed` for cardHold, flagged. Closes GA-N1's big-party booking with M5-04's enquiry form.

### M5-14 · Turn booking off with the module, and keep manage links working

- **Status:** todo
- **Size:** S
- **Depends on:** M5-01, M5-12
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (Modules, stopping, what each module hides); [decisions](../decisions.md) (D71); [screens: Main note 2](../screens.md#main), [Book note 5](../screens.md#book), [SiteBuilder note 1](../screens.md#sitebuilder)
- **Build:**
  - With Online booking & deposits off, the hero's and the nav's "Book a room" read "Call to book" with West 4's number (`phone.callNumber`), the Book section is hidden, Admin → Deposits & cancelling reads "Online booking is off", and the Payment link and Deposit refund texts for new bookings are hidden.
  - Stopping takes no new bookings, while existing ones can still be viewed, changed, cancelled and refunded.
  - Booking routes answer `404 module_off`, except the guest routes for existing bookings (manage, cancel and refund status).
- **Acceptance:**
  - [ ] With the module off, the hero reads "Call to book" with (212) 255-0011.
  - [ ] Jae's manage link still opens, cancels and shows his refund status.
  - [ ] `POST /v1/public/venues/{slug}/bookings` answers `404 module_off`.
- **Tests:** module tests (`404 module_off`; the effects table's row for this module); end-to-end.
- **Notes:** The canvas keeps "Book a room" whatever the modules say ([Main note 2](../screens.md#main)).

### M5-15 · Push hours to Google Business Profile

- **Status:** todo
- **Size:** M
- **Depends on:** M1 (`hours`, `closures`, `integrations`); M4-01 (Admin → Connections)
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) (`hours`); [milestones: Admin by milestone](../milestones.md#admin-by-milestone) (Connections)
- **Build:**
  - Admin → Connections: connect Google Business Profile through Google's own OAuth for the venue's location; an `integrations` row (kind google, status, external_id the location). Until then, Admin shows Google as not connected.
  - A job pushes the weekly hours and every `closures` row (special and closed dates) to the location on every change (`settings.changed` for `hours`, and each closures write), with retries and the last push's status shown in Admin.
  - Nothing pushes while the connection is off.
- **Acceptance:**
  - [ ] With a test location connected, changing Friday's hours updates the location's regular hours, and adding a closed date adds a special-hours entry.
  - [ ] A failed push shows in Admin → Connections and retries.
  - [ ] Before connecting, Admin shows Google as not connected and no job runs.
- **Tests:** integration against Google's Business Profile API with a test location, or a recorded contract test while API access is pending.
- **Notes:** Google grants Business Profile API access on request, an outside wait to start now. Only Google's published API is used.

### M5-16 · Check accessibility: WCAG 2.2 AA in CI and a screen-reader pass

- **Status:** todo
- **Size:** M
- **Depends on:** M5-01 to M5-13; M3 (the room page and ordering); M2 (the waitlist page); M4-16, M4-18 (the bill and Pay my share)
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 14; [screens: N1](../screens.md#n1-booking-steps-after-the-price)
- **Build:**
  - Automated WCAG 2.2 AA checks (axe through Playwright) in CI on every guest page: the homepage, rooms, menu, private parties and the enquiry form, every booking step, the payment page, manage, the waitlist page, the room page and ordering, the bill and Pay my share.
  - Countdowns (the booking hold and the waitlist offer's page) are announced to screen readers, and the booking hold can be extended (M5-07).
  - The menu PDF is tagged.
  - A person does a screen-reader pass with VoiceOver on an iPhone and TalkBack on Android on booking, manage, the waitlist page and ordering, and records the findings; anything that blocks a task is fixed before the milestone closes.
- **Acceptance:**
  - [ ] The automated checks pass in CI, and a new violation fails the build.
  - [ ] The screen-reader pass finds nothing that blocks booking, managing a booking, joining the waitlist or ordering.
- **Tests:** axe in Playwright; a PDF tag check.
- **Notes:** Every room-tablet action also works from a phone or through staff (Security 14).

### M5-17 · Prove Jae & co.'s booking end to end, and the payment page checks

- **Status:** todo
- **Size:** M
- **Depends on:** M5-01 to M5-16
- **Spec:** [milestones: M5 done when](../milestones.md#m5--guest-site-and-online-booking); [Security and data retention](../spec/12-security-retention.md) 1; [demo seed: Bookings tonight](../demo-seed.md#bookings-tonight)
- **Build:**
  - End-to-end suites on the connected sandbox for each done-when line, starting from a seed load without Jae's booking, so a small room is free at 11:00 PM: the clock at Wed Sep 23 (the day the seed says Jae paid) to book and to cancel before the cut-off, and at Fri Sep 25, 10:41 PM to cancel after it.
  - The payment page's header, script and changed-script checks (M4-15) run on the deposit flow.
- **Acceptance:**
  - [ ] Jae & co. (5 guests, Fri Sep 25, 11:00 PM, 2 hours, small tier) see the full price with tax and the 20% gratuity before paying, the accepted policy version is stored, the $50 deposit is paid on our payment origin, and the confirmation text and page agree.
  - [ ] Manage changes the booking and cancels it, and the refund follows the 24-hour rule in New York time: a full refund before Thu 11:00 PM, and the deposit kept after it.
  - [ ] The payment page passes its header, script and changed-script checks.
  - [ ] With Online booking & deposits off, the hero reads "Call to book" with West 4's number, and Jae's manage link still works.
  - [ ] The menu page, the PDF and the room page show the same items and prices, and a hidden item is gone from all three.
  - [ ] The automated accessibility checks pass, and the screen-reader pass found nothing that blocks a task.
- **Tests:** the suites above in CI against the sandbox.
- **Notes:** The seed already holds Jae's booking in Room 3, so this suite's fixture drops it before booking.

## Coverage

Every "Ships" item, done-when line, Admin section and must-fix item of M5 in [milestones.md](../milestones.md#m5--guest-site-and-online-booking), and the tickets that build it.

| Milestone item | Tickets |
| --- | --- |
| Ships: The guest site | M5-01, M5-02, M5-03, M5-04 |
| Ships: Online booking | M5-06, M5-07, M5-08, M5-09, M5-10, M5-11, M5-12, M5-13 |
| Ships: Public forms | M5-05, M5-04 |
| Ships: Google Business Profile | M5-15 |
| Ships: Accessibility | M5-16 |
| Ships: Canvas boards | M5-01, M5-02, M5-03, M5-06, M5-07, M5-11 |
| Done when: A guest books Jae & co.'s booking | M5-07, M5-08, M5-09, M5-10, M5-11, M5-12, M5-17 |
| Done when: The payment page passes its header, script and changed-script checks | M5-09, M5-17 |
| Done when: With Online booking & deposits off | M5-14, M5-17 |
| Done when: The menu page, the PDF and the room page | M5-03, M5-17 |
| Done when: The automated accessibility checks pass | M5-16, M5-17 |
| Admin: Deposits & cancelling | M5-06 |
| Admin: Website | M5-02 |
| Admin: Connections (Google Business Profile) | M5-15 |
| Must-fix: GA-M5 (full price, stored terms, New York refund cut-offs, ready for all-in prices) | M5-01, M5-07, M5-08, M5-10, M5-12 |
| Must-fix: GA-M3 (the opt-in in M5) | M5-08 |
| Nice-to-have: GA-N1 (the enquiry form and big-party booking) | M5-04, M5-13 |

## Open points

Spec gaps met while writing these tickets, each built with the cautious default its ticket names:

- **The plan's size.** These tickets add up to about 30 to 45 working days against milestones.md's 2 weeks.
- **West 4's late-cancel and no-show outcomes** aren't in the seed; the canvas uses keep and keep (M5-06).
- **`noShow: "nothing"`** doesn't say whether the deposit comes back (M5-12).
- **Refund cut-offs across daylight saving:** elapsed hours against wall-clock hours (M5-10).
- **Extending a countdown** (Security 14) has no rule (M5-07).
- **No API routes for `site_versions`** (M5-02), and **no `allIn` wording** (M5-01).
- **West 4's booking limits** (`prices.booking`) aren't in the seed (M5-07).
- **Email-only enquiries** are undecided; the form takes a mobile number (M5-04).
- **SetupIntent events** are missing from the Venue payments endpoint (M5-13).
- **Guest page languages** for phase 1 aren't stated; guest pages ship in English, West 4's setting.
- **Outside waits:** Google's Business Profile API access (M5-15).
