# S · Sing Sing go-live

**Awaiting the founder's approval**, with [K · Kitchen](K-kitchen.md); the [Kitchen and food](../spec/16-kitchen.md) spec it builds on was approved on Oct 9, 2026 (D98–D100).

Oct 9, 2026 · West 4 asked that the system go live first at **Sing Sing Karaoke, Astoria (Queens, NY)**, then at West 4 ([D98](../decisions.md)). Sing Sing has the same rules, managers and kind of rooms and bar as West 4, with 6 rooms and a kitchen. This file lists the go-live work that must be done again for Sing Sing. Each ticket points at the West 4 ticket it repeats and follows that ticket's Build and Acceptance with Sing Sing's own data; the M4, M8 and M9 tickets themselves don't change.

Sing Sing's legal name, EIN, licenses, menu, prices, hours, domain and team are entered by its managers (Admin, Stripe's own onboarding, the Twilio registration and Admin → Team) after the build. Nothing here invents them; where a fact is missing, the screen shows its "not set" hint.

**Goal (usable when done):** Sing Sing runs live nights on the system, then West 4 follows with its own M9.

**Depends on:** M1 to M8 and K · Kitchen. **Size:** about the same as M9's, 2 weeks, then the gate.

## Suggested order

1. **Day one, outside waits:** S-01 (venue and Stripe account), S-05 (10DLC), S-06 (licenses), and book S-07 (hardware) and S-09 (training and trial).
2. **Imports:** S-02, then S-03.
3. **People and hardware:** S-07, then S-04 and S-09.
4. **Drills and go-live:** S-08, S-10, S-11, then S-12.

Definition of done: see CLAUDE.md.

## Tickets

| Ticket | Redoes | What's different at Sing Sing | Status |
| --- | --- | --- | --- |
| S-01 · Set up Sing Sing as a venue with its own Stripe account | M4-01 (`stripe:create-account`), M4-29 (the go-live checklist) | A new organization and venue (6 rooms, America/New_York, the New York rule pack), the Kitchen module on once K-01's conditions are met; its managers finish Stripe's own onboarding with Sing Sing's legal name and EIN; the merchant category is asked of Stripe for a venue with a kitchen | todo |
| S-02 · Import Sing Sing's bookings, deposits, guests and consents | M9-01, M9-02, M9-03 | A mapping file for Sing Sing's old system, received from Sing Sing (never scraped); if it has no export, Sing Sing exports by hand | todo |
| S-03 · Import Sing Sing's menu with stations and food | M9-04 | Each item's station (bar or kitchen) and tax category, its packages with food, and the promotion checks; the menu comes from Sing Sing, never written by us. K-11's food night already loads `docs/venues/sing-sing/import/` through the importer into the e2e test venue and sells from it (stations, food, choices); the real import into Sing Sing's venue is still this ticket | todo |
| S-04 · Get Sing Sing's team their own PINs and badges | M9-05, M9-08 | People and roles only; runners for the kitchen's food; managers shared with West 4 hold a membership at each venue | todo |
| S-05 · Put Sing Sing's texts live on its own 10DLC campaign | M8-22; `twilio:subaccount` | Its own Twilio subaccount and number, and its own campaign registration; texts stay off until it's approved | todo |
| S-06 · Enter Sing Sing's licenses in the license register | M8-09 | Its liquor license and, for the kitchen, its food service permit and Food Protection Certificate holders, entered by its managers with renewal dates | todo |
| S-07 · Install and pair Sing Sing's hardware, and check the cellular signal | M9-07 | 6 room tablets, its readers at every pay point, its bar and front-desk printers and drawers, the kitchen printer (a network printer), badge readers and the router | todo |
| S-08 · Run the four outage drills at Sing Sing | M8-07 | Plus the kitchen printer going offline, a kitchen ticket printed at the bar, and AFTER OUTAGE on replayed food | todo |
| S-09 · Train Sing Sing's team and run the timed staff trial | M9-10, M9-11, M9-12 | The rush script adds food orders, Picked up and a failed kitchen ticket; the Spanish review covers the kitchen strings | todo |
| S-10 · Move Sing Sing's website and domain | M9-09 | Only if Sing Sing has a site and domain to move; which domain is Sing Sing's to say | todo |
| S-11 · Collect Sing Sing's sign-offs | M9-13, M9-14 | The kitchen questions in [Open technical questions](../spec/14-open-questions.md) (the allergy notice, food tax, the Food Protection Certificate) on top of the gate's ten | todo |
| S-12 · Go live at Sing Sing and run its live nights | M9-15, M9-16, M9-17 | On-call covering Sing Sing's opening hours, and the reconcile script every night; whether the gate's 4 weeks run here, at West 4 or at both is open with the founder | todo |

West 4's own M9 then runs as written, after Sing Sing, reusing what Sing Sing proved.
