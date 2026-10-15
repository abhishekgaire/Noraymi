# To do: what needs a person

Last gathered Oct 11, 2026.

**Where things stand.** Most of phase 1's software is built and tested on a laptop: M1 to M8 and the Kitchen tickets are done apart from the ones listed below, and every one of those is waiting on a person, not on code. Nothing has run on staging yet, because staging has not been switched on (M1-02).

**Oct 11 answers.** The founder's notes of Oct 11 are kept below as quotes. Most venue setup is now done by each venue's owner in [owner onboarding](spec/17-onboarding.md) ([D113](decisions.md) to [D120](decisions.md)), so Sing Sing's manager items moved to section 9, "Done in onboarding by the owner".

**What's on this list.** On Oct 11 the founder asked that any question the venue's own website, common practice or a manager's setting can answer be settled that way ([D102](decisions.md) to [D108](decisions.md)). So everything below needs a person: a legal or tax answer, an account or key, money, hardware, people, or a signature. Where the app already does something safe while it waits, the item says so ("Until then").

Each item has a box to tick, what to do, what it unblocks (ticket IDs like `M8-17`, and must-fix IDs like `GA-M2` from [the must-fix tracker](gate/must-fix.md)), and where it's written down.

## Do these first

These five unblock the most work.

- [ ] **Switch on staging.** Run `terraform plan`, then `terraform apply`, in `infra/staging` from your laptop with the admin profile, following [infra/README.md](../infra/README.md) "First time" (it includes filling the secrets and publishing the GitHub variables). Unblocks M1-02 and through it almost every `blocked` ticket: M4-30, M5-17, M6-28, M7-19, M7-20, M8-15, M8-16, M8-19, M8-20, M8-21, M9-15, and must-fix GA-M1 to GA-M11.
- [ ] **Send the three sign-off letters** (accountant, lawyer, PCI assessor). They're written and ready in [sign-off-requests.md](gate/sign-off-requests.md); fill in the names and dates, send them, and mark the rows `sent` in [sign-offs.md](gate/sign-offs.md). All ten (S1 to S10) are `not sent` today. Unblocks M9-13 and gate item 2.
- [ ] **Open the outside accounts and give us their keys:** our Stripe platform account and its test keys (first decide which company holds it) and the CAPTCHA keys. No Twilio account of ours is needed: each venue connects its own ([D123](decisions.md)). Unblocks M4-30, M5-05, M5-17, M8-15, M8-22 and the CAPTCHA in M2-27. Details in section 2.
- [ ] **Name our own people on call:** a first and a second responder from our side (Console staff) with the hours each covers, and the person (plus a backup) who runs our breach runbook. Each venue's own on-call and breach contacts are now its owner's to name in onboarding ([D115](decisions.md)); these two are ours, for platform alarms. Unblocks M8-17, M8-19, M9-16 and the 4-week gate.
- [ ] **Set Sing Sing's hardware and first live night:** order and install its hardware, and pick the date of its first live night. Sing Sing goes live first ([D98](decisions.md)), so this starts the whole go-live clock. See [S · Sing Sing go-live](backlog/S-sing-sing-go-live.md) S-07 and S-12.

## 1. You (the founder): decisions

- [ ] **Which company holds our Stripe platform account and signs venue contracts, under which product name?** Decide with the lawyer. Stripe opens the platform account for that company, and plan billing, venue contracts and insurance follow it. Unblocks M4's live work and M8-15 (plan billing). Recorded in [open questions](spec/14-open-questions.md).
  > Founder: "we facilitate the store owner have to do the setup with the stripe secret and publishable key when they do onboarding"

  Settled in chat: the owner presses **Connect with Stripe** in onboarding and fills in Stripe's own form; no key is pasted ([D113](decisions.md), [Stripe setup](spec/06-stripe-setup.md) 2). Connect still needs our own platform account, so the company question stays open.
- [ ] **Who are the first and second responders on call, and which hours does each cover?** The paging tool is already settled (email and text, [D102](decisions.md)); only the people are missing. Then run `oncall:set` and send a test page. Unblocks M8-17, M9-16 and the gate (a second responder must be on the rota before the 4 weeks start). Until then: the rota is empty and the check fails. Recorded in [open questions](spec/14-open-questions.md) and [oncall-rota.json](gate/oncall-rota.json).
  > Founder: "same here the owner will have to decide this while onboarding"

  Done for each venue's own responders ([D115](decisions.md), onboarding step 9). This item is now only our own platform rota (our staff, who get the platform's pages), which a venue owner can't fill.
