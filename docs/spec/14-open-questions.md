## Open technical questions

Twenty-nine questions are open: 8 for Stripe, 4 for the founder, 2 for Playbox, 3 for the accountant, 11 for the lawyer and 1 for a PCI assessor. "Blocks" names the [milestone](../milestones.md) whose work depends on the answer. Until the answer comes, that milestone builds it as a setting with the cautious default, so only one question stops a milestone from starting: M4 needs the entity and our Stripe platform account. "Gate" marks the answers that must be in before the go-live gate.

| Question | Why it matters | Who answers | Blocks |
| --- | --- | --- | --- |
| Can a server-driven reader payment change its amount between collect and confirm, and show the guest the new total? | The card fee at the reader | Stripe | M4 (not the gate: the card fee is off at West 4) |
| Can a surcharge follow a hold that grows, or must those tabs close with a fresh tap? | Bar tabs at venues with the card fee on | Stripe | M6 (not the gate: the card fee is off at West 4) |
| Is a tip added on the reader or receipt part of the surcharged amount? | Card fee math and receipts | Stripe, then the lawyer | M4 (not the gate) |
| Which Accounts v2 features we use are on stable API versions, since Stripe's examples use preview versions? | How often we must upgrade, and what can break | Stripe | M4 |
| Which merchant category fits each venue type: bar, restaurant or recreation? | Tips on the receipt and Discover's growing holds depend on it | Stripe, per venue | M4 (the go-live checklist, before bar tabs turn on) |
| Does a reader switch to cellular when the Wi-Fi stays up but the internet behind it is down? | The first outage-drill case | Stripe, and our own drill | M8 (the outage drill) |
| Does a card that's collected but not yet confirmed carry its fingerprint and cardholder name, so a second tab on the same card can be refused before any hold? | One open tab per card | Stripe | M6 |
| Does a tip the guest picked through collect_inputs, with no signed slip, hold up as well as a signed receipt when the tip is disputed? | Tips on the reader for held tabs | Stripe | M6 |
| Which company entity, under which product name, holds our Stripe platform account and signs venue contracts? | Stripe opens the platform account for the entity; plan billing, venue contracts and insurance follow | Founder, with the lawyer (a blueprint decision) | M4 can't start without it; plan billing (M8) too |
| Should phase 2 add a native app for store-and-forward card payments? | Card payments when the line and LTE are both down | Founder, with engineering (a blueprint decision) | Nothing in phase 1; decide early in phase 2 |
| What does a song cost at West 4 without a drink credit? | Until it's set, every song needs a credit ("Song price · not set · songs need a drink credit") | Founder | Nothing: M6 ships it unset, and Admin → Bar mode can set it any time |
| Which paging tool, if any, should carry our pages, and who are the first and second responders (with the hours they cover)? | M8-17 built paging vendor-neutral: CloudWatch alarms and RDS events reach our own alarm hook, and the API emails (and, with a phone on the rota, texts) the first responder, then the second after 10 minutes unacknowledged. A paging vendor (PagerDuty, Opsgenie, incident.io) adds phone calls and app pushes. The rota is empty until it's set (`oncall:set`). | Founder | The go-live gate: a second responder must be on the rota before the 4-week gate starts (spec 13 · On call) |
| Will Playbox open its room controls and supply its song catalog? | Song control and song search for West 4 | Playbox and Sing Sing Media | Nothing in phase 1: West 4 runs as `none`, and the song-search section shows only its heading and song count (M5) until a catalog arrives |
| Does a switched outlet on one room's wireless-mic receiver affect Playbox's equipment warranty? | The one-room mic power trial (K1), which uses only our own hardware and never touches the player | Playbox | The trial in M8, which also needs West 4's written approval (not the gate) |
| Is a card surcharge part of the taxable sale, and does a cash discount lower the taxable amount? | Tax lines when the card fee is on | Accountant | M4 (not the gate: the card fee is off at West 4) |
| Are room time, damage fees, kept deposits and no-show charges taxable, is the gratuity exempt, and does each kept deposit need its own check number? | Tax lines on every check | Accountant (a blueprint decision) | M4 builds the cautious default · gate |
| Which business date gets sales made after midnight on the nights a sales-tax quarter ends (Nov 30, Feb 28 or 29, May 31, Aug 31)? | The quarterly return | Accountant | M7 (the tax-quarter report) · gate |
| How is drinking-up time measured: from the county close (4 AM) even when the house last call is earlier, and for how long? | The 4:30 AM clear-out check and when open tabs are charged | Lawyer | M3 (the clear-out check) and M6 (the tab cut-off) · gate |
| How does New York treat debit cards under a cash discount? | Whether a debit card pays the card price or the cash price | Lawyer | M4 (not the gate: the card fee is off at West 4) |
| Do NYC's proposed junk-fee rules cover an automatic gratuity? | How the site and the booking page word prices (`website.priceWording`) | Lawyer | M5 · gate |
| When does the private-function exception cover a drink package? | Packages that rely on it, flagged on the booking | Lawyer | M3: until then the promotion checks refuse such a package |
| Is a free drink with a song ("buy a song, get a drink") allowed? The site runs the reverse offer, "Buy a drink, get a song", built as a $0.00 song credit; the owner confirms which offer this question is about | A free drink with a song, which the promotion checks refuse until then | Lawyer | M6 |
| Can gratuity refunded after a pool was paid out come off the next pool? | Refunds and tip pools | Lawyer | M7 · gate |
| Which occupations share tips at West 4, in what shares, and is checking tip-credit coverage our report or payroll's job? | Tip eligibility and the payroll export | Lawyer | M7 · gate |
| May the automatic room gratuity be pooled by hours across all eligible staff, given that 146-2.18 ties a gratuity to the employees who provided the service? | The default pool method | Lawyer | M7 · gate |
| Are review-ask and birthday texts marketing? | Which texts need a marketing opt-in | Lawyer | Nothing: both stay off until they have their own opt-in |
| How long may scanned ID fields be kept, may they be shared (is handing them to NYPD "dissemination" under §65-b?), and may a banned list use them? | `id_checks`, its delete job and the safety module | Lawyer (a blueprint decision) | M2 builds the 7-day default · gate |
| In training mode, what may a trainee do with room sessions, bookings, the waitlist, room orders and approvals? The cautious default (M7-03): no checking in a real booking, seating a real waitlist party or changing a live room's state; a practice session on a free room blocks nothing and only screens in training see it; practice approvals go to the manager marked TRAINING and never count. A practice session also can't be joined by a phone or tablet at a real venue, so the staff trial's rush driver (M9-11) can place its room orders only on a test venue until this is answered. | Practice must never touch live rooms or real guests | Founder | M9 (the staff trial) |
| Who tells whom after a breach, as written into the data processing addendum? | The breach runbook | Lawyer | M8 · gate |
| Who is the named person who runs the breach runbook, and who backs them up (M8-19)? | `docs/security/breach-contacts.md` | Founder | M8 · gate |
| Which PCI validation do we file, and what script-protection confirmation do we give venues? | Our own PCI status | PCI assessor (QSA) | M4 (the payment page) · gate |

**Closed**

| Question | Decision | Decided |
| --- | --- | --- |
| Which languages do staff screens launch in? | English and Spanish in phase 1, picked by each person; Korean and Chinese in phase 2 ([Tenancy and access](02-tenancy-access.md)) | Sep 28, 2026, in the fix brief |

**For later phases** (not counted above): does Yonkers' cabaret law cover karaoke (the lawyer, for a venue in Yonkers); does PHL §1356 apply to bars with kitchens (the lawyer, for the kitchen module in phase 2); and must a Food Protection Certificate holder be on site after the kitchen closes (the health department, for the kitchen module). The blueprint's other founder decisions (plan prices, support hours, SOC 2 timing and the order of song-system adapters) don't change what phase 1 builds, so they stay in its [Open decisions](../blueprint.md#open-decisions).
