# O · Owner onboarding

Oct 11, 2026 · the tickets for [Owner onboarding](../spec/17-onboarding.md): a new venue's owner sets the venue up in a wizard, and Admin can change every answer later ([D113](../decisions.md) to [D116](../decisions.md)). Sing Sing is the first venue onboarded this way, so this runs before [S · Sing Sing go-live](S-sing-sing-go-live.md)'s S-01. One ticket per Claude Code session.

**Goal (usable when done):** our Console makes a venue and invites its owner; the owner chooses a plan, connects Stripe, and enters the venue's rooms, prices, hours, deposits, menu, team, contacts and licenses in Set up your venue until it reads Ready to open, and every answer is editable afterwards in Admin.

**Done when:**

- A venue made in the Console from nothing reaches Ready to open in the demo by its owner alone, with no SQL and no ops command.
- Every answer the wizard saved shows, and can be changed, in its Admin section, and the wizard, Admin and the Console's venue list read the same rows.
- Sing Sing's own values (the founder's and its manager's) are entered through the wizard.

**Depends on:** M1 to M8 and K · Kitchen (the Admin routes the wizard reuses). **Size:** about 4 weeks (4 S, 10 M).

## Suggested order

1. **Shell:** O-01, then O-02.
2. **Outside accounts:** O-04 and O-05 (both need the fake Stripe, and the sandbox for staging).
3. **Steps:** O-03, O-06, O-07, O-09, O-10, O-11, O-12, O-13, in any order once O-02 is done; O-08 after O-07.
4. **Proof:** O-14.

Definition of done: see CLAUDE.md.

## Tickets

### O-01 · Console: create a venue and invite its owner

- **Status:** done
- **Size:** M
- **Depends on:** M1-05 (organizations, venues, memberships), M1-19 and M1-23 (enroll and invites), M1-18 (email), the minimal Console (support grants, the venue list)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Who runs it; [Tenancy and access](../spec/02-tenancy-access.md)
- **Build:**
  - `POST /v1/console/venues` (Console staff, audited with who and why): the venue's name, the slug, a new organization's legal name or an existing organization, and the owner's name and email. Creates the rows with America/New_York, the 6:00 AM cutover and the New York rule pack, the core modules on and nothing else allowed, and an `invited` owner membership. Nothing else is filled in.
  - `POST /v1/console/venues/{v}/owner-invite`: emails a 7-day link; Send again ends the old link. Opening it runs the existing enroll path and lands on Set up your venue.
  - The Console's New venue form and the venue list's "Owner invited · not yet signed in" and checklist count.
- **Acceptance:**
  - [x] New venue makes an organization, a venue and an invited owner, and nothing else (no hours, rooms, prices, settings rows or contacts).
  - [x] The owner's link enrolls a passkey and opens Set up your venue; an expired or replaced link is refused with the reason.
  - [x] A slug already taken is refused; a second venue under an existing organization reuses its Stripe account id.
  - [x] Only Console staff can call the routes; every route has a principal test and a venue-wall test.
- **Tests:** integration tests against Postgres with row-level security on; Mailpit for the email; the principal and wall suites.
- **Notes:** replaces the SQL in `scripts/demo-local.sh` for new venues only; West 4's seed is unchanged.
  - Built (Oct 12, 2026): migration `0142_new_venue.sql` (the definer doors `console_create_venue` and `console_organizations`, which refuse anyone who isn't active Console staff; `venue_onboarding` keeps who and why, forced RLS and audited; `invites.replaced_at`); `apps/api/src/console/new-venue.ts` (`GET /v1/console/organizations`, `POST /v1/console/venues`, `POST /v1/console/venues/{v}/owner-invite`); `GET /v1/console/venues` gains each venue's `owner`; the `owner_invite` email (English and Spanish); the Console's New venue form and owner line (`apps/console/src/NewVenue.tsx`). Tests: `apps/api/src/console/new-venue.int.test.ts` (rows, nothing else, slug, shared Stripe account, Mailpit, the invite path to a passkey, replaced and expired links, Console staff only, the venue wall) and `e2e/console.spec.ts`.
  - The "existing enroll path" is the staff invite (M1-23): a texted phone code, the PIN, then a passkey with the code the invite hands back. The spec's "an emailed code" is how `/v1/auth/enroll` starts without an invite; nothing new was added.
  - The owner's invite is sent from the venue in the Console, not by New venue itself, so a wrong email can be fixed before anything is sent. A link refused after Send again reads "A newer link was sent · open the newest email".
  - The venue's owner membership starts with a 6-digit PIN and English; the owner picks the language on the invite.
  - No second approver: spec 17 doesn't ask for one on New venue (M8-11's rule covers the emergency actions only).
  - The checklist count on the Console's venue list comes with O-02, which builds the checklist it reads.
  - The e2e specs' `select id from venues limit 1` now name West 4 by slug, since a run can hold more than one venue.