- [ ] **Who runs the breach runbook, and who backs them up?** Unblocks M8-19 and GA-M9. Recorded in [breach-contacts.md](security/breach-contacts.md).
  > Founder: "same again owner decides onboarding"

  Done for each venue's breach contact ([D115](decisions.md)); this item is now only our own side of the breach runbook.
- [x] **What plan does Sing Sing pay?** Its owner picks one of the three plans at onboarding, with an optional 1-month-free promo code ([D114](decisions.md)).
  > Founder: "have 3 tier plans but also have promo code for 1 month free. And the owner again decides while onboarding."
- [ ] **Make the plans and the promo code in Stripe** once our platform account exists: the Prices under D94's lookup keys at $149, $249 + $12 a room and $349 + $12 a room, and a Coupon of 100% off for one month with its Promotion Code (you choose the code). Unblocks O-04 in staging and M8-15.
- [x] **Plan prices, and whether West 4 is billed during the gate.** Decided for now ([D114](decisions.md)): the blueprint's proposed prices; West 4 and Sing Sing pick their plan and can use the promo code like any venue; D94's read-only list stays. Tell us if you'd change any of it. Until then: no price exists anywhere; Prices live only in Stripe under fixed names once you make them ([D94](decisions.md)). Also confirm which Admin changes stay allowed while an unpaid venue is read-only. Unblocks M8-15. Recorded in [M8](backlog/M8-offline-safety-and-operations.md) M8-15.
  > Founder: "you create it if i dont like i'll tell you"
- [x] **Support hours:** 9 AM to 5 PM Eastern, weekdays ([D117](decisions.md)); paging still covers every opening hour.
  > Founder: "9-5 est weekdays"
- [x] **Should phase 2 add a native app that can take card payments with no internet at all?** Blocks nothing in phase 1; decide early in phase 2. Yes, early in phase 2 ([D118](decisions.md)).
  > Founder: "yes"
- [x] **Approve the Sing Sing go-live plan.** The file still says "Awaiting the founder's approval". Approved; the file now says so.
  > Founder: "yes approved"
- [ ] **Buy a domain (or decide which one).** For now staging and new venues use test addresses ([D119](decisions.md)); this stays open until you buy it. Without one, staging uses `*.cloudfront.net` addresses, and Apple Pay and Google Pay can't be checked on the payment page. Recorded in [infra/README.md](../infra/README.md) "Not yet" and M4's Notes.
  > Founder: "for now lets use testing i'll get the domain soon"
- [ ] **Fixed internet addresses for Stripe's IP-locked keys?** A NAT gateway costs about $35 a month; it's a spending decision. Until then: keys aren't locked to our addresses. Recorded in [infra/README.md](../infra/README.md) "Not yet", M4-01 and M8-19.
- [ ] **Choose the venue router and its cellular carrier** (any Peplink with InControl 2, [D102](decisions.md); the carrier must differ from the card readers'). Unblocks M8-02, M8-07 and M9-07. Recorded in M8's "Waiting on the founder" list.
- [ ] **Turn on branch protection on GitHub for `main`?** It makes failing checks block a merge (M1's principal and wall suites, M4-30's chaos suite), but it also stops pushing straight to `main`, which is how work lands today. Recorded in [M1](backlog/M1-foundations.md) and M4-30.
- [x] **Edit CLAUDE.md's approvals rule.** "Approvals are decided on the approver's own phone" is now a venue setting ([D124](decisions.md)): on the manager's phone (the default), a manager's PIN at the register, or no approval. Done: CLAUDE.md's rule now says approvals are a venue setting.
- [ ] **Pick an email provider** (any service with an SMTP relay) and put its address in staging's `smtp-url` secret, plus our own addresses in `email_allow_list`. Until then: staging sends no email. Recorded in [M1](backlog/M1-foundations.md) (the email ticket's Notes).
- [ ] **Should cash sales work while the bar computer is offline?** Built as the venue setting **Take cash quick sales while offline** (U-16, [D133](decisions.md)), **off by default**, so the drawer stays locked offline as spec 09 says. Turned on, queue mode also takes cash quick sales of drinks, opens the drawer with each one and puts each sale on the books once when the connection returns; one the server refuses (say, a beer sold at 3:55 AM and replayed after 4:00 AM) is flagged for the manager and the cash stays in the drawer. Decide whether it should be on for Sing Sing and West 4, and how a refused sale should be posted.


