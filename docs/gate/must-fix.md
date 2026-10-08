# Gate items 1 and 4 · the must-fix tracker (M9-14)

Every must-fix item from [milestones](../milestones.md#must-fix-items-and-where-they-close), the milestone that closes it, and the evidence that milestone passed its done-when ([the go-live gate](../milestones.md#the-go-live-gate), items 1 and 4). An item is `closed` only when its milestone's sign-off ticket is `done`, nothing is left under "Waiting on", and it has the date it closed. A unit test (`apps/api/src/ops/gate-docs.test.ts`) checks every evidence link below resolves, and keeps the two gate items unmet until the rows say otherwise.

**Gate item 1 (every must-fix item closed):** not met. 0 of 11 closed (checked Oct 8, 2026).

**Gate item 4 (the outage drill has passed):** not met. M8-07's four drills haven't run at West 4; the report will be `docs/drills/<date>-outage.md` ([outage drill runbook](../runbooks/outage-drill.md), step 4), linked here when it exists.

"Proven locally" means the tests pass on every merge (lint, typecheck, unit and integration against Postgres with row-level security on, and the fake Stripe); it isn't the milestone's done-when on staging, the connected sandbox or at the venue.

## GA-M1 · The card fee (off at West 4)

- **Closed by:** M4 · sign-off [M4-30](../backlog/M4-payments-and-receipts.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** the capped, credit-only surcharge and the cash discount: [surcharge.int.test.ts](../../apps/api/src/routes/surcharge.int.test.ts), [check-totals.test.ts](../../packages/rules/src/check-totals.test.ts) (Money rules 10).
- **Waiting on:** M4-30: staging (M1-02), the connected sandbox and the live payment drill on West 4's two S710s. Stripe's two card-fee questions aren't the gate (the fee is off at West 4).

## GA-M2 · Gratuity and the tip pool

- **Closed by:** M7 · sign-off [M7-20](../backlog/M7-close-the-night-and-books.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** one label ([gratuity-label.test.ts](../../packages/shared/src/i18n/gratuity-label.test.ts)); all of it to eligible staff by duties ([tip-pool.test.ts](../../packages/rules/src/tip-pool.test.ts), [tip-pool.int.test.ts](../../apps/api/src/routes/tip-pool.int.test.ts)); 6-year records ([retention.ts](../../packages/db/src/retention.ts)); no deletes ([grants.int.test.ts](../../packages/db/src/grants.int.test.ts)); the payroll split ([payroll.test.ts](../../packages/rules/src/payroll.test.ts)). M7-20's Notes hold the full evidence table.
- **Waiting on:** M7-19's two weeks of staging nights reconciling to the cent and M7-20's staging walk (staging, M1-02); the lawyer's answers S5, S6 and S7 ([sign-offs](sign-offs.md)).

## GA-M3 · Marketing texts

- **Closed by:** M8 · sign-off [M8-24](../backlog/M8-offline-safety-and-operations.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** STOP and HELP ([sms-keywords.test.ts](../../packages/rules/src/sms-keywords.test.ts), [opt-out.int.test.ts](../../apps/api/src/routes/opt-out.int.test.ts)); the 8 AM to 9 PM window ([marketing-window.test.ts](../../packages/rules/src/marketing-window.test.ts)); the campaign guard ([campaign.int.test.ts](../../apps/api/src/texts/campaign.int.test.ts)); imported consents with their evidence ([imported-consents.int.test.ts](../../apps/api/src/routes/imported-consents.int.test.ts)).
- **Waiting on:** the guest's own unticked opt-in with proof on the booking page: [M5-08](../backlog/M5-guest-site-and-booking.md) is still `todo` (M8-24's Notes count it as built; it isn't). West 4's 10DLC brand and campaign approved and the live checks (M8-22).

## GA-M4 · Tax lines, check numbers, Z reports, no deletes

- **Closed by:** M7 (tax lines and check numbers in M4) · sign-off [M7-20](../backlog/M7-close-the-night-and-books.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** tax by category ([check-totals.test.ts](../../packages/rules/src/check-totals.test.ts)); check numbers in order ([check-number.test.ts](../../packages/shared/src/check-number.test.ts), [checks.int.test.ts](../../apps/api/src/routes/checks.int.test.ts)); dated Z reports that never reopen ([z-report.test.ts](../../packages/rules/src/z-report.test.ts), [night-close.int.test.ts](../../apps/api/src/routes/night-close.int.test.ts)); no deletes ([grants.int.test.ts](../../packages/db/src/grants.int.test.ts)); the tax quarter ([tax-quarter.test.ts](../../packages/rules/src/tax-quarter.test.ts)).
- **Waiting on:** M7-19 and M7-20 on staging (as GA-M2); the accountant's answers S1 and S2 ([sign-offs](sign-offs.md)).

## GA-M5 · Booking shows the whole price and stores the accepted terms

- **Closed by:** M5 · sign-off [M5-17](../backlog/M5-guest-site-and-booking.md) (`todo`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** the deposit policy and its New York-time refund cut-offs ([policy.test.ts](../../packages/rules/src/policy.test.ts), M5-06); the quote and the 10-minute hold ([quote.test.ts](../../packages/rules/src/quote.test.ts), M5-07); price wording on the site ([site.test.ts](../../packages/rules/src/site.test.ts)).
- **Waiting on:** code: M5-08 to M5-17 are `todo` (the guest's details and accepted policy, the deposit on the payment page, confirmation, manage, cancel and no-shows, payment links, the module switch, Google hours, accessibility, and M5-17's proof); M5-05 is `blocked` on the CAPTCHA keys. The lawyer's answer S4.

## GA-M6 · The 4 AM stop, the clear-out check, wall-clock cut-offs

- **Closed by:** M3 · sign-off [M3-25](../backlog/M3-room-orders-and-bar-screen.md) (`done`, one acceptance line open)
- **Status:** open
- **Closed on:** —
- **Proven locally:** [alcohol-window.test.ts](../../packages/rules/src/alcohol-window.test.ts) (through daylight saving), [four-am.int.test.ts](../../apps/api/src/orders/four-am.int.test.ts), [alcohol.int.test.ts](../../apps/api/src/orders/alcohol.int.test.ts), [clear-out.int.test.ts](../../apps/api/src/rooms/clear-out.int.test.ts).
- **Waiting on:** M3-25's mock-Friday line (every order ringing and printing on a network and a USB printer) run by hand in staging; the lawyer's answer S3 on drinking-up time.

## GA-M7 · Cut-offs, refusals and the refusal log

- **Closed by:** M6 (rooms and guests in M3) · sign-off [M6-28](../backlog/M6-bar-pos-tabs-and-bar-mode.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** [cut-off.int.test.ts](../../apps/api/src/rooms/cut-off.int.test.ts), [tab-cut-off.int.test.ts](../../apps/api/src/routes/tab-cut-off.int.test.ts), [escalation.int.test.ts](../../apps/api/src/orders/escalation.int.test.ts), [alcohol.int.test.ts](../../apps/api/src/orders/alcohol.int.test.ts).
- **Waiting on:** M6-28's staging and connected-sandbox lines (staging, M1-02).

## GA-M8 · Offline mode

- **Closed by:** M8 · sign-off [M8-24](../backlog/M8-offline-safety-and-operations.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** [outage-drill.int.test.ts](../../apps/api/src/ops/outage-drill.int.test.ts), [offline-orders.int.test.ts](../../apps/api/src/routes/offline-orders.int.test.ts), [offline-codes.int.test.ts](../../apps/api/src/routes/offline-codes.int.test.ts), [offline-view.test.ts](../../packages/shared/src/offline-view.test.ts), [desktop offline.test.ts](../../apps/desktop/src/offline.test.ts), [desktop queue.test.ts](../../apps/desktop/src/queue.test.ts), [staff offline.test.ts](../../apps/staff/src/offline.test.ts).
- **Waiting on:** M8-07's four drills at West 4 (the router and both S710s installed, M8-02 and M9-07); this is also gate item 4.

## GA-M9 · The security and PCI baseline

- **Closed by:** M8 (sign-in in M1, the payment page in M4) · sign-off [M8-24](../backlog/M8-offline-safety-and-operations.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** [ga-m9-evidence.md](../security/ga-m9-evidence.md) maps all 15 items to code and tests; the principal and venue-wall suites ([principals.int.test.ts](../../apps/api/src/security/principals.int.test.ts), [walls.int.test.ts](../../apps/api/src/security/walls.int.test.ts)).
- **Waiting on:** M8-19: the key-rotation drill on staging, the named breach person and backup, the lawyer's addendum wording (S9); the PCI assessor's answer (S10); M1-02 (staging) is still `doing`.

## GA-M10 · Music licensing

- **Closed by:** M8 (the play log in M6) · sign-off [M8-24](../backlog/M8-offline-safety-and-operations.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** the register and reminders ([licenses.test.ts](../../apps/api/src/licenses/licenses.test.ts), [licenses.int.test.ts](../../apps/api/src/routes/licenses.int.test.ts)); the play log ([song-start.int.test.ts](../../apps/api/src/routes/song-start.int.test.ts)).
- **Waiting on:** West 4's real licenses entered from the paper copies (M8-09).

## GA-M11 · Bar-mode guardrails

- **Closed by:** M6 · sign-off [M6-28](../backlog/M6-bar-pos-tabs-and-bar-mode.md) (`blocked`)
- **Status:** open
- **Closed on:** —
- **Proven locally:** [tabs.int.test.ts](../../apps/api/src/routes/tabs.int.test.ts), [tab-cut-off.int.test.ts](../../apps/api/src/routes/tab-cut-off.int.test.ts), [song-charge.test.ts](../../packages/rules/src/song-charge.test.ts), [song-queue.test.ts](../../packages/rules/src/song-queue.test.ts), [gift-order.int.test.ts](../../apps/api/src/routes/gift-order.int.test.ts), [bar-mode-settings.int.test.ts](../../apps/api/src/routes/bar-mode-settings.int.test.ts), [cash.test.ts](../../packages/rules/src/cash.test.ts).
- **Waiting on:** M6-28's staging and connected-sandbox lines and the staff task timings in staging (staging, M1-02).

## Closing a row

When a milestone's sign-off ticket turns `done`, set its rows to `closed` with the date, replace "Waiting on" with `nothing`, and link the sign-off's evidence (its staging walk, drill reports, reconcile reports). When all eleven are closed, change gate item 1 to met with the date. When M8-07's report is committed, link it above and change gate item 4 to met.