### O-02 · Build the wizard shell: steps, progress, save and resume, skip, the checklist

- **Status:** done
- **Size:** M
- **Depends on:** O-01; M1-31 (the Admin shell)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · How it behaves, What's required before Ready to open; [screens: Setup](../screens.md#setup)
- **Build:**
  - Set up your venue in the staff app (phone and desktop): the rail of 12 steps with done, needs attention, skipped and not started marks; "Step N of 12", "N of 12 done"; Back, Continue, Skip for now, Save and finish later.
  - `GET /setup` works out each step's state from the saved rows (never its own copy), and the required list per plan; `POST /setup/finish` stamps `venues.setup_completed_at` and turns on the modules the owner ticks through `PATCH /modules/{id}`.
  - Signing in opens the first step not done until finished; Admin → Setup keeps the checklist; a manager sees it read-only.
  - Empty step bodies for O-03 to O-13 to fill.
- **Acceptance:**
  - [x] Saving a step and signing in on another device opens the next step not done.
  - [x] A skipped required step shows "Needed before you open"; Finish setup is refused, listing each missing step with a link.
  - [x] The Console's venue list and Admin → Setup show the same count as the wizard.
  - [x] English and Spanish; touch targets of at least 44 px; loading, empty and error states.
- **Tests:** unit tests for the required list per plan; integration tests for `GET /setup` and `POST /setup/finish`; a Playwright test of save and resume.
- **Notes:**
  - Built (Oct 12, 2026): `packages/shared/src/setup.ts` (the 12 steps, the required list per plan, each step's mark from facts; unit tests in `setup.test.ts`); migration `0143_setup.sql` (`venues.setup_completed_at`, `venue_setup_skips` with forced RLS and audit); `apps/api/src/routes/setup.ts` (`GET /setup`, `POST /setup/skip`, `POST /setup/finish`; the facts are read from each step's own rows and settings keys); `/v1/auth/me` says `setup: "pending"` on a venue made in the Console until Finish setup; the Console's venue list shows "Setup · N of 12 done"; the staff app's `/set-up` and `/set-up/:step` wizard and Admin → Setup (`apps/staff/src/screens/admin/SetUpVenue.tsx`). Tests: `apps/api/src/routes/setup.int.test.ts`, `apps/api/src/console/new-venue.int.test.ts` (the Console's count is the wizard's), `e2e/setup.staff.spec.ts` (save, skip, leave and resume), `e2e/console.spec.ts`.
  - Skip for now needs a record that lasts across devices, so it's the one thing the wizard keeps of its own (`venue_setup_skips`, a new `POST /setup/skip`); a step's rows still decide done.
  - Cautious default: before a plan is started, the Rooms plans' required list applies (rooms and deposits required); a step drops off only once the plan says it isn't used.
  - "N of 12 done" counts done steps plus those the plan doesn't use (Bar: rooms and deposits).
  - Signing in opens the wizard only for an owner, in a passkey session, on a venue made through the Console's New venue (`venue_onboarding`) and not finished; West 4's seed never sees it. Save and finish later goes to the owner's home, not back to the wizard.
  - Finish setup stamps the venue, then turns on the ticked guest-facing modules (Online booking & deposits, Guest texts, Website, where the Console allows them) through `PATCH /modules/{id}`, as Admin → Features does.
  - Step bodies say what each step asks and open the Admin section where it lives (whose saves count here at once) until O-03 to O-13 put the forms in; Your plan and Card payments have no Admin link yet (O-04, O-05).
  - Facts read for steps whose keys arrive later: `contacts` (O-03 and O-11) is read from the raw saved value; the texts step counts a Twilio integration row as answered until O-12.
  - Not built: a Console support-grant view of the wizard's state (spec 17 · Who runs it); the Console has no venue-screen reader yet. It belongs with a later Console ticket.
  - Formatting fix: the O-01 commit left three e2e specs unformatted; Prettier ran on them here.