## 2. You: accounts, keys and setup to run

- [ ] **Apply staging** (`terraform plan` then `terraform apply` in `infra/staging`, then `infra/scripts/seed-secrets.sh` and `publish-github-vars.sh`). This also applies the monitoring, paging, backups and replica parts. Unblocks M1-02, M8-16, M8-17, M8-19, M8-20, M8-21. Recorded in [infra/README.md](../infra/README.md).
- [ ] **CAPTCHA keys** (Cloudflare Turnstile): a site key and a secret key for staging, later for production, and confirm the daily limits per phone number, address and device. Unblocks M2-27 and M5-05. Recorded in [M2](backlog/M2-rooms-and-board.md) M2-27 and [M5](backlog/M5-guest-site-and-booking.md) M5-05.
- [ ] **Stripe test keys for the connected sandbox**, put in staging's secrets. Then the booking proof and the close-out proof run there. Check that the payments key has Files (write) and Disputes (write) permission. Unblocks M5-17, M4-30, M6-28. Recorded in M5-17 and M4's dispute ticket Notes.
- [ ] **Our Stripe platform account** (after the company decision), with the billing key `STRIPE_KEY_BILLING`, the platform webhook secret, the billing endpoint and the plan Prices; then the test-clock run on staging. Unblocks M8-15.
- [ ] **West 4's Stripe account**, made with `stripe:create-account` (M4-01/M4-29); its owner then finishes Stripe's own onboarding with the legal name and tax number (EIN). New venues such as Sing Sing make theirs with Connect with Stripe in onboarding (O-05).
- [ ] **Radar fraud rules, added by hand** in each live venue Stripe account. Recorded in [radar.md](security/radar.md) and M8-19.
- [ ] **Twilio: each venue sets up its own account** ([D123](decisions.md)). We hold no Twilio account for venues. Each venue's owner or manager opens a Twilio account, buys a number, registers its 10DLC brand and service campaign in Twilio's console (legal name, EIN, address), turns on SMS pumping protection and US-only geo permissions, makes a messaging service and connects it in Admin → Phone & texts, following [texts-10dlc.md](runbooks/texts-10dlc.md). For **Sing Sing**: its owner or manager does this (S-05); for West 4, West 4's owner. Until a venue is Approved its texts stay off and codes and invites go by email. Unblocks M8-22 (GA-M3) and S-05. Optional for us: `PAGING_TWILIO_*` only if you want our own on-call pages by text as well as email.
- [ ] **Google Business Profile:** get API access for our Google Cloud project, make an OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` in staging's secrets), and have the owner sign in with the Google account that manages the listing. Unblocks M5-15. Recorded in [M5](backlog/M5-guest-site-and-booking.md) M5-15.
- [ ] **Error tracking: nothing to buy unless you want to.** Errors and dashboards stay in CloudWatch; an outside tracker (Sentry or any OpenTelemetry service) is only a setting ([D102](decisions.md), M8-16). Decide only if you want one.
- [ ] **Set `MONEY_AUDIT_TO`** to your address so the morning money check reaches you. Unblocks M9-15, M9-16.
- [ ] **Run the drills on staging** once it's up: the key-rotation drill (M8-19, [key-rotation.md](runbooks/key-rotation.md)), the first restore drill (M8-20, [restore-drill.md](runbooks/restore-drill.md)), the 20-venue load test on a staging copy (M8-21), 14 nights reconciled to the cent (M7-19), and the staging walk for M7-20.

## 3. The lawyer

Questions S3 to S9 are in the lawyer's letter in [sign-off-requests.md](gate/sign-off-requests.md); the rest are in [open questions](spec/14-open-questions.md). Each answer must come in writing. Two more are shared: the company entity (section 1) and the tip-on-surcharge question (section 5, after Stripe).

- [ ] **S3. How is drinking-up time measured, and for how long?** Unblocks GA-M6 (M3) and the tab cut-off (M6). Until then: 30 minutes from the earlier of 4 AM and the house's last call.
- [ ] **S4. Do NYC's proposed junk-fee rules cover an automatic gratuity?** Unblocks GA-M5 (M5). Until then: prices read "plus tax and gratuity".
- [ ] **S5. Can gratuity refunded after a tip pool was paid come off the next pool?** Unblocks GA-M2 (M7). Until then: the house absorbs it.
- [ ] **S6. Which jobs share tips, in what shares, and is the tip-credit check our job or payroll's?** Unblocks GA-M2 (M7). Until then: one pool split by minutes worked; payroll export flags shifts under the tip credit.
- [ ] **S7. May the automatic room gratuity be pooled by hours across all eligible staff?** Unblocks GA-M2 (M7). Until then: pooled by hours.
- [ ] **S8. How long may scanned ID details be kept, may they be shared (with NYPD, for example), and may a banned list use them?** Until then: kept 7 days, encrypted, then deleted; never shared.
- [ ] **S9. Who tells whom after a data breach (the wording for the data processing addendum)?** Unblocks GA-M9 (M8-19). Until then: we tell the venue owner within 72 hours; the venue tells guests and the state.
- [ ] **Sing Sing's cash discount (about 3.5%): is it allowed under GBL §518, and how must the cash price be shown** on the menu, room page, bill and receipt? Non-blocking since [D125](decisions.md): turning the discount on is the owner's choice (Sing Sing's is on) and the cash and card prices show as built; the lawyer's answer is advice on the display. Recorded also in [menu.md](venues/sing-sing/menu.md).
- [ ] **Kitchen allergy notice (PHL §1356): does it apply, and what are the exact words** for the room page, room tablet, website menu and menu PDF? Non-blocking since [D125](decisions.md): Sing Sing's notice is its own wording ("Allergen information for menu items is available. Ask an employee for details."), entered by its owner, so its food doesn't wait; the lawyer's answer is a check.
- [ ] **Kitchen note wording and how long a kitchen note may be kept.** Until then: the draft "Allergies or notes for the kitchen", kept as long as the order.
- [ ] **How does New York treat debit cards under a cash discount?** Card fee only; not the gate (the card fee is off at West 4).
- [ ] **When does the private-function exception cover a drink package?** Until then: the promotion checks refuse such a package (M3).
- [ ] **Is a free drink with a song allowed?** First confirm with the owner which offer is meant (the site runs "Buy a drink, get a song"). Until then: refused (M6).
- [ ] **Are review-ask and birthday texts marketing?** Blocks nothing: both stay off.

## 4. The accountant

S1 and S2 are in the accountant's letter in [sign-off-requests.md](gate/sign-off-requests.md).

- [ ] **S1. Are room time, damage fees, kept deposits and no-show charges taxable, is gratuity exempt, and does each kept deposit need its own check number?** Unblocks GA-M4. Until then: room time, drinks and damage taxed; kept deposits, no-show charges and gratuity untaxed; each kept deposit its own check.
- [ ] **S2. Which business date gets after-midnight sales on the night a tax quarter ends?** Unblocks GA-M4. Until then: the business date (the night before), shown on its own line.
- [ ] **Sales tax on prepared food sold in rooms and at the bar in NYC, and how to split a package that mixes food, drinks and room time.** Until then: food at the drinks rate; packages split by regular price (K-10).
- [ ] **Is a card surcharge taxable, and does a cash discount lower the taxable amount?** Not the gate at West 4, but it matters for Sing Sing's cash discount.

## 5. Stripe

All in [open questions](spec/14-open-questions.md).

- [ ] **Which merchant category fits each venue** (bar, restaurant or recreation; Sing Sing has a kitchen)? Needed for the go-live checklist before bar tabs turn on (M4-29, M4-30, S-01).
- [ ] **Which Accounts v2 features we use are on stable API versions?** (M4)
- [ ] **Does a reader switch to cellular when the Wi-Fi stays up but the internet behind it is down?** Our own outage drill 1 answers it (M8-07); you record the answer.
- [ ] **Does a card that's collected but not confirmed carry its fingerprint and name**, so a second tab on the same card can be refused? (M6)
- [ ] **Does a tip picked on the reader, with no signed slip, hold up in a dispute?** (M6)
- [ ] **Can a server-driven reader payment change its amount between collect and confirm?** Card fee only; not the gate.
- [ ] **Can a surcharge follow a hold that grows?** Card fee only; not the gate.
- [ ] **Is a tip added on the reader part of the surcharged amount?** (then the lawyer). Not the gate.

## 6. Playbox

- [ ] **Will Playbox open its room controls and supply its song catalog?** Blocks nothing in phase 1: West 4 runs without song control, and song search shows only its heading. Never scraped: partnerships only.
- [ ] **Does a switched outlet on one room's mic receiver affect Playbox's equipment warranty?** Needed, with West 4's written approval, for the one-room mic power trial (M8-23, not the gate). Recorded in [mic-power-trial.md](runbooks/mic-power-trial.md).

## 7. The PCI assessor (QSA)

- [ ] **S10. Which PCI validation do we file, and what script-protection confirmation do we give venues?** Unblocks GA-M9 (M8-19). Until then: the draft says SAQ P2PE for the readers and SAQ A online. In the QSA letter in [sign-off-requests.md](gate/sign-off-requests.md); draft in [pci-responsibility.md](security/pci-responsibility.md).

## 8. Health department (DOHMH)

- [x] **Must a Food Protection Certificate holder be on site whenever food is served, and after the kitchen closes?** Yes ([D120](decisions.md)); a staffing rule onboarding states, not one the software enforces.
  > Founder: "yes"

## 9. Done in onboarding by the owner (Sing Sing)

> Founder, on each item: "Again the owner should do this during onboarding and admin should be able to change this from the admin page as well"

These are now entered by Sing Sing's owner in [Set up your venue](spec/17-onboarding.md) once O-01 to O-13 are built and S-01 creates the venue ([D113](decisions.md)), and each stays editable in Admin. The website's facts are gathered in [venue.md](venues/sing-sing/venue.md) and the menu in [menu.md](venues/sing-sing/menu.md) for the owner to confirm. The step each lands in is in brackets.

- [ ] **Confirm every fact from the website** (name, address, phone, hours, happy hour, card holds, no-show grace of 15 minutes) in [venue.md](venues/sing-sing/venue.md). (Steps 1, 4, 5, 6)
- [ ] **Choose a plan**, with the promo code if it has one. (Step 2)
- [ ] **Legal name, EIN and address**: the legal name and address in step 1; the EIN only in Stripe's form (Connect with Stripe, step 3) and in Twilio's own console when Sing Sing registers its texting brand (step 11), never stored by us.
- [ ] **Sing Sing's own Twilio account**, opened and registered by its owner or manager and connected in step 11 (or Admin → Phone & texts), following [texts-10dlc.md](runbooks/texts-10dlc.md) ([D123](decisions.md), S-05). Until it reads Approved, Sing Sing's texts stay off and its staff's codes and invites go by email. (Step 11; Admin → Phone & texts)
- [ ] **Rooms: the 6 rooms, their sizes and their hourly rates**, and the happy-hour rates. (Step 4; Admin → Rooms and Admin → Prices)
- [ ] **Opening hours, last call, kitchen hours and the kitchen's last-order time.** Until then: food can be ordered while room ordering is open. (Step 5; Admin → Hours and Admin → Kitchen)
- [ ] **Age policy:** "All ages until 8:00 PM, then 21 and over" ([D108](decisions.md)). (Step 5; Admin → Safety)
- [ ] **Card-hold details:** the free-cancel hours, the late-cancel or no-show fee, the largest party that can book online, and what a walk-in check-in takes: a deposit, a card on the tab, **keep the card behind the bar** ([D116](decisions.md)) or nothing. (Step 6; Admin → Deposits & cancelling)
  > Founder: "At sing sing they actually take the physical cards on tab so that option should be available too."
- [ ] **The cash discount rate, and whether food prices include the card fee.** Until then: 0, off (and it waits on the lawyer too, section 3). (Step 7; Admin → Payments)
- [ ] **Menu open points** ([menu.md](venues/sing-sing/menu.md), "Open points") and **draft beers and pour sizes** ([D105](decisions.md)). (Step 8; Admin → Menu)
- [ ] **The staff list** (names, phones, roles) as invites; each person sets their own PIN on their own phone (S-04). (Step 9; Admin → Team)
- [ ] **The venue's on-call responders and breach contact** ([D115](decisions.md)). (Step 9; Admin → Venue → Contacts)
- [ ] **License papers:** liquor license, food service permit and Food Protection Certificate holders, with numbers, expiry dates and copies (S-06). (Step 10; Admin → Licenses)
- [ ] **Texts registration (10DLC)** (S-05). (Step 11)
- [ ] **Whether Sing Sing has a website and domain to move, and which domain** (S-10). (Step 11)
- [ ] **The old system's export files** (bookings, deposits, guests and consents), received from Sing Sing, never scraped (S-02). (Step 11)
- [ ] **Which inbox gets booking emails.** (Step 1; Admin → Venue)

## 10. West 4 (for later, after Sing Sing)

- [ ] **The old system's export files** (bookings, deposits, guests and consents, menu, team), then the dry run signed by the owner. Unblocks M9-01 to M9-06 and gate item 3. Recorded in [import-dry-run.md](gate/import-dry-run.md).
- [ ] **License papers** (ASCAP, BMI, SESAC, GMR and the liquor license: numbers, holders, expiry, fees, conditions and PDF copies). Unblocks M8-09 and GA-M10.
- [ ] **Legal name, EIN and address** for the 10DLC registration (M8-22).
- [ ] **Written approval naming one room** for the mic power trial (M8-23, not the gate).
- [ ] **Real opening hours and the song price** (Admin → Hours, Admin → Bar mode). Until then: the song price is empty, so every song needs a drink credit ([D106](decisions.md)).
- [ ] **The old site's full page list** (from Wix, Search Console and analytics) for the redirects, then the DNS switch on move day. Unblocks M9-09. Recorded in [domain-move.md](runbooks/domain-move.md).
- [ ] **The owner signs in to Google** with the account that manages West 4's listing (M5-15).

## 11. On-site work

- [ ] **Install and pair the hardware**, first at Sing Sing (S-07: 6 room tablets, readers at every pay point, bar and front-desk printers and drawers, the kitchen network printer, badge readers, the router), then at West 4 (M9-07: two computers, two badge readers, two receipt printers and drawers, two Stripe S710 readers, 14 room tablets, the Up next TV, the router). Checklist in [hardware-install.md](runbooks/hardware-install.md).
- [ ] **Cellular signal check at every pay point** on a busy night ([cellular-check.md](runbooks/cellular-check.md)).
- [ ] **The live payment drill** on both S710s, with forced timeouts and refunds (M4-30, [live-payment-drill.md](runbooks/live-payment-drill.md)).
- [ ] **The four outage drills** at each venue, closed hours, about two hours (M8-07, S-08, gate item 4, GA-M8). Needs both managers' phones ready for Tap to Pay. Runbook: [outage-drill.md](runbooks/outage-drill.md).
- [ ] **The one-room mic power trial**, after both approvals; you choose an outlet that meets the runbook's list (M8-23, [mic-power-trial.md](runbooks/mic-power-trial.md)).
- [ ] **Everyone sets their own PIN and badge** on their own phone (M9-08, S-04, [pins-and-badges.md](runbooks/pins-and-badges.md)).
- [ ] **Train the team in training mode**, with the checklists in [training-checklists.md](trial/training-checklists.md) (M9-10, S-09).
- [ ] **The timed staff trial** with the rush script (M9-11, S-09, [rush-script.md](trial/rush-script.md)).
- [ ] **Find a fluent Spanish speaker** to review every staff screen and sign it off (M9-12; Sing Sing adds the kitchen words). Pack in [spanish-review.md](gate/spanish-review.md).
- [ ] **Find someone with an iPhone and an Android phone** to do the screen-reader pass on staging (VoiceOver and TalkBack). Unblocks M5-16, M5-17 and GA-M5. Checklist in [M5](backlog/M5-guest-site-and-booking.md) M5-16.
- [ ] **The mock Friday by hand on staging**, with every order ringing and printing on a network and a USB printer (M3-25, GA-M6). Script in [mock-friday.md](mock-friday.md).
- [ ] **Go live:** the go or no-go checklist the day before, then the first live night with you at the venue (M9-16, S-12, [go-live.md](runbooks/go-live.md)).
- [ ] **Run 4 weeks of live nights without a money error**, first at Sing Sing, then at West 4 ([D106](decisions.md); M9-17, S-12).

## Count

Open items only; ticked items stay above as the record of the founder's answers.

| Group | Open items |
| --- | --- |
| Do these first (also listed below) | 5 |
| 1. You: decisions | 11 |
| 2. You: accounts, keys and setup | 11 |
| 3. The lawyer | 14 |
| 4. The accountant | 4 |
| 5. Stripe | 8 |
| 6. Playbox | 2 |
| 7. The PCI assessor | 1 |
| 8. Health department | 0 |
| 9. Done in onboarding by the owner | 16 |
| 10. West 4 | 7 |
| 11. On-site work | 13 |
| **Total (groups 1 to 11)** | **87** |