### O-03 · Step 1, Your venue, and Admin → Venue with the booking inbox

- **Status:** done
- **Size:** S
- **Depends on:** O-02; M2-10 (Admin → Phone & texts), M1-18 (email)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 1; [Settings](../spec/03-settings-rule-packs-modules.md) · `contacts`
- **Build:**
  - The step's form and Admin → Venue (owner): the venue's name, the address, the legal name, the guest phone and `contacts.bookingEmails` (up to 3).
  - An address outside New York is refused with "contact us"; the time zone and rule pack never change here.
  - A copy of each new online booking, change, cancellation and enquiry goes to the booking inbox, with no card data; empty sends none.
- **Acceptance:**
  - [x] The step's answers show in Admin → Venue and Admin → Phone & texts, and changing them there changes the checklist.
  - [x] A new online booking sends one email to each booking inbox address (Mailpit), and none when empty.
  - [x] No EIN field exists anywhere in our forms or tables.
- **Tests:** integration tests; Mailpit; a venue-wall test for `contacts`.
- **Notes:**
  - Built (Oct 12, 2026): `GET` and `PUT /v1/venues/{v}/profile` (`apps/api/src/routes/venue-profile.ts`; the owner's, passkey; name, legal name and address; migration `0144_venue_profile.sql` grants only those columns); the `contacts` settings key (spec 03, D115) read and saved by the owner alone, naming only active owners or managers, empty until saved (`CONTACTS_EMPTY`); the booking inbox job (`apps/api/src/bookings/inbox.ts`, `booking.inbox`) queued from a confirmed online booking, a guest's change, a guest's cancellation and a party enquiry, sending the `booking_inbox` email once per address; Admin → Venue and step 1's form (`apps/staff/src/screens/admin/Venue.tsx`; Continue and Save and finish later save it). Tests: `apps/api/src/routes/venue-profile.int.test.ts` (Mailpit, owner-only, the wall, no EIN column), `packages/shared/src/venue-profile.test.ts`, `e2e/setup.staff.spec.ts`, and the Spanish check in `e2e/staff.spec.ts` now covers Admin → Venue and Admin → Setup.
  - Cautious default: "outside New York" is read as outside New York City (state NY and a city ZIP code: 100 to 104, 110 to 114, 116), since the rule pack is New York City's tax and hours. A venue elsewhere in the state is refused with "contact us" until the founder says otherwise.
  - `phone.textNumber` may now be empty (null): a new venue has no texting number until our team makes it (`twilio:subaccount`), and the wizard never fills one in. Spec 03's `phone` row says so. Admin → Phone & texts shows "Not set yet" and handles a venue with no numbers saved.
  - The booking inbox's copy is in English (the inbox belongs to no one person) and carries the guest's name, the party, the time and the room only. A venue's own cancellation (a blocked date) isn't copied; only the guest's online booking, change, cancellation and enquiry are.
  - Admin → Venue is owner-only through a new `ownerOnly` flag on the Admin section list, without a new permission row.


### O-04 · Step 2, Your plan: three plans, a promo code and Stripe Checkout

- **Status:** done
- **Size:** M
- **Depends on:** O-02; M8-15 (plan billing); the fake Stripe
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 2; [Settings](../spec/03-settings-rule-packs-modules.md) · Plan billing; [D94](../decisions.md), [D114](../decisions.md)
- **Build:**
  - What you run and the three plan cards, their prices read from Stripe by lookup key; a missing key reads "Not available yet".
  - `GET /plan/promo?code=` against our platform account's active Promotion Codes; `POST /plan/checkout` makes a Checkout Session in subscription mode (the billing key, the Customer, the plan and per-room Prices, the promotion code), idempotency-keyed per attempt, never inside a transaction.
  - `checkout.session.completed` added to the Our billing endpoint; it and `customer.subscription.updated` write `venue_subscriptions` and set `venue_modules.allowed` from the plan; the reconciler checks a session left open.
  - The fake Stripe learns Checkout Sessions and Promotion Codes, and seeds one 100%-off-for-a-month code for tests only.
- **Acceptance:**
  - [x] Choosing Rooms with the test promo code and finishing Checkout on the fake Stripe starts a subscription with a first invoice of $0.00 and the room count, and allows the Rooms modules.
  - [x] An unknown or expired code reads "That code isn't valid" and Checkout isn't offered with it.
  - [x] With a lookup key missing, Start plan is off and nothing is sent to Stripe.
  - [x] The Bar plan allows no room module, and the Rooms step is skipped.
  - [x] No price or promo code is written in our code or settings.
- **Tests:** integration tests on the fake Stripe; webhook signature tests; a Playwright test of the step.
- **Notes:**
  - Built: migration `0145_plan_checkout.sql` (the attempt keeps its Checkout Session and promotion code id; `ingest_stripe_event` finds a `checkout.session.*` event's venue by that session, never metadata; grants for the plan change, the new subscription id and the organization's billing Customer); `apps/api/src/routes/plan-checkout.ts` (`GET /plan/prices`, `GET /plan/promo`, `POST /plan/checkout`, the owner's only); `apps/api/src/billing/checkout.ts` (the session applied the same way from `checkout.session.completed` or the reconciler job `billing.checkout`, queued for 5 minutes after the session expires: complete starts the plan, expired ends the attempt so the next Start plan gets a new key); the staff step `apps/staff/src/screens/admin/PlanStep.tsx`; the fake Stripe's Coupons, Promotion Codes (one seeded test-only code, `FAKEFIRSTMONTH`, 100% off for one month), Checkout Sessions and their hosted page, and new subscription items.
  - `GET /plan/prices` is new (the spec's Routes now names it): the plan cards read the Prices from it at page load.
  - Cautious default: the plan sets the allow-list only for the modules spec 17's table names (Bar: bar tabs, bar mode, bar screen; Rooms adds rooms, online booking, room ordering, packages, song system, waitlist; Rooms + Kitchen adds kitchen). Team, safety, reports, guest and marketing texts and the website stay as our Console sets them, because the spec doesn't say which plan allows them (the blueprint lists texts, reports and team in Bar). A module the venue has on is never disallowed by a plan change until it's turned off, as the Console's own switch does. Founder to confirm.
  - Settled Oct 12 by common practice (D121): the plan now also includes Team & tip pool, Guest texts and Reports (the blueprint's Bar row), and choosing a plan switches on every module it includes (`planSwitchesOn` in `packages/shared/src/modules.ts`, `allowPlanModules` in `apps/api/src/billing/checkout.ts`): all of them for a first plan, only the added ones on a change, so the owner's off in Admin → Features stays off. Bar tabs waits for the go-live merchant category (and Bar mode with it) and Kitchen & food for its printer and allergy notice. Marketing texts, Safety and the website stay with our Console. Tested in `plan-checkout.int.test.ts` and `modules.test.ts`.
  - Checkout leaves the per-room item out while the venue has no rooms (Stripe Checkout takes no zero quantity); the room-count job adds it with the first room, with its own idempotency key.
  - A customer.subscription.updated after a change in Stripe's portal now moves the plan, its room item and the allow-list too.
  - The "No price or promo code in our code" line is checked by `apps/api/src/stripe/no-plan-prices.test.ts`, which reads every app and package source (tests and the fake aside).
  - Tests: `apps/api/src/billing/plan-checkout.int.test.ts` (7, incl. the bad signature and the reconciler), `packages/shared/src/modules.test.ts`, and the Playwright test in `e2e/setup.staff.spec.ts`.

### O-05 · Step 3, Card payments: Connect with Stripe

- **Status:** done
- **Size:** M
- **Depends on:** O-02; M4-01 (the Stripe client, `stripe:create-account`), M4-03 (webhooks)
- **Spec:** [Stripe setup](../spec/06-stripe-setup.md) 1, 2 and 10; [Owner onboarding](../spec/17-onboarding.md) · Step details 3
- **Build:**
  - `POST /payments/stripe/connect` (owner): creates the organization's Accounts v2 account when it has none, with the legal name and the owner's email (one idempotency key per organization), then an Account Link to Stripe's hosted onboarding; the return URL comes back to the step.
  - The step's states from `account.updated`: Not connected, Waiting for Stripe…, Stripe needs more from you, Connected · card payments on; a second venue of the organization shows Connected through its organization.
  - Once card payments are on, the payment-method domain and the Terminal Location are made, as `stripe:create-account` does today.
- **Acceptance:**
  - [x] Connect with Stripe on the fake Stripe makes one account, and pressing it twice makes no second account.
  - [x] `account.updated` with card payments enabled marks the step done; without, the step needs attention with Continue with Stripe.
  - [x] No key is pasted or stored from the owner; only `organizations.stripe_account_id`.
- **Tests:** integration tests on the fake Stripe and, in staging, the sandbox; the wall suite for the new route.
- **Notes:**
  - Built: `apps/api/src/routes/stripe-connect.ts` (`GET` and `POST /payments/stripe/connect`, the owner's only: the account made with the legal name and the owner's own email under the ops command's key `org:{id}:create-account`, then an Account Link whose return and refresh URLs come back to `/set-up/card`); `apps/api/src/stripe/connect.ts` (after `account.updated` says card payments are on: the payment page's domain, then the Terminal Configuration and Location); migration `0146_stripe_connect.sql` (the owner's role may set `organizations.stripe_account_id`; the route sets it only while it's empty); the staff step `apps/staff/src/screens/admin/CardStep.tsx` (Not connected, Waiting for Stripe…, Stripe needs more from you with Continue with Stripe, Connected through the organization).
  - Cautious default: the Terminal Location needs the venue's tip screen (`pay.tipScreen`), which we never choose for it. Until the owner saves it, card payments on registers only the payment page's domain, and the Location is made at the first reader's registration as before (M4-02). A local payment page host (localhost) is never registered.
  - "Connected through {legal name}" shows for every venue, not only a second one: the account is always the organization's, and a venue's API role can't see the organization's other venues.
  - Admin → Payments still has its own Continue onboarding link (M4-01); it now works for owner-connected accounts too.
  - Staging's sandbox run is left for the go-live checks (the fake covers the flow here).
  - Tests: `apps/api/src/routes/stripe-connect.int.test.ts` (5) and the Playwright test in `e2e/setup.staff.spec.ts`; the wall and principal suites cover the new routes.

### O-06 · Steps 4 and 5: rooms and prices, hours, kitchen times, the age policy

- **Status:** done
- **Size:** M
- **Depends on:** O-02; M2-04 (Admin → Rooms), M2-03 (time bands), Admin → Hours, K-01 (`kitchen`), the age policy (D108)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 4 and 5; [Settings](../spec/03-settings-rule-packs-modules.md) · `prices`, `hours`, `kitchen`, `safety`
- **Build:**
  - The steps reuse Admin's forms and routes: rooms (name, size, capacity, bookable online), the rate mode, billing step, minimum guests, happy-hour bands, the VIP rate; weekly hours and last call; `kitchen.lastOrder` and the new optional `kitchen.opensAt`; the age policy, confirmed even at its default.
  - The Food Protection Certificate line under the kitchen times (D120); nothing enforces it.
- **Acceptance:**
  - [x] Six rooms with sizes, capacities and rates saved in the wizard show in Admin → Rooms and Admin → Prices, and the plan's room quantity is 6.
  - [x] A last call later than the rule pack's close is refused with the reason.
  - [x] `kitchen.opensAt` empty means the kitchen opens with the venue; the kitchen fields hide without the Kitchen module allowed.
  - [x] No capacity, rate or time is filled in for the owner.
- **Tests:** integration tests; unit tests for `kitchen.opensAt` with the kitchen's ordering window; a Playwright test of both steps.
- **Notes:**
  - Built: the wizard's `RoomsStep.tsx` (rooms through Admin → Rooms' `POST /rooms` and `PATCH /rooms/{r}` with the shared `AddRoom`; the prices through Save, Admin's own Prices form once a `prices` key exists, a first-time form otherwise) and `HoursStep.tsx` (the weekly hours and last call, Admin's own Hours form once saved; `KitchenTimes`, now shared with Admin → Kitchen, only with Kitchen & food allowed; the age policy, picked by the owner with no choice preselected). Each step saves through `PUT /settings` like Admin's Save, so the rule pack's reason (a last call after the last sale) shows under the step. `AdminDraft.save()` now says whether it saved.
  - `kitchen.opensAt` (optional, absent or null opens with the venue): `beforeKitchenOpens` in `packages/rules`, the kitchen's new stop `not_open` (food refused with "The kitchen isn't open yet", "Kitchen not open yet · opens {time}" on the kitchen switch), `GET /kitchen` returns `opens_at`.
  - Nothing is filled in: Admin → Rooms' Add a room no longer suggests 3 to 6 guests (both capacity fields start empty, here and in Admin); every price, guest count and time starts empty.
  - Cautious defaults: the `prices` key can't be saved in parts, so the first save also asks the booking limits and the damage fee (start times left open: any half hour); a new venue's safety key starts from spec 03's 90% warning with no occupancy limit; Admin → Rooms shows "Not set yet" for the cleaning settings of a venue that has none (it used to hang loading). The spec's step 4 now says so.
  - Rooms & room clock must be on for Admin → Rooms' routes; the step offers "Turn on Rooms & room clock" (the same `PATCH /modules/rooms` as Admin → Features). Settled Oct 12 (D121): the plan switches Rooms & room clock on, so the step's "Turn on Rooms & room clock" button is gone; if the owner turns Rooms off afterwards, the step says to turn it on in Admin → Features.
  - For O-07 / later: Admin → Hours still fills 4:00 PM to 4:00 AM when a new day is first typed there; Admin → Hours, Prices and Safety still can't start from nothing (the wizard does that).
  - Tests: `apps/api/src/routes/setup-rooms-hours.int.test.ts` (4: six rooms make the room quantity 6 in Stripe, the refused last call, opensAt, nothing filled in), `packages/rules/src/kitchen-last-order.test.ts` (opensAt with the ordering window), and the Playwright test in `e2e/setup.staff.spec.ts` (steps 4 and 5).

### O-07 · Step 6: deposits, card holds and the four walk-in choices

- **Status:** todo
- **Size:** S
- **Depends on:** O-02; M5-12, M5-13 (deposits and card holds), D112's walk-in setting
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 6; [Settings](../spec/03-settings-rule-packs-modules.md) · `DepositRule`
- **Build:**
  - The step reuses Admin → Deposits & cancelling: the online deposit or card hold, free-cancel hours, late-cancel and no-show, grace minutes, big parties, the largest party online.
  - At a walk-in check-in offers Take a deposit, Put a card on the tab, Keep the card behind the bar (built in O-08) and Nothing, in Admin too.
- **Acceptance:**
  - [ ] Each of the four choices saves and shows the same in Admin → Deposits & cancelling.
  - [ ] Deposits off with Put a card on the tab saves, as Sing Sing's row in venue.md reads.
- **Tests:** integration tests; the Spanish strings.

### O-08 · Keep the card behind the bar at a walk-in check-in

- **Status:** todo
- **Size:** M
- **Depends on:** O-07; M2-11 (check-in and walk-ins), M4 (close-out), M7 (Close the night)
- **Spec:** [Staff screens](../spec/10-staff-screens-bar-pos.md) · Check in; [Settings](../spec/03-settings-rule-packs-modules.md) · `DepositRule.walkIn`; [D116](../decisions.md)
- **Build:**
  - `deposit.walkIn: "cardBehindBar"`. After Seat them, the check-in asks for the name on the card and its last 4 digits (exactly 4 digits) and saves them on the room's check (`check_held_cards`: name, last 4, taken by, taken at, returned by, returned at; forced row-level security and a venue-wall test). No reader, no Stripe call, nothing charged.
  - The room tile and the room's check show "Card behind the bar · M. TORRES ···· 4242"; close-out ends with "Give the card back" and Returned; a room moved keeps its card.
  - Close the night lists any card not returned ("Cards still behind the bar"); the name and last 4 are cleared at the business date's close, keeping only who took and returned it and when.
  - Skip the card is allowed, with the reason, like D112's.
- **Acceptance:**
  - [ ] With Keep the card behind the bar, a walk-in check-in saves the name and last 4 and nothing reaches Stripe.
  - [ ] A field that isn't 4 digits is refused; a full card number is never accepted anywhere.
  - [ ] Close-out asks to give the card back, and Close the night lists a card not returned.
  - [ ] After the close, the name and last 4 are gone from the row.
- **Tests:** integration tests against Postgres with row-level security on; the wall suite; a Playwright test of a walk-in from check-in to close-out; a log test that the name and last 4 never reach a log.

### O-09 · Step 7: the cash discount, food and the card fee, gratuity and drawers

- **Status:** todo
- **Size:** S
- **Depends on:** O-02; M4 (the card fee), M7 (drawers), K-10 (food tax)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 7; [Money rules](../spec/05-money-rules.md) rule 10
- **Build:**
  - The step reuses Admin → Payments and Admin → Cash drawers. New: `pay.cardFee.foodIncludesFee` in discount mode; with false, the discount never applies to kitchen items.
- **Acceptance:**
  - [ ] Write the money cases first: a cash discount on a mixed drinks and food check, with `foodIncludesFee` true and false, rounding half up, the parts adding up.
  - [ ] The step's answers show in Admin; a drawer change starts at the next business date.
- **Tests:** unit tests in `packages/rules` from the new `seed/money-cases.json` group; integration tests.

### O-10 · Step 8: the menu by hand, by spreadsheet or by request

- **Status:** todo
- **Size:** M
- **Depends on:** O-02; M3-04 (Admin → Menu), M9-04 (the menu importer), M2-13 (uploads), K-08 (the allergy notice)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 8
- **Build:**
  - Type items in Admin → Menu's editor; upload a spreadsheet that runs M9-04's importer as a dry run the owner checks before saving; or upload a PDF or photo that becomes a Console request for our team.
  - The open points the importer couldn't settle listed on their items; pour sizes and Draft (D105); the allergy notice field.
- **Acceptance:**
  - [ ] Sing Sing's menu file from `docs/venues/sing-sing/import/` loads through the step as a dry run, then saves on "Looks right".
  - [ ] A PDF upload saves nothing to the menu and shows in the Console.
  - [ ] The step is done with one item with a price.
- **Tests:** integration tests; a Playwright test of the spreadsheet path.

### O-11 · Step 9: team invites and the venue's on-call and breach contacts

- **Status:** todo
- **Size:** M
- **Depends on:** O-02; M1-23 (invites), M1-31 (Admin → Team), M8-17 (paging runbooks), M8-19 (the breach runbook)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 9; [D115](../decisions.md)
- **Build:**
  - Invites through `POST /team/invite`; the list shows who has set a PIN.
  - `contacts.onCall` (first and second, with days and hours) and `contacts.breach` (primary and backup), owner only, in the step and Admin → Venue → Contacts; only an active owner or manager can be picked; deactivating one clears the slot and flags the checklist.
  - Our runbooks and the Console's venue page show the venue's contacts; the breach notice goes to the owner and the breach contact.
- **Acceptance:**
  - [ ] Inviting a manager by phone sends the invite; the step is done once a manager has set a PIN and both contacts are named.
  - [ ] Deactivating the breach contact empties the slot and the checklist needs attention.
  - [ ] Our platform rota (`oncall_rota`) is untouched by anything here.
- **Tests:** integration tests; the wall suite for `contacts`; Spanish strings.

### O-12 · Steps 10 and 11: licenses, texts registration, website and the old system's files

- **Status:** todo
- **Size:** M
- **Depends on:** O-02; M8-09 (licenses), M2-09 (the Twilio subaccount), M8-22 (the campaign check), M9-01 (the importer), M9-09 (the domain move)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 10 and 11
- **Build:**
  - The license register in the step (the liquor license required; food permit and Food Protection Certificate holders with a kitchen; music licenses warn).
  - Register for texts: the 10DLC form sends the brand registration to Twilio on the venue's subaccount, idempotency-keyed, never inside a transaction; the EIN is sent once and never stored or logged; before the subaccount exists the step says so.
  - The website question and the old system's files (`POST /files`), each becoming a Console request.
- **Acceptance:**
  - [ ] The liquor license saved in the wizard shows in Admin → Licenses with its reminder.
  - [ ] Register for texts against Twilio's test credentials sends one registration, and the EIN appears in no table and no log.
  - [ ] Uploaded export files show in the Console for our team; nothing is imported until the owner signs the dry run.
- **Tests:** integration tests with Twilio test credentials; a log test for the EIN.

### O-13 · Step 12: devices, the go-live checks and Finish setup

- **Status:** todo
- **Size:** S
- **Depends on:** O-02; M1-15 (pairing), M3-13, M3-14 (printers), M4-02 (readers), M4-29 (the go-live checklist)
- **Spec:** [Owner onboarding](../spec/17-onboarding.md) · Step details 12
- **Build:**
  - What's paired, linked to Admin → Printers & devices; the M4-29 checklist for any venue; the song system (`none` without a partnership); the checklist and Finish setup.
- **Acceptance:**
  - [ ] With a simulated reader registered, a receipt printer with a drawer paired and the merchant category set, the step is done.
  - [ ] Finish setup with every required step done stamps the venue and turns on only the modules ticked.
- **Tests:** integration tests on the fake Stripe's simulated readers; a Playwright test.

### O-14 · Onboard a new venue from scratch in the demo, then enter Sing Sing's values

- **Status:** todo
- **Size:** M
- **Depends on:** O-01 to O-13
- **Spec:** [Owner onboarding](../spec/17-onboarding.md); [Sing Sing](../venues/sing-sing/venue.md)
- **Build:**
  - A Playwright test from a fresh demo seed: the Console makes "Test Karaoke" and invites its owner; the owner enrolls, picks Rooms + Kitchen with the test promo code, connects the fake Stripe, enters 3 rooms, hours, deposits, a walk-in choice, a menu, one manager, contacts and a liquor license, pairs a simulated reader and a virtual printer, and reaches Ready to open; then a walk-in is checked in and closed out on the new venue.
  - A runbook section in `docs/venues/sing-sing/venue.md` for entering Sing Sing's own values through the wizard (the founder's and the manager's), each marked entered or still to give.
- **Acceptance:**
  - [ ] The test passes from a fresh seed with no SQL and no ops command, and West 4's demo night is unchanged.
  - [ ] Every value Sing Sing has given is entered through the wizard on staging, and the checklist lists only what its manager still owes.
- **Tests:** Playwright; the principal and wall suites still pass with the new venue present.
