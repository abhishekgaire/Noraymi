# M4 · Payments and receipts

Sep 29, 2026 · the backlog for milestone M4 of the [phase 1 milestones](../milestones.md#m4--payments-and-receipts). One ticket is one Claude Code session of 1 to 3 days, except where it says L. Build what the [spec](../spec/README.md) says; where a canvas board differs, [screens](../screens.md) says what to build instead, and the [demo seed](../demo-seed.md) gives every name and number the tests check.

**Goal (usable when done):** Room checks close out by tap, card on file, cash, split and Pay my share, with receipts.

**Depends on:** M3; our entity and Stripe platform account; West 4's Stripe onboarding; both S710s registered to West 4's Location.

**Size:** 3–4 weeks in milestones.md. The 30 tickets below are 7 S, 22 M and 1 L: about 52 to 78 working days (S ≤ 1 day, M 2–3 days, L 4–5 days). See [Open points](#open-points) for what that means for the plan.

Definition of done: see CLAUDE.md.

## Done when

Copied from [milestones.md](../milestones.md#m4--payments-and-receipts):

- The chaos tests pass: the API is killed between Stripe's success and our commit, and the reconciler adopts or cancels the payment, so nobody is charged twice. Timeouts, a reader dropping mid-payment and missing webhooks all end in a known state.
- On the connected sandbox, Room 9 closes out as the seed says ($618.60 total, −$120.00 deposit, $498.60 to pay) three ways: one tap; 12 Pay my share payments of $41.55; and an even split with one share in cash. Every split adds up to the cent. Accepting the ringing margaritas after [Present the check] writes revision 2 with the numbers in [Money rules](../spec/05-money-rules.md).
- Small live payments on West 4's own account are captured and refunded on both S710s, with no double charge under forced timeouts.
- A refund Andy asks for waits in Abhishek's inbox, can't go over what was captured (Marcus's cap is $120), and shows "Refunded" only after Stripe confirms.
- A dispute opened in the sandbox shows in the inbox with its evidence already gathered.
- A receipt reads the same printed, texted, emailed and on the public page.
- Tests prove the prepaid-value ledger balances through issue, redeem, expire and refund, and that a merged pair of sessions keeps both deposits and holds on one check.
- The go-live checklist passes for West 4.

## Suggested order

The IDs run in build order. Tickets on the same line can run side by side once the line before is done.

1. Stripe and the payment core: M4-01 → M4-02, M4-03 → M4-04 → M4-05.
2. Checks: M4-06 → M4-07 → M4-08, M4-09 → M4-10 (staging now has real sandbox deposits).
3. Ways to pay: M4-11 → M4-12; M4-13, M4-14; M4-15 → M4-16 → M4-17, M4-18 → M4-20.
4. After payment: M4-19; M4-21 → M4-22; M4-23; M4-24.
5. The rest of the money rules: M4-25 → M4-26; M4-27; M4-28.
6. Going live: M4-29 → M4-30.

## Every ticket

These come from the spec and apply to every ticket below, on top of the definition of done:

- Money routes take an `Idempotency-Key` and answer with the error codes the [API](../spec/08-api.md) names (`over_amount_due`, `payment_unknown`, `reader_busy`, `reader_offline`, `version_conflict` and the rest).
- Every new route, job and webhook joins M1's principal suite and venue-wall suite.
- Nothing calls Stripe, Twilio or the email provider inside a database transaction.
- Every amount comes from `packages/rules` in integer cents; screens only show it.
- Every change writes its `venue_events` row in the same transaction; screens refetch on the event.
- Every staff string is in the English and Spanish catalogs, and staff and guests see the [glossary's](../glossary.md#other-exact-sentences) words exactly.
- "Now" and the business date come from the venue's clock (America/New_York, 6:00 AM cutover), never the device's.

## Tickets

### M4-01 · Create West 4's Stripe account and a pinned Stripe client

- **Status:** done
- **Size:** M
- **Depends on:** M1 (settings, Admin shell, the `integrations` table, secrets, audit); outside: our company entity and Stripe platform account
- **Spec:** [Stripe setup](../spec/06-stripe-setup.md) steps 1, 2, 7 and 8; [Security and data retention](../spec/12-security-retention.md) 5; [Tenancy and access](../spec/02-tenancy-access.md) (`resolve_stripe_account`, who sees Payments); [Open technical questions](../spec/14-open-questions.md) (Accounts v2 on stable versions); [screens: AdminDesk notes 21 and 28](../screens.md#admindesk), [N37](../screens.md#n37-admin--payments-disputes-and-unmatched-payments)
- **Build:**
  - One Stripe client in `apps/api` for the whole codebase: one pinned API version; a restricted key per service (payments and Terminal; refunds; read-only reporting; billing, used only on our own account), read from the secrets manager; `Stripe-Account` taken only from `organizations.stripe_account_id` for the request's venue. A lint rule stops any other module from importing the Stripe SDK.
  - The live or sandbox choice lives in this client only, so M7's training mode can route practice requests to the sandbox in one place.
  - An audited ops command for our staff, `pnpm --filter api stripe:create-account --org <id>`, that calls `POST /v2/core/accounts` with `display_name` "West 4 Boho Karaoke", `contact_email`, `dashboard: "full"`, `identity` (country us, entity_type company, `business_details.registered_name`), `configuration.merchant.capabilities.card_payments.requested: true` and `defaults` (currency usd; `responsibilities.fees_collector` and `losses_collector` both stripe), and stores the id in `organizations.stripe_account_id`.
  - Admin → Payments (owner only, passkey session): "Connect with Stripe" opens Stripe's hosted onboarding for the account; the account's status (card payments enabled, what Stripe still needs) from `account.updated` (routed by M4-03) into the `integrations` row (kind stripe); a banner whenever Stripe needs more information; a link to the venue's Stripe Dashboard; and payouts as Stripe lists them (date, amount, status), read-only through the reporting key.
  - Admin → Connections: Stripe, Twilio and email, each with its status from `integrations`. No Yelp or Homebase items.
  - Calls leave only from our fixed egress IPs (the keys are IP-restricted); a key-rotation runbook with at most 7 days of overlap.
- **Acceptance:**
  - [x] On the connected sandbox, the ops command creates West 4's account with `fees_collector` and `losses_collector` set to stripe, and `organizations.stripe_account_id` holds it.
  - [x] Every Stripe request made for West 4 carries West 4's account id; a request running as venue B can never send West 4's id (venue-wall test).
  - [x] The refunds key can't create a PaymentIntent, the reporting key can't write, and the billing key is never sent with `Stripe-Account`.
  - [x] After onboarding, Admin → Payments shows card payments enabled; a sandbox account with requirements due shows the banner.
  - [x] Abhishek (owner) sees Admin → Payments; Andy (manager) doesn't, and no PIN session reaches it.
  - [x] CI fails if any API version other than the pinned one appears outside the Accounts v2 module and the surcharge path (M4-25).
- **Tests:** unit (account and key choice per service); integration on the connected sandbox (create the account, receive `account.updated`); principal suite (Payments owner only); venue-wall suite (account ids).
- **Notes:** M4 can't start until our entity and platform account exist, the one question that stops a milestone ([Open technical questions](../spec/14-open-questions.md)). Which Accounts v2 features are on stable versions is open with Stripe; cautious default: pin one stable version for everything and confine preview versions to the Accounts v2 calls and the surcharge path, each in its own module. Setup's "Connect with Stripe" (step 7) is phase 2, so the button sits in Admin → Payments. Matching payouts to payments (`payouts`, `payout_lines`) and Unmatched payments come in M7; our plan in M8.
  - **Built against a fake Stripe** (the founder's choice, Sep 30: no Stripe account exists yet). `apps/api/src/stripe/fake` is a stateful stand-in that speaks Stripe's HTTP: it enforces each restricted key's permissions, saves the first answer to an idempotency key and refuses one reused with other parameters, and sends signed webhooks. Local runs, the tests and the smoke tests use it (`pnpm --filter @west4/api stripe:fake`, port 12111; `demo-start.sh` and Playwright start it). Swapping to the sandbox is only the keys in the environment. The first Acceptance line passed on West 4's sandbox on Oct 2 (below).
  - Built: migration `0052_stripe_accounts.sql` (`integrations` kind `stripe`, `resolve_stripe_account` returning the account's venues); `packages/db/src/stripe.ts`; the client `apps/api/src/stripe/client.ts` (plain HTTPS, no SDK: pinned `STRIPE_API_VERSION`, the service's key, `Stripe-Account` only from `organizations.stripe_account_id` through `stripeAccountOf`, an idempotency key on every write, never in a transaction; a timeout, dropped connection or 5xx is `StripeUnknownResult`, never retried); `settings.ts` (`STRIPE_KEY_PAYMENTS`, `_REFUNDS`, `_REPORTING`, `_BILLING`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET_READERS`, `_CONNECT`, `_PLATFORM`; production won't start without them, staging refuses Stripe calls, local uses the fake); `accounts.ts` (Accounts v2: create, read, onboarding links, payouts); the ops command `stripe:create-account` (audited through the organizations trigger with request id `ops:stripe:create-account`; refuses an organization that has an account and an id another organization holds); `routes/payments-admin.ts`; `screens/admin/Payments.tsx` and `Connections.tsx`.
  - The client refuses, before sending: the billing key with `Stripe-Account`, a venue call without an account, a write from the reporting key, anything but a refund from the refunds key, and a write without an idempotency key. The fake enforces the same as Stripe would.
  - Versions: `STRIPE_API_VERSION = "2026-08-26.dahlia"`, the sandbox account's own default, and Accounts v2's `"2026-08-26.preview"`, both confirmed against West 4's sandbox on Oct 2 (Accounts v2 answered nothing older than a 2026 preview). Which Accounts v2 features are on stable versions is still open with Stripe. `scripts/check-stripe-versions.sh`, part of `pnpm lint`, fails on any other version string outside the client, the Accounts v2 module and a `surcharge*.ts` file. ESLint refuses an import of the `stripe` package and any `api.stripe.com` address outside `apps/api/src/stripe`.
  - One organization per account is checked by the ops command, not by an index: the migration runner wraps each file in a transaction, which can't build an index concurrently, and the linter rightly refuses a blocking one on an existing table.
  - Admin → Payments reads the account from Stripe on each visit as well as on `account.updated` (M4-03), so it's right even if a webhook is late. Payouts are listed as Stripe has them; matching is M7.
  - The seed resets `stripe_account_id` on every load; the seed's own Stripe objects come in M4-10.
  - Not done here, and needs the founder: fixed egress IPs for the IP-restricted keys (a NAT gateway with an Elastic IP, about $35 a month; `infra/README.md` · Not yet), and wiring staging's task definitions to the new key names once the `stripe` secret holds them. The key-rotation runbook is in `infra/README.md` · Stripe keys.
  - **Sandbox run, Oct 2** (the founder's sandbox, with the four restricted keys): `stripe:create-account` made `acct_1UM7IcEy3Dp5MkPA` for organization West 4 Inc. (contact abhishekgaire327@gmail.com), and Stripe reads it back with `fees_collector` and `losses_collector` both `stripe`, `dashboard: full`, the registered name West 4 Inc., and card payments `restricted` until onboarding. The id is in `organizations.stripe_account_id`, with its audit rows. An onboarding link and the payouts list (none yet) came back through the app's own code. Finishing Stripe's hosted onboarding is the owner's step in Admin → Payments (sandbox test data is fine); "card payments enabled" on the sandbox is checked then.
  - What the sandbox taught: Stripe lists what it still needs as field paths (`configuration.merchant.mcc` and 30 more), not sentences, so the banner says how many things are left ("31 things left to finish in Stripe's setup") and Connect with Stripe finishes them; the fake now answers the same way. West 4's legal name (West 4 Inc.) and ZIP (10014) came from the founder and are in the seed.
  - The seed still clears the Stripe ids on every load, so a reload in the sandbox forgets the account and readers; keeping or remaking them is M4-10's job (the seed's sandbox objects).


### M4-02 · Register the Terminal: configuration, Location and both S710s

- **Status:** done
- **Size:** S
- **Depends on:** M4-01; M1 (devices and heartbeats)
- **Spec:** [Stripe setup](../spec/06-stripe-setup.md) step 4; [Devices, printing and offline](../spec/09-devices-printing-offline.md) (Devices at West 4, Heartbeats, Supported hardware); [Settings](../spec/03-settings-rule-packs-modules.md) (`pay.tipScreen`); [screens: AdminDesk note 9](../screens.md#admindesk)
- **Build:**
  - `POST /v1/terminal/configurations` on West 4's account with `tipping[usd][percentages][]` 18, 20, 22, `tipping[usd][smart_tip_threshold]=1000`, `tipping[usd][fixed_amounts][]` 100, 200, 300 (all from `pay.tipScreen`) and `cellular[enabled]=true`.
  - `POST /v1/terminal/locations` with `display_name`, address and `configuration_overrides=tmc_…`; the id goes in `venues.stripe_location_id`.
  - `POST /v1/terminal/readers` with the registration code, the label ("Bar S710" or "Front desk S710") and the location; each reader is a `devices` row of kind `reader` holding its Stripe reader id.
  - Reader health: read each reader's status from Stripe every 30 seconds during opening hours; 2 minutes offline raises `device.offline` (Stripe uses the same 2-minute rule); heartbeats never go into the audit log.
  - A `readerId` in any request must be a reader of the request's venue, or the API answers not found and sends nothing to Stripe.
  - A save of `pay.tipScreen` updates the Terminal Configuration; Admin says readers can take up to 5 minutes to pick it up.
  - Admin → Printers & devices lists both readers with label, online, cellular on and the monthly cellular fee ($10 a reader a month). Only the S710, S700 and WisePOS E are offered, the S700 and WisePOS E labeled "no cellular backup"; never the M2.
- **Acceptance:**
  - [x] On the connected sandbox, two simulated readers are registered as "Bar S710" and "Front desk S710" to West 4's Location, whose configuration has cellular on and tips of 18, 20 and 22% with $1, $2 and $3 under $10.
  - [x] Admin → Printers & devices and the Console's venue list both show both readers online, read from the same rows.
  - [x] A request naming another venue's reader answers not found and nothing reaches Stripe.
  - [x] A reader offline for 2 minutes during opening hours raises `device.offline` to the manager.
- **Tests:** integration with simulated readers; venue-wall test for reader ids; unit test for the 2-minute rule.
- **Notes:** Registering the two real S710s to the Location is an outside step on this milestone's list. The M2 reader works only through Stripe's mobile SDKs, so it's never offered.
  - Built on the fake Stripe (see M4-01). The first Acceptance line passed on West 4's sandbox on Oct 2 (below). On the fake, whose registration codes `simulated-s710`, `simulated-s700` and `simulated-wpe` make simulated readers as the sandbox's do (`simulated-m2` makes an M2, to test the refusal).
  - Built: migration `0053_terminal.sql` (`venues.stripe_terminal_config_id`, `app_rw` may update the two Terminal ids; `devices.stripe_reader_id`, `reader_model`, `cellular`); `packages/db/src/readers.ts`; `apps/api/src/stripe/terminal.ts` and `terminal-setup.ts`; `routes/readers.ts` (`GET` and `POST /readers`, `POST /readers/{readerId}/refresh`); `jobs/reader-health.ts` (the `readers.health` sweep, every 30 s, opening hours only); a readers section on Admin → Printers & devices.
  - The first reader registered makes the Configuration and the Location, with idempotency keys naming the venue, so a retry answers the same objects. Registering takes over the seed's unregistered row of the same name (so "Bar S710" keeps its device id) or adds a row. A reader Stripe reports as any model but the S710, S700 or WisePOS E is deleted at Stripe and refused (`details.reason: "unsupported_reader"`).
  - Health: each online reading is a heartbeat in `device_heartbeats` (never audited), and the quiet-device sweep's 2-minute rule raises `device.offline`; a reader back online raises `device.online`. Stripe unreachable means no heartbeats, so the readers go offline after 2 minutes, which is the honest reading.
  - A save of `pay` pushes `tipScreen` to the Configuration after the commit and answers `readers: "updating"` (or `"failed"`, the settings save itself standing). The 5-minute note shows under the reader list; Admin → Card fee & gratuity (M4-26) will show it beside the tip choices.
  - The Location's address is the venue's `address` as stored: 186 W 4th St, New York, NY 10014 (the ZIP from the founder, Oct 2).
  - `readerId` joined the principal and venue-wall suites. The seed resets the Terminal ids on every load; registering the seed's readers comes in M4-10.
  - **Sandbox run, Oct 2:** through the app's own registration route, "Bar S710" and "Front desk S710" (simulated S710s) are registered to Location `tml_GryBOwgZl3WKNy` (West 4 Boho Karaoke, 186 W 4th St, New York, NY 10014), whose Configuration has tips of 18, 20 and 22%, $1, $2 and $3 under $10 (smart tip threshold $10.00) and cellular on. Stripe lists both online, and the reader-health read recorded both online.
  - What the sandbox taught, both fixed: (1) a simulated reader's type is `simulated_stripe_s710`, so outside live mode a `simulated_` type counts as the model it simulates (never in production); (2) the first attempt was refused for (1) and the readers deleted, and the retry reused the attempt's idempotency key, so Stripe replayed the deleted readers. Each registration attempt now has its own key (the screen's `Idempotency-Key`, or the request), and registering a name again replaces that row's Stripe id instead of adding a row. The fake now reports simulated types the same way.


### M4-03 · Receive Stripe webhooks on the three endpoints

- **Status:** done
- **Size:** M
- **Depends on:** M4-01; M1 (jobs, worker pools, the event relay); `webhook_events` from M2's Twilio webhooks, or created here
- **Spec:** [Stripe setup](../spec/06-stripe-setup.md) step 6; [Tenancy and access](../spec/02-tenancy-access.md) (resolver functions, tables without `venue_id`, jobs); [API](../spec/08-api.md) (Webhooks in); [Security and data retention](../spec/12-security-retention.md) 5 and the retention table
- **Build:**
  - `POST /v1/hooks/stripe/readers`, a Connect endpoint for `terminal.reader.action_succeeded`, `action_failed` and `action_updated`, on the critical worker pool.
  - `POST /v1/hooks/stripe/connect`, a Connect endpoint for `payment_intent.succeeded`, `amount_capturable_updated`, `payment_failed`, `requires_action` and `canceled`; `charge.refunded`; `refund.updated` and `refund.failed`; `charge.dispute.created`, `closed`, `funds_withdrawn` and `funds_reinstated`; `payout.reconciliation_completed`; and `account.updated`.
  - `POST /v1/hooks/stripe/platform` for our own account: `customer.subscription.updated` and `deleted`; `invoice.paid` and `payment_failed`.
  - Each handler checks its own endpoint's signing secret before anything else, refuses an event whose `livemode` doesn't match the environment, stores the event id once in `webhook_events` (provider, event_id unique, type, received_at, payload), queues a job and answers 200.
  - The job resolves the venue from `event.account` through `resolve_stripe_account`, finds the payment by `stripe_pi_id` (never by metadata, which the owner can edit in their Dashboard), reads the object again from Stripe, and applies the state machine (M4-05) under a row lock.
  - Events whose handlers come later (payouts in M7, plan billing in M8) are stored and left unprocessed for those handlers to pick up.
  - Local runs and CI use the Stripe CLI (`stripe listen --forward-connect-to`) and a test signer that posts signed events in any order.
- **Acceptance:**
  - [x] An event with a bad signature, or signed with another endpoint's secret, is refused before any read or write.
  - [x] A test-mode event on a live endpoint, or a live one on staging, is refused.
  - [x] The same event delivered twice leaves one `webhook_events` row and one state change.
  - [x] `payment_intent.succeeded` before `amount_capturable_updated`, or `canceled` after `succeeded`, never moves a payment backward.
  - [x] A payment whose PaymentIntent metadata was edited to name another payment still resolves by `stripe_pi_id`.
  - [x] An event from another venue's account never reads or writes West 4's rows.
  - [x] Stripe gets its 200 before the job runs.
- **Tests:** integration with signed fixtures and Stripe CLI replays; duplicate and out-of-order replays; venue-wall suite for webhooks; livemode tests.
- **Notes:** Webhook payloads are kept 90 days; the retention job that deletes them comes in M8. Staging uses a connected sandbox account, so reader events arrive exactly as they will live.
  - Built: migration `0054_stripe_webhooks.sql` (`webhook_events.venue_id` may be null; `endpoint` and `account` columns; `ingest_stripe_event`, a definer function that stores the event once and resolves the venue from `event.account`); `routes/stripe-hooks.ts` (the three endpoints, in a scope that keeps the body as text so the signature is checked over Stripe's exact bytes); `apps/api/src/stripe/webhooks.ts` (`validStripeSignature` with Stripe's 5-minute tolerance and any number of `v1` signatures; the `stripe.event` job; `stripeEventHandlers`, one handler per type); `account.updated` reads the account again from Stripe into Admin → Payments.
  - Order of checks: the endpoint's own secret, then the livemode (staging and local take only test-mode events, production only live ones), then the type must be one this endpoint listens to (others get a 200 and are dropped). The event is stored once; a repeat stores nothing, and the job's dedupe key (`stripe.event:<event id>`) means one job however often it arrives. A repeat whose job never got queued (a crash between the two writes) queues it then.
  - Jobs need a venue, so the route resolves the venue (through the definer function, no Stripe call) and queues the job under it: reader events on the critical pool, venue payments on the normal one. An organization with several venues gets its first venue here; payment events will find their own venue by `stripe_pi_id` once payments exist (M4-04, M4-05). Our own account's events (`/platform`) have no venue: they're stored with `venue_id` null, which `app_rw` can't see, and wait for plan billing (M8).
  - Two Acceptance lines were checked in M4-05, which built the payment state machine they test (`apps/api/src/routes/payments.int.test.ts` · payment webhooks, and the state machine's property tests): "`payment_intent.succeeded` before `amount_capturable_updated`, or `canceled` after `succeeded`, never moves a payment backward" and "a payment whose PaymentIntent metadata was edited still resolves by `stripe_pi_id`". The job and its handler table are here; M4-05 adds the payment handlers and those tests.
  - The tests sign their own events with the fake's secrets (`signPayload`), in any order; the fake Stripe sends signed events the same way. Replays through the Stripe CLI (`stripe listen --forward-connect-to …/connect`) are part of the sandbox run.
  - The Stripe webhook routes joined the venue-wall suite's webhook cases.


### M4-04 · Add the payment tables, allocations and the amount due

- **Status:** done
- **Size:** M
- **Depends on:** M1 (row-level security, audit triggers, the migration linter); M2 and M3 (the open room check and its lines as orders join at Accept)
- **Spec:** [Data model](../spec/04-data-model.md) (the money core SQL, `payment_events`); [Money rules](../spec/05-money-rules.md) rules 11 and 12; [API](../spec/08-api.md) (Errors); [Security and data retention](../spec/12-security-retention.md) 4
- **Build:**
  - Plain SQL migrations in `packages/db` for `payments`, `payment_attempts` (with the `one_open_attempt` partial unique index), `payment_allocations` and `payment_events`, exactly as the money core SQL: `unique (venue_id, id)`, foreign keys that name the venue, row-level security forced, and the grants (select and insert; update only on `payments.status`, `capture_before`, `increments_used`, `incremental_supported`, `overcapture_supported`, `generated_card_pm`, `card_brand`, `card_last4`, `card_funding`; `payment_attempts.state`, `decline_code`, `resolved_at`; `payment_allocations.state`).
  - Definer functions `record_authorization()`, `record_capture()` and `set_tip()`: the only way `amount_cents`, `authorized_cents`, `surcharge_cents` and `tip_cents` change, each writing an audit row with old and new values. A cash payment never changes after insert.
  - One `amount_due(check)` function, run with the check row locked (`select … for update`): the check's lines minus its captured and in-progress allocations, with a refund's allocation negative. A deposit's allocation and a tab hold's in-progress allocation follow the lines up to the deposit or the hold, so no check ever shows a negative amount due. A tab's balance leaves its own hold out.
  - Every payment write checks the amount due in the same short transaction and refuses more than it, tips aside, with `422 over_amount_due`.
  - A `payment_events` row for every status change: from, to, source (api, webhook or reconciler) and `stripe_event_id`.
- **Acceptance:**
  - [x] The app role can't update `payments.amount_cents`, and can't delete any payment, attempt, allocation or event row.
  - [x] A second unfinished attempt for the same check and `portion_key` fails on `one_open_attempt`.
  - [x] Room 9 with its $120.00 deposit allocated and $618.60 of finalized lines has $498.60 due; a $498.61 payment answers `422 over_amount_due`.
  - [x] A $50.00 hold on an empty tab shows $0.00 due, never −$50.00.
  - [x] Two payments racing for more than the amount due between them: one lands, the other gets `422 over_amount_due`.
- **Tests:** migration tests (row-level security forced, grants, the index); property tests (the amount due is never negative; allocations add up); a concurrency test; venue-wall suite.
- **Notes:** This ticket doesn't change `checks` or `check_lines`; M4-07 adds revisions and numbers. Payments other than holds and deposits run against a finalized revision (M4-07 and M4-08), so the amount due reads written lines.
  - Built: migration `0055_payments.sql` (`payments`, `payment_attempts` with `one_open_attempt`, `payment_allocations`, `payment_events`; row-level security forced on all four, the grants as the money core says, `payments`, `payment_attempts` and `payment_allocations` audited); the definer functions `record_authorization`, `record_capture` and `set_tip` (owned by `app_definer`, acting only inside the caller's venue, never on a cash payment, audited with old and new values through the payments trigger); `amount_due(check, leave_out)`; `packages/db/src/payments.ts` (`insertPayment`, `allocate`, `amountDue`, `startAttempt`, `setPaymentStatus`, `setAllocationState`, and the three amount moves); the API's error handler answers `OverAmountDue` as `422 over_amount_due` (with `details.due_cents`) and `AttemptOpen` as `409 in_progress` on every route.
  - Two additions to the money core's SQL, both needed by its own rules: `payment_allocations` has an `id` (so one allocation's state can move) and `follows_lines` (true for a deposit's allocation and a tab hold's, which Money rules 11 and 12 make follow the lines up to their amount). The core SQL's comment describes that rule without naming a column.
  - `amount_due` locks the check row, takes the lines minus the fixed allocations (captured or in progress, a refund's negative), then lets the following allocations take what's left in the order they were made, and never answers below zero. A void after a payment can leave a check overpaid; the overpayment shows as $0.00 due, and settling it is a refund (M4-21). `leave_out` gives a tab's balance without its own hold.
  - `insertPayment` writes the first `payment_events` row (from nothing to its status, source api); `setPaymentStatus` writes one per move. The state machine that decides which moves are allowed is M4-05.
  - Tests: `packages/db/src/payments.int.test.ts`, as `app_rw` with row-level security on: the refused updates and deletes, the definer functions (and their audit row, and their refusal from another venue), `one_open_attempt`, Room 9's $498.60, the $50.00 hold, a two-payment race, 25 random checks (the amount due is never negative; without a hold, payments plus what's due equal the lines), and the event rows. The `422` itself shows on the first payment route (M4-05, M4-13).
  - The seed wipes the four tables before checks and bookings.


### M4-05 · Run every card attempt through one state machine

- **Status:** done
- **Size:** M
- **Depends on:** M4-01, M4-03, M4-04
- **Spec:** [Payment flows](../spec/07-payment-flows.md#how-every-card-payment-runs) steps 1 to 4 and [What staff see](../spec/07-payment-flows.md#what-staff-see-during-a-card-payment); [Stripe setup](../spec/06-stripe-setup.md) step 5; [API](../spec/08-api.md) (Payments, Idempotency, Errors)
- **Build:**
  - The payment state machine in `apps/api`, moving forward only. Payments: pending → requires_action, authorized, captured, failed or canceled; requires_action → authorized, captured, failed or canceled; authorized → captured, capture_failed or canceled; captured → partly_refunded or refunded; partly_refunded → refunded. Attempts: started → unknown, succeeded, failed or canceled; unknown → succeeded, failed or canceled. Allocations: in_progress → captured or released. A late or repeated event changes nothing. The webhook jobs, the screens' check-status and the reconciler all call this one function.
  - The run: (1) one short transaction inserts the payment, its attempt, an in-progress allocation and a job, and commits; (2) the job calls Stripe outside any transaction, with a 10 to 15 second timeout and the attempt's key `<payment_id>:<action>:<attempt_no>`; (3) a second short transaction records the result. A payment's one PaymentIntent is created with the key `<payment_id>:create`.
  - A decline (`card_declined`) fails the attempt with its `decline_code`; the PaymentIntent waits for another card, and the next try is a new attempt with a new key on the same PaymentIntent.
  - Unknown means unknown: a timeout, `terminal_reader_timeout`, a connection error, a 5xx answer, or a reader action still `in_progress` after 20 seconds marks the attempt `unknown`; its allocation stays; the server polls the reader and the PaymentIntent every 2 seconds for up to 2 minutes; the API answers `202 payment_unknown` and screens show "Checking with Stripe · don't retry".
  - When polling ends with no answer: cancel the PaymentIntent (`POST /v1/payment_intents/{id}/cancel`) and send `cancel_action` to the reader. If the cancel fails because the payment went through, record the success. Once canceled, release the allocation and offer another way to pay.
  - `GET /payments/{p}`, `POST /payments/{p}/check-status` (the same state machine) and `POST /payments/{p}/cancel`; events `payment.updated` and `check.updated`.
  - Stripe's `terminal_reader_offline` answers `503 reader_offline`, and `terminal_reader_busy` answers `409 reader_busy`.
  - A fault-injection hook in the Stripe client for tests (delay a call, drop the answer after Stripe processed it, kill the worker at a named step), absent from production builds.
- **Acceptance:**
  - [x] With the answer dropped after Stripe succeeded, the attempt is `unknown`, screens show "Checking with Stripe · don't retry", and polling records Paid within 2 minutes.
  - [x] While an attempt is unknown, no screen can start a second payment for the same check portion.
  - [x] A declined card leaves one PaymentIntent; the next tap is attempt 2 with key `<payment_id>:process:2`.
  - [x] The same `Idempotency-Key` with the same body replays the first answer; with a different body it answers `422 key_reused`; while the first request runs, `409 in_progress`.
  - [x] No database transaction is open while any Stripe call is in flight (a test wraps the client and fails if one is).
- **Tests:** property tests of the state machine (random event orders never move backward); integration with the fault-injection client and simulated readers; the unknown path, the decline path and the cancel-that-finds-success path.
- **Notes:** The spec names no key for the PaymentIntent's own create call; `<payment_id>:create` follows its pattern (one PaymentIntent per payment) and lets the reconciler recover an id the API died before storing (M4-12).
  - Built: `apps/api/src/payments/state.ts` (the forward-only moves for payments, attempts and allocations, and what a PaymentIntent's status means); `machine.ts` (`applyObservation`, the one function: the payment row locked, only forward moves, amounts through the definer functions, allocations captured or released with the payment, `payment.updated` and `check.updated`); `run.ts` (`writeTap` and `writeRetap` for step 1, the `payment.run` job for steps 2 and 3, `payment.check` polling, `checkNow`, `cancelPayment`, `runNow`); `webhooks.ts` (every PaymentIntent and reader-action event finds its payment by `stripe_pi_id`, reads Stripe again and applies); `apps/api/src/stripe/payments.ts`; `routes/payments.ts` (`POST /checks/{c}/payments` for `tap`, `POST /payments/{p}/tap`, `GET /payments/{p}`, `check-status`, `cancel`); migration `0056_payment_intent_id.sql`; the fake Stripe's PaymentIntents, reader actions and Stripe's own `present_payment_method` test helper.
  - The API runs a new attempt's `payment.run` job itself at once (`runNow` claims it with a 60-second lease, as a worker would), so the screen hears straight away; if the API dies, the worker runs it after the lease. Polling and the 2-minute give-up are `payment.check` jobs every 2 seconds on the critical pool.
  - Setting the PaymentIntent's id: the money core grants no update on `payments.stripe_pi_id`, and the payment is written before its PaymentIntent exists, so `set_payment_intent()` (a definer function) sets it once and refuses to change it. The grants stay as the spec has them.
  - Taking a tap again after a decline, or on the other reader after `reader_offline`, is `POST /payments/{p}/tap`: a new attempt on the same payment and PaymentIntent (`<payment_id>:process:2`). It's not in spec 08's list; it's how "Tap again, as a new attempt on the same PaymentIntent" reaches the API (flagged for spec 08). A retry of the first request with the same key after a `503` isn't replayed (the API stores answers under 500); it's refused as over the amount due, because the first payment still holds its allocation.
  - Reading of step 4, to confirm: "a reader action still `in_progress` after 20 seconds" is taken literally, from when the attempt started, so a guest who takes longer than 20 seconds to tap sees "Checking with Stripe · don't retry", and the tap is still recorded by the polling (for up to 2 minutes more). If the founder or Stripe means 20 seconds after the card is presented, it's one constant (`UNKNOWN_AFTER_S`) and where it counts from.
  - A pending payment whose attempt failed (a decline, an offline reader) keeps its allocation until it's tapped again or canceled; the reconciler (M4-12) settles ones left behind.
  - Fault injection: `StripeClient` takes `StripeFaults` (delay or fail before a call, drop Stripe's answer after it did the work, stop at a named step: `after-create-intent`, `before-process`, `after-process`). The client refuses faults in live mode, and nothing in the app passes them; only tests do.
  - Tests: `state.test.ts` (2,000 random event orders never move a payment backward; finals take nothing more); `routes/payments.int.test.ts` against Postgres and the fake: Paid, the decline and attempt 2, the dropped answer (`202 payment_unknown`, `409 in_progress` for a second payment, polling records Paid), the 2-minute cancel and release, the cancel that finds success, `503 reader_offline` then the other reader, the idempotency replay, `422 key_reused` and `409 in_progress`, the webhooks (by `stripe_pi_id` with edited metadata; a repeat and a late cancel change nothing), and a `fetch` wrapper that sees no open transaction during any of the Stripe calls.
  - Not yet run on the sandbox: West 4's sandbox account can't take card payments until its onboarding is finished in Admin → Payments.


### M4-06 · Work out check totals, tax and gratuity in packages/rules

- **Status:** done
- **Size:** M
- **Depends on:** M2 (room time in `packages/rules`); M1 (the rule pack and settings types)
- **Spec:** [Money rules](../spec/05-money-rules.md) rules 1, 8, 9, 11, 13 and 14, and Room 9, worked through; [Settings](../spec/03-settings-rule-packs-modules.md) (`PaySettings`, the rule pack's `salesTax`); [money cases](../../seed/money-cases.json) (`meta.rounding`, `meta.properties`)
- **Build:** pure functions in integer cents, no floats:
  - `checkTotals`: the subtotal of net lines after comps; tax worked once per rate per revision on the net base, then shared across categories by largest remainder of each category's exact tax; the gratuity by `pay.gratuity.auto` (off, rooms, parties or all) at `pay.gratuity.pct`, on room time, items and songs after comps, before tax, never on a damage fee; the total; and what's left to pay after the deposit, never below zero.
  - Which categories are taxed, and each one's rate and jurisdiction code, come from the rule pack as data: room_time, drink and damage at 8.875%; `surcharge` while `salesTax.surchargeTaxable`; `fee` (forfeit and min_spend lines) untaxed until the accountant answers.
  - `checkRevision`: reverse revision n's computed lines (room_time, min_spend, tax, gratuity) and write the new ones; the gratuity basis each revision stores (the rule, the largest party size recorded, the percent).
  - `canPresentCheck`, `splitEven` (leftover cents to the first shares), `splitByItem` (each person's own items plus an even part of room time and lines nobody claimed; tax and gratuity by largest remainder), `payMyShareEven`, `refundCap`, `depositVsCheck` and `cardFee` (used by M4-25).
- **Acceptance:**
  - [x] Room 9 at 10:41 PM: subtotal $480.00, tax $42.60 (room time $28.58 and drinks $14.02), gratuity $96.00, total $618.60, deposit $120.00, $498.60 left.
  - [x] With the margaritas accepted first: $506.00, tax $44.91, gratuity $101.20, $652.11 and $532.11 left.
  - [x] Three $12.00 Jäger Bomb lines tax to $3.20, never $3.21.
  - [x] Room 9 with the $150.00 damage fee taxes $55.91 on $630.00 and keeps the gratuity at $96.00.
  - [x] Bar tabs carry no gratuity: Jess P. $32.66, Luis M. $63.15, Seat 6 $13.07, Hana K. $43.55, Tariq A. $86.01 ($9.80 after the void).
  - [x] $32.66 in two is $16.33 + $16.33, $32.67 is $16.34 + $16.33, $498.60 in three is $166.20 each, and in twelve $41.55 each, with Kevin's share showing $3.55 of tax and $8.00 of gratuity.
  - [x] Marcus's refund cap is $120.00, $120.01 is refused, and after a $50.00 refund at most $70.00 more can come off.
  - [x] 8 guests on a $120.00 deposit: $103.10 applied, $0.00 left, a $16.90 forfeit.
- **Tests:** every case in the money-cases groups `room9_close_out`, `tax_and_gratuity`, `tab_so_far` (with `if_presented_now`), `bar_tabs`, `splits`, `pay_my_share`, `refunds`, `card_fee`, and `deposit_larger_than_check_forfeit` from `deposits`, read straight from the JSON so a failure names the case id; property tests for `meta.properties`; the `must_not_equal` check.
- **Notes:** How kept deposits, no-show charges and card surcharges are taxed is with the accountant ([Open technical questions](../spec/14-open-questions.md), gate), so it's rule-pack data with the cautious default above, which matches money case `deposit_larger_than_check_forfeit`. The spec's `RulePack.salesTax` has no list of taxed categories while the seed's `rulePack.taxedCategories` has one: add it to the type and publish it as a new rule-pack version through the Console's two-approver flow (M1). Tax shared by category follows money-cases ambiguity A9.
  - Built: `packages/rules/src/check-totals.ts` (`checkTotals`, `salesTaxRule`, `gratuityApplies`, `checkRevision`, `canPresentCheck`, `splitEven`, `splitByItem`, `payMyShareEven`, `refundCap`, `depositVsCheck`, `cardFee`, and `ratio`/`percent`, which turn a decimal rate into an exact fraction so no float ever multiplies an amount); `check-totals.test.ts` reads every case of `room9_close_out`, `tax_and_gratuity`, `tab_so_far` (its `if_presented_now`), `bar_tabs`, `splits`, `pay_my_share`, `refunds`, `card_fee` and `deposit_larger_than_check_forfeit` from the JSON by id, checks `must_not_equal` (three Jäger Bombs tax to $3.20, never $3.21), and runs property tests for `meta.properties` (splits add up and differ by at most a cent, first shares larger; tax by category adds up; total = subtotal + tax + gratuity; left to pay never negative; no gratuity on damage or fees).
  - Rule pack: `RulePack.salesTax.taxedCategories` added to the type and to spec 03, and published as version **2026.10** (`newYorkCountyTaxed`: room_time, drink and damage, as the seed's rule pack has them; `surcharge` taxed while `surchargeTaxable`; `fee` untaxed until the accountant answers). Version 2026.09 stays exactly as spec 03 gave it, since earlier tests and checks name it. The bootstrap loads both locally and in staging (the later version wins on the same effective date); in production 2026.10 is published through the Console's two-approver flow. A pack without `taxedCategories` makes `salesTaxRule` refuse loudly rather than guess.
  - `checkRevision` reverses and rewrites only the computed lines (room_time, min_spend, tax, gratuity) whose amount changed, which is what the money case's revision 2 shows (only tax and gratuity move when the margaritas are added).
  - `splitByItem` has no money case; it's tested by hand on Room 9's lines (each person's own items, room time and unclaimed lines evenly, tax and gratuity by largest remainder, everything adding up).


### M4-07 · Finalize checks into revisions, with tax lines and check numbers

- **Status:** done
- **Size:** M
- **Depends on:** M4-04, M4-06; M2 and M3 (checks and their lines)
- **Spec:** [Data model](../spec/04-data-model.md) (`checks`, `check_revisions`, `check_lines`, `venue_counters`, and the money core notes); [Money rules](../spec/05-money-rules.md) rules 2, 8 and 9; [Security and data retention](../spec/12-security-retention.md) 4; [API](../spec/08-api.md) (`GET /checks/{c}`, `POST /checks/{c}/finalize`, Conflicts)
- **Build:**
  - `check_revisions` as the money core SQL: subtotal, tax, gratuity, total, `gratuity_basis`, `billing_basis`, `pay_version`, `prices_version`, `rule_pack_version`, `finalized_by`, `finalized_at`.
  - Finalize writes revision n + 1 in one transaction with the check row locked: it reverses revision n's computed lines, writes the new room_time, min_spend, tax and gratuity lines (each carrying `revision`), and records the totals, the settings versions and the billing basis (each segment's rate mode, band amounts, billing step and rounding).
  - Each tax line stores its rate, jurisdiction code, taxable base and rule-pack version.
  - `venue_counters` ('check', 'check_training', 'z_report'): a check's number comes from its own short transaction before any Stripe call, in order per venue and never reused; a failed tap voids its check but keeps the number, so the sequence has no gaps. Screens and receipts show it as #1042.
  - `GET /checks/{c}` returns the lines, the live totals from `packages/rules` while the check is open and the finalized totals once presented, the number and any split; edits send `If-Match` on `version` and get `409 version_conflict` if someone changed the check first.
  - Money rows are append-only: corrections are new lines, never updates or deletes.
  - Times on checks show in New York time with EDT or EST on both daylight-saving nights.
- **Acceptance:**
  - [x] Finalizing Room 9 writes revision 1 with a $322.00 room-time line; tax lines of $28.58 (room_time) and $14.02 (drink), each with rate 0.088750, the jurisdiction code, its base and rule-pack version 2026.09; a $96.00 gratuity line; and a $618.60 total.
  - [x] Adding the 2 × Margarita · Peach and finalizing again writes revision 2: −$42.60 and −$96.00 reversed, $44.91 and $101.20 written, $652.11 in all, and the amount due up $33.51.
  - [x] Two finalizes racing on one check: one wins and the other gets `409 version_conflict`.
  - [x] 50 checks opened at once, some with failed taps, get numbers with no gaps and no repeats.
  - [x] Room 9's revision stores its one segment in `billing_basis`: per person, $120.00 an hour, a 1-minute step.
- **Tests:** money cases `room9_closeout_rev1` and `room9_reopen_check_revision2`; counter concurrency tests; permission tests (no update or delete on money rows); daylight-saving label tests on Nov 1, 2026 and Mar 14, 2027.
- **Notes:** Checks open in M2 (rooms) and M3 (orders joining at Accept). If M2 gave them numbers from anywhere else, move them onto `venue_counters` here, keeping Room 9 at #1042 in the seed. Training checks (T-0012) arrive in M7; the `check_training` counter is reserved now.
  - Built: migration `0057_check_revisions.sql` (`check_revisions` as the core SQL, append-only and audited; the app may update `checks.status`, `revision` and `paid_at`, which the core SQL never grants but finalize, present, pay and reopen must move); `packages/db/src/revisions.ts`; `apps/api/src/rooms/finalize.ts` (`workOut`, the live totals from `packages/rules`, and `finalizeCheck`); `POST /checks/{c}/finalize` with `If-Match`; `GET /checks/{c}` now carries `totals` (live while open, the latest revision's once finalized, presented or paid) and `check.opened_label`; `formatCheckTime` in `packages/shared` ("1:30 AM EDT", then "1:30 AM EST" on the fall-back night).
  - Finalize reverses a computed kind line by line (each reversal points at its line with `reverses_id` and carries its revision) only when what that kind comes to changed; room time is compared by amount, since its words carry the minutes. Tax lines keep `tax_category` null as the data model says; their description names the category ("Tax · room time", "Tax · drinks"), and each stores rate 0.088750, the jurisdiction code (null until the accountant answers), its base and the rule-pack version.
  - The first Acceptance line names rule-pack version 2026.09; the lines carry **2026.10**, the version in force, because the taxed categories became rule-pack data in M4-06.
  - Check numbers already came from `venue_counters` in its own short transaction since M2 (`nextCheckNumber`), so nothing moved; the test takes 50 numbers at once, voids some checks, and finds no gaps and no repeats. Room 9 stays #1042 in the seed.
  - Room time leads the lines when tax is shared by category, as the money cases list it, so a tied leftover cent goes to room time.
  - Tests: `apps/api/src/routes/finalize.int.test.ts` (live totals, revisions 1 and 2 with every line and the amount due up $33.51, a racing finalize answering `409 version_conflict`, 50 numbers, and no update or delete of lines, revisions or checks); `packages/shared/src/check-time.test.ts` (Nov 1, 2026 and Mar 14, 2027).


### M4-08 · Present the check and reopen it

- **Status:** done
- **Size:** M
- **Depends on:** M4-07; M3 (orders, ordering from the room, the room page and tablets); M2 (room states and cleaning)
- **Spec:** [Money rules](../spec/05-money-rules.md) rule 6 (Presenting the check, After payment); [Payment flows](../spec/07-payment-flows.md#room-close-out) steps 1 and 4; [API](../spec/08-api.md) (`POST /checks/{c}/present`, `/reopen`; `409 orders_open`; `409 ordering_closed`); [screens: N5](../screens.md#n5-your-bill), [N4](../screens.md#n4-room-tablet-kiosk), [N21](../screens.md#n21-close-out-steps-and-card-states)
- **Build:**
  - `POST /checks/{c}/present`: refused with `409 orders_open` while any order on the session is ringing or held, listing each first ("2 × Margarita · Peach is ringing at the bar · accept or cancel it first"); otherwise it finalizes the check (M4-07), sets `room_sessions.ordering_locked` and sends `check.updated` on the room's channel.
  - Joined phones and the room tablet show "Your bill is ready · ordering is closed" with the bill link; new room orders and Same again answer `409 ordering_closed`.
  - `POST /checks/{c}/reopen` for managers and owners: the check goes to `reopened`, `ordering_locked` clears and ordering opens again; the next finalize writes the next revision.
  - Paid in full: the check goes to `paid` with `paid_at`; the room goes to cleaning only when no order on it is ringing, held or on a check that isn't paid; an order accepted after the check is paid opens a new check on the session, which staff settle before the room is released.
- **Acceptance:**
  - [x] Presenting Room 9 while o1 rings answers `409 orders_open`, and DeskRoom lists "2 × Margarita · Peach is ringing at the bar · accept or cancel it first"; an asked-to-wait order blocks it the same way.
  - [x] With o1 cancelled, Present finalizes #1042 at $618.60, Room 9's phones and tablet read "Your bill is ready · ordering is closed", and a new order from Kevin's phone answers `409 ordering_closed`.
  - [x] Andy reopens #1042, ordering opens, the 2 × Margarita · Peach is ordered again and accepted, and Present writes revision 2 at $652.11 with $532.11 left.
  - [x] Diego (front desk) can't reopen a check.
  - [x] Once #1042 is paid in full, Room 9 goes to cleaning; with an order still ringing on the room it doesn't, and the screen names the order.
  - [x] An order accepted after #1042 is paid lands on a new check for Room 9, and the room isn't released until that check is paid.
- **Tests:** money cases `room9_present_blocked_while_o1_rings`, `room9_present_blocked_while_order_held`, `room9_present_allowed_once_cancelled` and `room9_reopen_check_revision2`; integration of the room channel's events; end-to-end on the seed (Room 9).
- **Notes:** milestones.md says "Accepting the ringing margaritas after [Present the check] writes revision 2", but Present is refused while o1 rings (rule 6). The test does what money case `room9_reopen_check_revision2` does: cancel o1, present revision 1, reopen, and accept the margaritas ordered again. The canvas closes out in one step; build the four steps ([DeskRoom note 2](../screens.md#deskroom), [Room note 2](../screens.md#room)).
  - Built: `apps/api/src/rooms/present.ts` (`presentCheck`, `reopenCheck`, `settleCheck`, `releaseRoom`, `openOrders`, `checkForAccept`); `POST /checks/{c}/present` and `/reopen`; the state machine settles every check a captured payment lands on (paid with `paid_at`, or partly paid) in the same transaction; Accept on a paid check opens a new check on the session; the staff room screen's `PresentCheck` panel; the room page and tablet show "Your bill is ready · ordering is closed" and stop sending orders.
  - `409 orders_open` carries `details.orders` (`order_id`, `status`, and the items as the bar shows them, "2 × Margarita · Peach"); the screen builds the sentence in either language. An asked-to-wait order reads "2 × Margarita · Peach is waiting at the bar · accept or cancel it first": the glossary has only the ringing sentence, so the held one follows its pattern (flagged for the glossary).
  - Present finalizes (M4-07), sets the check `finalized` and `room_sessions.ordering_locked`, and sends `check.updated` and `session.updated` on the room's channel, which the room page reloads on. Reopen is the owner's or a manager's (the permission table has no action for it, so the route checks the role, as Team does): the check goes `reopened`, ordering opens, and staff orders are taken again on a reopened check.
  - Paid in full ends the session (the M2 end, which sends the room to cleaning) only when no order on it rings or waits and no other check on the session is unpaid; otherwise `settleCheck` answers what holds it (`room.blocked_by`, `room.unpaid_checks`) for the close-out screen (M4-20). A new check for an order accepted after payment takes its number in the accept transaction (no Stripe call happens there).
  - Present is staff's step on the room screen here; the full four-step close-out (ways to pay, additional tip, receipt) comes in M4-20.
  - Tests: `apps/api/src/routes/present.int.test.ts` (o1 ringing, then held; present at $618.60 with the room's events; Diego can't reopen; Andy reopens, the margaritas are ordered again, revision 2 is $652.11 with $532.11 due; paid in full with o1 ringing doesn't release the room and names o1; o1 accepted after payment lands on a new check, and paying it releases the room to cleaning); the Playwright test "Present the check".


### M4-09 · Apply the deposit at check-in and write forfeit lines

- **Status:** done
- **Size:** S
- **Depends on:** M4-04, M4-07; M2 (the check-in sheet and `POST /bookings/{b}/check-in`)
- **Spec:** [Money rules](../spec/05-money-rules.md) rules 11 and 12; [Payment flows](../spec/07-payment-flows.md#deposit-when-booking-online); [screens: N10](../screens.md#n10-check-in-sheet); [money cases](../../seed/money-cases.json) (`deposit_larger_than_check_forfeit`)
- **Build:**
  - Check-in now allocates the booking's deposit payment to the session's check (`payment_allocations`, kind payment, state captured), following the check's lines up to the deposit so the check never shows a negative amount due. Before check-in, a deposit is money held for the guest, not a sale.
  - At finalize, if the check closes for less than the deposit, the rest becomes a `forfeit` line on a new `fee` check with the next check number, allocated from the deposit payment.
  - The same mechanism writes a kept deposit or a no-show charge as a `fee` check with a `forfeit` line (M5 applies the booking policy).
  - The check-in sheet's deposit step reads from the allocation.
- **Acceptance:**
  - [x] Checking in Sam O. (3 guests, bills as 4) applies his $40.00 deposit, and the sheet shows it applied (−$40).
  - [x] Room 9's presented check shows the $120.00 deposit paid and $498.60 left.
  - [x] A party that shrank to 8 after the refund cut-off, on a $120.00 deposit, closes at $103.10 with $0.00 left and a $16.90 `forfeit` line on a `fee` check numbered next in sequence.
  - [x] No check shows a negative amount due at any point.
- **Tests:** money case `deposit_larger_than_check_forfeit`; integration through M2's check-in route; property test (amount due never negative with a deposit).
- **Notes:** Whether a kept deposit is taxable, and needs its own check number, is with the accountant (gate); the spec gives it its own `fee` check, and the `fee` category stays untaxed by default (M4-06). The deposit is compared with the check's total, tax and gratuity included (money-cases ambiguity A6).
  - Built: `applyDeposits`, `depositsOn` and `releaseAllocation` in `packages/db/src/payments.ts`; check-in allocates the booking's captured, unallocated payments to the new check (following its lines) and answers `deposit_applied_cents`; `apps/api/src/rooms/deposit.ts` (`settleDeposit`, run by every finalize); `GET /checks/{c}` carries `deposit_cents` and `amount_due_cents`; the check-in preview's deposit is the booking's captured deposit payments once any exist, the booking's own figure until then (the seed's become payments in M4-10, online booking's in M5).
  - The forfeit: the deposit is compared with the check's total, tax and gratuity included (ambiguity A6). Allocations never change amount, so when the split changes, the deposit's allocations are released and written again: the room check up to its total, the rest on the `fee` check, whose forfeit lines always add up to what's kept (a later revision that takes more of the deposit writes a negative forfeit line). The fee check takes the next number in the same transaction (no Stripe call there), its `forfeit` line is `fee` (untaxed, M4-06), and it's paid at once from the deposit. Finalizing again with the same total changes nothing.
  - Kept deposits and no-show charges (M5) use the same fee check and forfeit line.
  - "No check shows a negative amount due" holds through `amount_due`, which never answers below zero and lets a deposit follow the lines (the property test in `payments.int.test.ts` covers following allocations; this ticket's test checks $0.00 due right after check-in and after the forfeit).
  - Tests: `apps/api/src/routes/deposit.int.test.ts` (Sam O.'s $40.00 applied at check-in through M2's route, $0.00 due; Room 9 presented with $120.00 paid and $498.60 left; a party of 8 on a $120.00 deposit closes at $103.10, $0.00 due, and a $16.90 forfeit on a paid fee check numbered next, the deposit's allocations adding up to $120.00).


### M4-10 · Load the seed's deposits, checks and drawers into staging

- **Status:** todo
- **Size:** S
- **Depends on:** M4-02, M4-04, M4-09; M1 (the seed loader)
- **Spec:** [Demo seed](../demo-seed.md#loading-the-seed); [Testing and operations](../spec/13-testing-operations.md) (Environments, The demo seed); [seed file](../../seed/west4-friday.json) (`bookings`, `checks`, `drawers`, `devices`)
- **Build:**
  - The seed loader in `packages/db` loads M4's parts: each booking's deposit as a captured `card_online` payment backed by a real PaymentIntent on the connected sandbox (a Customer and a saved test card of the same brand, so refunds and card on file work in staging); the deposits of seated sessions allocated at check-in; Room 9's check fixed at #1042 and the others numbered from the counter; both house drawer sessions open with $300.00; both simulated readers labeled "Bar S710" and "Front desk S710".
  - The seed's card brand and last four (Marcus's "Amex ··1005") stay on our rows for display; the sandbox card underneath is Stripe's test card of that brand.
  - Every test that changes state starts from a fresh load, so the next test still sees 10:41 PM.
- **Acceptance:**
  - [ ] After a load, Room 9 shows #1042, $480.00 tab so far and the $120.00 deposit on Amex ··1005.
  - [ ] Marcus's deposit is a real $120.00 captured PaymentIntent in the sandbox that can be refunded.
  - [ ] Both drawers show an open session of $300.00.
  - [ ] No test depends on any check number but #1042.
- **Tests:** the loader's own test against the seed's `expected_at_now` numbers and row counts.
- **Notes:** Stripe's test cards can't end in the seed's last fours (its test Amex ends in 0005), so the display fields come from the seed and tests assert on our rows. The drawers' opening times and cash aren't in the seed (null); the sessions open at the business date's start with the $300.00 starting bank.

### M4-11 · Take a tap on the chosen reader, with every reader state

- **Status:** todo
- **Size:** M
- **Depends on:** M4-02, M4-05, M4-08
- **Spec:** [Payment flows](../spec/07-payment-flows.md#room-close-out) (Tap at the reader, Additional tip) and [What staff see](../spec/07-payment-flows.md#what-staff-see-during-a-card-payment); [Stripe setup](../spec/06-stripe-setup.md) step 4; [API](../spec/08-api.md) (`POST /checks/{c}/payments`); [screens: N21](../screens.md#n21-close-out-steps-and-card-states); [glossary](../glossary.md#other-exact-sentences)
- **Build:**
  - `POST /checks/{c}/payments` with `method: tap`, `amount`, `readerId` and an optional `share_id`: a `card_present` PaymentIntent with automatic capture, then `POST /v1/terminal/readers/{reader}/process_payment_intent` with `process_config[skip_tipping]=true` on a room check, which carries the gratuity.
  - The same states on every screen that pays: Waiting, "Waiting for a tap on the front-desk reader · Cancel" (Cancel sends `cancel_action`); Paid; Declined, "Declined · try another card or cash" (Tap again is a new attempt on the same PaymentIntent); Unknown, "Checking with Stripe · don't retry"; Reader offline, "Reader offline · use the bar reader" (or the front-desk reader), from `terminal_reader_offline` or no heartbeat for 2 minutes; Reader busy, "Reader busy", from `terminal_reader_busy`.
  - On success: the allocation is captured, the card's brand, last four and funding are stored, `payment.updated` and `check.updated` go out, and the check becomes `partly_paid` or `paid`.
  - The reader picker lists "Front desk S710" and "Bar S710", this screen's station first; nothing goes to a reader until one is picked.
  - An "Additional tip (optional)" entered before the tap adds to the amount sent to the reader and is recorded with `set_tip()`; tips may go over the amount due.
- **Acceptance:**
  - [ ] Room 9's $498.60 on the Front desk S710 shows "Waiting for a tap on the front-desk reader · Cancel", then Paid; Stripe shows one $498.60 PaymentIntent, and the reader showed no tip screen.
  - [ ] A declining test card shows "Declined · try another card or cash"; the next tap is attempt 2 on the same PaymentIntent, and cash stays offered.
  - [ ] Cancel while waiting clears the reader, cancels the PaymentIntent and frees the $498.60 for another way to pay.
  - [ ] A second action on a busy reader shows "Reader busy", and picking the other reader works.
  - [ ] A reader Stripe reports offline shows "Reader offline · use the bar reader".
  - [ ] A $20.00 additional tip charges $518.60, stores $20.00 in `tip_cents` and leaves $0.00 due.
- **Tests:** integration on the connected sandbox with simulated readers (`POST /v1/test_helpers/terminal/readers/{reader}/present_payment_method`, including a declining test card); reader busy with two actions on one reader; reader offline and timeouts through the fault-injection client; end-to-end card states on DeskRoom and the Room phone.
- **Notes:** The spec marks an attempt unknown when a reader action is still `in_progress` after 20 seconds, which also catches a guest who is slow to tap: the tap still lands as Paid, but staff lose Cancel at 20 seconds. Build it as the spec says and watch it in the staff trial (M9).

### M4-12 · Reconcile unknown results and pass the chaos tests

- **Status:** todo
- **Size:** M
- **Depends on:** M4-05, M4-11
- **Spec:** [Payment flows](../spec/07-payment-flows.md#how-every-card-payment-runs) step 5; [Stripe setup](../spec/06-stripe-setup.md) steps 6 and 11; [Testing and operations](../spec/13-testing-operations.md) (Payment chaos tests, Stripe flow tests)
- **Build:**
  - A reconciler job every 5 minutes per venue, on the critical pool: it resolves attempts unknown for more than 2 minutes by reading the PaymentIntent and the reader through the state machine, and lists the venue's recent PaymentIntents to find any with no committed row.
  - It adopts a PaymentIntent only if it's on the payment's organization account and the amount matches. A payment whose PaymentIntent id was never stored gets it back by sending its create call again with the same key (`<payment_id>:create`), which Stripe answers with the same PaymentIntent for 24 hours. Nothing is ever matched by metadata.
  - Anything else, such as a break-glass Tap to Pay payment from Stripe's Dashboard app, is recorded for Unmatched payments as a `payments` row with method `external`, no allocation, and a `payment_events` row from the reconciler; M7 builds the list a manager works through.
  - It also checks bookings still pending after 2 minutes (M5's deposits use it).
  - A chaos harness in CI and staging: kill the worker between Stripe's success and our record for each action (create, process, off_session, capture, refund); time out calls; drop a reader mid-payment; drop, repeat and reorder webhooks.
- **Acceptance:**
  - [ ] Killing the API between Stripe's success and our commit on Room 9's $498.60 tap: within 5 minutes the reconciler records Paid, the check shows $0.00 due, and Stripe shows exactly one charge.
  - [ ] Killing it after the PaymentIntent was created but before its id was stored: the reconciler finds the same PaymentIntent by its key and cancels it if no attempt ran, or adopts it if it succeeded; no second PaymentIntent exists.
  - [ ] A payment made straight in the sandbox Dashboard lands as unmatched and is never put on a check.
  - [ ] With webhooks switched off for a run, every payment still ends paid, failed or canceled.
  - [ ] Timeouts, a reader dropping mid-payment and missing webhooks all end in a known state, with no attempt left unknown after the reconciler's next run.
- **Tests:** the chaos suite named in [Testing and operations](../spec/13-testing-operations.md), one fault per action; assertions against Stripe's own list of PaymentIntents and charges, not only our rows.
- **Notes:** The data model names no table for Unmatched payments; the cautious default above (`payments.method = 'external'`, no allocation) is flagged for M7.

### M4-13 · Take cash into the drawer at the screen where it's taken

- **Status:** todo
- **Size:** M
- **Depends on:** M4-04, M4-08; M3 (print jobs and the desktop app's USB print host); M1 (devices)
- **Spec:** [Money rules](../spec/05-money-rules.md) rule 15; [Payment flows](../spec/07-payment-flows.md#room-close-out) (Cash); [Devices, printing and offline](../spec/09-devices-printing-offline.md) (Cash drawers at West 4, Cash drawer); [Data model](../spec/04-data-model.md) (`cash_drawers`, `drawer_sessions`, `drawer_moves`, `staff_banks`); [API](../spec/08-api.md) (Payments; `POST /drawers/{d}/open`); [screens: N21](../screens.md#n21-close-out-steps-and-card-states), [Board note 18](../screens.md#board)
- **Build:**
  - Tables `cash_drawers` (name, station, printer_device_id), `drawer_sessions` (the house model for now), `drawer_moves` (sale and refund moves now; paid-out, drop, no-sale and tip-out come in M7) and `staff_banks`.
  - West 4's two drawers: the bar drawer on the bar receipt printer's kick port and the front-desk drawer on the front-desk printer. `PATCH /devices/{d}` pairs the bar computer with the bar drawer and the front-desk computer with the front-desk drawer (`devices.cash_drawer_id`). Admin → Printers & devices shows both drawers with their printers.
  - Each house drawer's session opens at the start of the business date with `drawer.startingBankCents` ($300.00), its model read from the `drawer` setting then, so cash always has somewhere to go; `POST /drawers/{d}/open` does it by hand. Blind counts, handovers and closing come in M7.
  - `POST /checks/{c}/payments` with `method: cash`, `amount`, the amount handed over and any cash tip: records the payment (captured when inserted), the amount handed over, the change, the tip and the drawer session of the screen's paired drawer; a `drawer_moves` sale row with who took it and at which screen; and the drawer opens through its printer's kick port (a network printer's job carries the kick; a USB printer's goes through the desktop app's print host).
  - Cash taken on a staff phone goes into that person's `staff_banks` row for the business date, and no drawer opens; the drop into a drawer comes in M7.
  - The cash panel: Exact, the next $5, $10 or $20, or Other; the change due in large type; "Wrong amount? Fix the change"; a cash-tip field; and the log line "Logged to Maya · bar drawer".
  - The drawer opens only for a cash payment (or an approved no-sale in M7), and every opening is logged against the open session and the person.
- **Acceptance:**
  - [ ] Diego takes Room 9's $498.60 in cash at the front desk with $500.00 handed over: $1.40 change in large type, the front-desk drawer opens, and the log reads "Logged to Diego · front-desk drawer".
  - [ ] Room 5's $51.55 with "the next $20" ($60.00) shows $8.45 change; "Wrong amount? Fix the change" to $100.00 shows $48.45, and the $51.55 payment and the drawer's expected cash don't change.
  - [ ] Cash Andy takes on his phone goes into his staff bank and opens no drawer.
  - [ ] A cash payment row can't be changed after insert.
  - [ ] A $5.00 cash tip on a room check is stored as the payment's tip (the receipt calls it "Additional tip (optional)", M4-19).
- **Tests:** integration (the kick in a CloudPRNT job, and through the USB print host in the desktop app's test harness); unit tests for the next-$5, $10 and $20 buttons; end-to-end cash on DeskRoom and the Room phone.
- **Notes:** The canvas shows one "House drawer"; build two ([Board note 18](../screens.md#board)). Spec gaps, with cautious defaults: the data model says a cash payment never changes after insert, while "Wrong amount? Fix the change" changes the change, so keep the payment row as inserted and record the corrected amount handed over and change in a nullable `detail` column on `payment_events` (an expand-only migration); and nothing says when a house drawer's session opens, so a job opens it at the business date's start with the starting bank.

### M4-14 · Split a check evenly or by item, kept on the server

- **Status:** todo
- **Size:** M
- **Depends on:** M4-06, M4-11, M4-13
- **Spec:** [Money rules](../spec/05-money-rules.md) rules 1 and 13; [Payment flows](../spec/07-payment-flows.md#room-close-out) (Split); [Data model](../spec/04-data-model.md) (`check_splits`, `split_shares`, `payment_allocations.share_id`); [API](../spec/08-api.md) (`POST /checks/{c}/splits`, `POST /splits/{s}/stop`); [screens: N21](../screens.md#n21-close-out-steps-and-card-states), [Rail note 2](../screens.md#rail)
- **Build:**
  - Tables `check_splits` (share_count, base_cents, created_by, ended_by, ended_at) and `split_shares` (share_no, kind even or items, amount_cents, tax_cents, gratuity_cents, line_ids, room_guest_id, state open, paying or paid); one open split per check.
  - `POST /checks/{c}/splits`: even (N shares of what's left to pay, leftover cents to the first shares) or by item (each person's items plus an even part of room time and lines nobody claimed, with tax and gratuity shared by largest remainder). `base_cents` is what was left to pay when the split started; for a room, when the check was presented.
  - Each share pays through `POST /checks/{c}/payments` with its `share_id`, by tap, card on file or cash, with `portion_key` `share:<split_share_id>` and its own state; each card gets its own card-fee calculation (M4-25).
  - The next charge is always the rest. `POST /splits/{s}/stop` ("Stop splitting · charge the rest to …") ends the split and keeps the paid shares. A split survives leaving the screen and switching devices.
  - The check shows `partly_paid` until its allocations cover the amount due.
- **Acceptance:**
  - [ ] Room 9's $498.60 split evenly three ways shows three $166.20 shares; paying share 1 by tap and share 2 in cash, then leaving and reopening the room tab, still shows both paid and $166.20 left.
  - [ ] Every split adds up to the cent: the shares, their tax parts and their gratuity parts each sum to the check's.
  - [ ] Two shares can be paid at once on the two readers, and the same share can't be paid twice.
  - [ ] After one paid share, "Stop splitting · charge the rest to …" charges the rest as one payment and keeps share 1 paid.
  - [ ] A split by item gives each person their own items and an even part of the room time, with tax and gratuity by largest remainder.
- **Tests:** the money-cases group `splits` (including `split_even_room9_in_3`); property tests (shares add up, differ by at most 1 cent, the first shares are the larger ones); integration with two simulated readers at once; end-to-end split on DeskRoom.
- **Notes:** The Rail canvas floors each share and gives the leftover to the last one; build the spec (money-cases ambiguity A11). Splitting by item stays on the room tab; bar tabs split evenly (M6).

### M4-15 · Serve the payment page on its own origin

- **Status:** todo
- **Size:** M
- **Depends on:** M4-01, M4-05; M3 (`apps/guest`)
- **Spec:** [Security and data retention](../spec/12-security-retention.md) 1, 8 and 9; [Stripe setup](../spec/06-stripe-setup.md) step 10; [API](../spec/08-api.md) (`POST /v1/public/pay/{token}`); [Tenancy and access](../spec/02-tenancy-access.md) (Guest with a link)
- **Build:**
  - `apps/guest` serves the payment page only on the `pay.` hostname, from a minimal route group: no website-builder content, no service worker, no analytics; `Cross-Origin-Opener-Policy: same-origin`; `frame-ancestors 'none'`; a nonce- or hash-based Content Security Policy; subresource integrity on our own scripts; and a short list of scripts with a reason for each (Stripe.js from js.stripe.com, and the page's own bundle).
  - A changed-script and header check on every deploy and weekly: it loads the live page, compares its scripts, hashes and headers with the list, and fails the deploy or alerts on any change.
  - Stripe.js with our publishable key and the venue's account (`stripeAccount`) and the Payment Element (Apple Pay, Google Pay, card); the API creates each PaymentIntent on the venue's account, so these are direct charges.
  - `POST /v1/payment_method_domains` on West 4's account (with `Stripe-Account`) for the payment page's domain, and staging's, so Apple Pay and Google Pay show.
  - Pay links: `POST /v1/public/pay/{token}` takes a 128-bit token, stored hashed, that names one payment (in M4, a check's balance after a declined card on file; deposits and staff payment links in M5), returns the PaymentIntent's client secret, and reuses the same PaymentIntent on every retry.
  - Token routes send `Referrer-Policy: no-referrer` and `Cache-Control: no-store` and stay out of CDN logs.
  - While the server waits for Stripe's answer, the page says it's still checking and never shows a second pay button.
- **Acceptance:**
  - [ ] The page's headers include COOP same-origin, a CSP with nonces and `frame-ancestors 'none'`, and no service worker registers.
  - [ ] An unlisted script added to the page fails the check in CI.
  - [ ] Apple Pay and Google Pay show on the sandbox page, because the domain is registered on West 4's account.
  - [ ] Reloading a pay link reuses its PaymentIntent.
  - [ ] A wrong or expired token answers not found.
- **Tests:** header and CSP snapshot tests; the changed-script check as a CI job and a weekly scheduled job; Playwright on the page; principal suite (Guest with a link).
- **Notes:** This is GA-M9's payment-page part; the rest of GA-M9 closes in M8. Which PCI validation we file, and what script-protection confirmation venues get, is the QSA's (gate). Security 1 lets Stripe-hosted Checkout replace this page if it proves heavy; that's the founder's call, not this ticket's. M5's done-when runs these checks again for the booking deposit.

### M4-16 · Show "Your bill" on the room page and the booking link

- **Status:** todo
- **Size:** M
- **Depends on:** M4-08, M4-15; M3 (the room page, tablets, room calls)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#room-close-out) (The guest's bill); [API](../spec/08-api.md) (`GET /v1/public/room-session/bill`); [screens: N5](../screens.md#n5-your-bill), [N4](../screens.md#n4-room-tablet-kiosk), [Order notes 4 and 13](../screens.md#order)
- **Build:**
  - After Present, joined phones show "Your bill is ready · ordering is closed" with the bill link, and the guest's booking link opens the same bill.
  - `GET /v1/public/room-session/bill`: the itemized total, the deposit (−$120.00), tax, the 20% gratuity, the amount due, and each payment as it lands ("Paid by a guest · Kevin (share 1 of 12) $41.55").
  - Ways to pay: "Pay with Amex ··1005" (the guest's confirmation of the card on file, M4-17); "Pay another way" (the Payment Element on the payment page for the amount due); "Pay cash to staff", which raises a room call of kind `check` so staff come with the cash panel; and Pay my share when `pay.payShare` is on (M4-18).
  - Paid: the receipt link (M4-19). Reopened: ordering opens again, and the bill shows the new revision after the next Present.
  - The room tablet shows "Your bill is ready · ordering is closed" and no pay buttons.
  - The page follows the room's channel (`check.updated`, `payment.updated`).
- **Acceptance:**
  - [ ] Room 9's bill after Present reads room time $322.00, drinks $158.00, tax $42.60, gratuity $96.00, total $618.60, deposit −$120.00 and $498.60 due.
  - [ ] "Pay cash to staff" is on every bill, and tapping it reaches the Board and every staff phone's Calls list.
  - [ ] Marcus's booking link shows the same bill as Kevin's room page.
  - [ ] After Andy reopens #1042 and presents again, the bill shows revision 2.
  - [ ] The bill passes the WCAG 2.2 AA checks.
- **Tests:** end-to-end on the seed (Room 9's phone, its tablet and Marcus's booking link); accessibility checks (axe) in CI on the bill.
- **Notes:** The canvas has no bill state, and its "Tonight so far" is before tax and gratuity ([Order note 4](../screens.md#order)). "Pay cash to staff" as a `check` room call is a cautious reading: `room_calls` has a `check` kind and the spec names no other way for the tap to reach staff.

### M4-17 · Charge the card on file with the guest's OK or a manager's approval

- **Status:** todo
- **Size:** M
- **Depends on:** M4-05, M4-15, M4-16; M2 (approvals, the Approvals inbox, texts)
- **Spec:** [Payment flows](../spec/07-payment-flows.md#room-close-out) (Card on file); [API](../spec/08-api.md) (Payments; `POST /v1/public/room-session/payments/{p}/confirm`; `POST /v1/public/bookings/{token}/payments/{p}/confirm`; Approvals); [Data model](../spec/04-data-model.md) (`approvals` kind `card_on_file`, `payments.mit_reason`); [Song systems and texts](../spec/11-song-systems-texts.md) (Receipt and Payment link texts); [screens: N8](../screens.md#n8-confirm-the-card-on-file), [N18](../screens.md#n18-approvals-inbox)
- **Build:**
  - `POST /checks/{c}/payments` with `method: card_on_file` and `amount`, never more than the amount due: a pending payment with an in-progress allocation, and staff see "Waiting for Marcus to confirm on his phone · Cancel".
  - The guest confirms with "Pay with Amex ··1005" on the bill (`POST /v1/public/room-session/payments/{p}/confirm`) or from the booking link (`POST /v1/public/bookings/{token}/payments/{p}/confirm`); the API then creates the PaymentIntent with the booking's saved card and Customer, `off_session=true` and `confirm=true`, keyed `<payment_id>:off_session:<n>`.
  - Guest has left: staff tap "Ask a manager to approve" with a reason; the API answers `202 approval_pending` (kind `card_on_file`), routed to the manager on duty (Andy's own requests to Abhishek); on approval the charge runs with the reason in `mit_reason`.
  - On success, an itemized receipt is texted at once (M4-19).
  - Declined, or `requires_action`: staff see "Declined · try another card or cash", and the guest is texted a pay link for the balance (the Payment link text) that opens the payment page.
  - Cancel releases the allocation.
- **Acceptance:**
  - [ ] Andy picks Card on file on Room 9: DeskRoom shows "Waiting for Marcus to confirm on his phone · Cancel"; Marcus taps "Pay with Amex ··1005"; $498.60 is charged off-session, #1042 is paid and the receipt text reaches his number.
  - [ ] With Marcus gone, Diego's "Ask a manager to approve" lands in Andy's Approvals inbox, Diego sees "Waiting for Andy", the charge runs only after Andy approves on his own phone, and `mit_reason` holds Diego's reason.
  - [ ] Andy's own request goes to Abhishek; nobody approves their own request or approves on the requester's device.
  - [ ] A saved card that declines shows "Declined · try another card or cash" and texts Marcus a pay link that pays the same balance.
  - [ ] While Marcus hasn't confirmed, nobody can start a second payment for the same amount.
- **Tests:** sandbox integration (a saved test card; Stripe's test card that attaches but declines charges, 4000 0000 0000 0341); approval routing and role tests; end-to-end on DeskRoom, the Room phone and the guest's bill.
- **Notes:** The canvas goes "Ask Marcus to confirm" → Paid ([DeskRoom note 2](../screens.md#deskroom)). The guest isn't texted to confirm: they confirm from the bill or the booking link, as the spec says. Online cards cost 2.9% + 30¢.

### M4-18 · Let guests pay their own share

- **Status:** todo
- **Size:** M
- **Depends on:** M4-14, M4-15, M4-16
- **Spec:** [Money rules](../spec/05-money-rules.md) rule 13 (Pay my share); [Payment flows](../spec/07-payment-flows.md#room-close-out) (Pay my share); [Stripe setup](../spec/06-stripe-setup.md) step 10; [API](../spec/08-api.md) (`POST /v1/public/room-session/shares`); [Data model](../spec/04-data-model.md) (`split_shares.room_guest_id`, `payment_allocations.room_guest_id`); [screens: N6](../screens.md#n6-pay-my-share), [Room note 7](../screens.md#room), [DeskRoom note 9](../screens.md#deskroom)
- **Build:**
  - With `pay.payShare` on (West 4), the bill offers Pay my share: "My items" (the guest's items ordered from their phone, as a split by item) or "An even share (1 of N)".
  - The Pay my share split: `check_splits` with `share_count` starting at the party size and `base_cents` what was left to pay when the check was presented, so a share doesn't change as others pay; leftover cents to the first shares; each guest's share is a `split_shares` row with their `room_guest_id`.
  - `POST /v1/public/room-session/shares` starts the guest's share and returns it with a PaymentIntent (`card_online`) for the Payment Element on the payment page: no tip prompt, and a share saves no card (no `setup_future_usage`).
  - No payment goes over what's still due: if others paid in the meantime, the share offered is what's left, shown before paying.
  - Each payment is an allocation naming the guest, shown on the room tab (DeskRoom and the Room phone) as "Paid by a guest · Kevin (share 1 of 12) $41.55"; the booker's card still guarantees the rest.
  - The page's return has the server fetch the PaymentIntent through the state machine; `payment_intent.succeeded` and the reconciler cover a closed page.
- **Acceptance:**
  - [ ] Twelve guests on Room 9 each pay 1 of 12 of $498.60: twelve $41.55 payments, each showing its $3.55 of tax and $8.00 of gratuity first, and #1042 is paid to the cent.
  - [ ] Kevin's payment shows on DeskRoom as "Paid by a guest · Kevin (share 1 of 12) $41.55" within seconds.
  - [ ] With the margaritas accepted first, shares 1 to 3 are $44.35 and shares 4 to 12 are $44.34, adding up to $532.11.
  - [ ] When 10 guests have paid and staff take the other $83.10 on the reader, the last two guests see nothing left to pay.
  - [ ] Two guests paying at once each get their own share, and no share is paid twice.
  - [ ] With `pay.payShare` off, the bill shows no Pay my share and the route refuses.
- **Tests:** the money-cases group `pay_my_share`; sandbox integration through the Payment Element (Playwright filling Stripe's frame with test cards); a concurrency test with 12 guests; the end-to-end `pay_my_share` scenario.
- **Notes:** The spec doesn't say whether "My items" includes a part of room time and of lines nobody claimed. Cautious default: build it as rule 13's split by item (own items plus an even part of room time and unclaimed lines over the party size), so the shares add up to the bill; flagged for the founder. No error code is named for Pay my share being off; use `403 forbidden`. It's a setting because an online card costs 2.9% + 30¢ against 2.7% + 5¢ in person.

### M4-19 · Print, text and email receipts, and serve the public receipt page

- **Status:** todo
- **Size:** M
- **Depends on:** M4-07, M4-11, M4-13; M3 (print jobs and the PDF job); M2 (texts); M1 (the email provider)
- **Spec:** [Money rules](../spec/05-money-rules.md) rules 8, 9 and 10; [Payment flows](../spec/07-payment-flows.md#room-close-out) steps 3 and 4; [Data model](../spec/04-data-model.md) (`receipts`); [API](../spec/08-api.md) (`POST /checks/{c}/receipts`, `GET /v1/public/receipts/{token}`); [Song systems and texts](../spec/11-song-systems-texts.md) (the Receipt text); [Security and data retention](../spec/12-security-retention.md) 9; [screens: N2](../screens.md#n2-receipts-printed-and-web)
- **Build:**
  - One receipt model built from the check's latest revision and its payments, rendered four ways that read the same: printed (a receipt `print_jobs` row for the screen's receipt printer), texted (the Receipt text with its link), emailed (HTML with the receipt PDF attached, through the email provider) and the public page (`GET /v1/public/receipts/{token}`, served by `apps/guest`).
  - A room check's receipt: room time with its minutes and rate, drinks and packages, comps and voids as COMP and VOID, tax lines by category, "Gratuity included (20%)", "Deposit −$120.00", the amount due, how it was paid (card brand and last four, cash, each guest's share as "Paid by a guest · Kevin (share 1 of 12) $41.55"), any "Additional tip (optional)" line, and the check number (#1042). A card surcharge, where a venue has one, is its own "Credit card surcharge" line with its tax.
  - A bar tab's receipt (used in M6): items and tax, with "Gratuity included" only where the venue adds a gratuity to bar tabs.
  - `receipts` rows (check_id, payment_id, token_hash, channel, sent_at), and `POST /checks/{c}/receipts` with the channel and, for a text or an email, the number or address.
  - The receipt PDF from the PDF job; it's also the first piece of dispute evidence (M4-24).
  - The web page shows the paid state and, later, the refunded one. Its token is 128 bits, stored hashed, sent with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and expires.
  - Times show in New York time, with EDT or EST.
- **Acceptance:**
  - [ ] Room 9's receipt reads the same printed, texted, emailed and on the public page: every line, "Gratuity included (20%)", tax lines of $28.58 and $14.02, "Deposit −$120.00", the payments and #1042 (a test compares the four renders' text).
  - [ ] The Receipt text goes out in Admin → Texts' wording with the receipt link.
  - [ ] A tip on a room check prints as "Additional tip (optional)", never "Gratuity".
  - [ ] After a refund, the same link shows the refunded state.
  - [ ] A wrong or expired token answers not found.
- **Tests:** snapshot tests of the four renders from one model; end-to-end (the text through Twilio test credentials, the email through the provider's sandbox, print to a CloudPRNT test printer and to a USB printer in the desktop harness); principal suite (receipt tokens).
- **Notes:** The spec says the receipt link expires but not when. Cautious default: 30 days, the same as Twilio's copy of the text, while the emailed PDF stays with the guest; flagged for the founder. TRAINING on receipts comes with training mode in M7.

### M4-20 · Close out a room on DeskRoom and the Room phone

- **Status:** todo
- **Size:** L
- **Depends on:** M4-08, M4-11, M4-13, M4-14, M4-17, M4-18, M4-19
- **Spec:** [Payment flows](../spec/07-payment-flows.md#room-close-out) and [What staff see](../spec/07-payment-flows.md#what-staff-see-during-a-card-payment); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) (rules every staff screen follows, words on every staff screen); [screens: N21](../screens.md#n21-close-out-steps-and-card-states), [DeskRoom](../screens.md#deskroom), [Room](../screens.md#room), [Staff note 4](../screens.md#staff); [glossary](../glossary.md#other-exact-sentences)
- **Build:**
  - The four close-out steps on the room tab, from one codebase in desktop and phone layouts: 1 Present the check (#1042); 2 Ways to pay; 3 "Additional tip (optional)"; 4 Paid, then Text, Email, Print or No receipt, then "Room 9 goes to cleaning".
  - Ways to pay, mixed as needed: Tap at the reader (with the picker), Card on file, Cash (the cash panel), Split (even or by item, each share in its own state), and Pay my share lines as they land. Cash is always offered.
  - Every card state, word for word, on the room tab and on each split share.
  - The staff phone's "Tab & close out →" opens the room tab and never marks a room paid by itself; Reopen reopens the check.
  - Main actions 52 to 64 px tall, the change due in large type, and nothing that needs a swipe or a long press.
- **Acceptance:**
  - [ ] On DeskRoom and on Andy's phone, Room 9 closes out as the seed says: #1042, $618.60, deposit −$120.00, $498.60 to pay, and the reader skips its tip screen.
  - [ ] The card states read exactly "Waiting for a tap on the front-desk reader · Cancel", "Declined · try another card or cash", "Checking with Stripe · don't retry", "Reader offline · use the bar reader", "Reader busy", "Waiting for Marcus to confirm on his phone · Cancel" and "Ask a manager to approve".
  - [ ] After Paid the receipt choices show; once one is picked, "Room 9 goes to cleaning" and its Board tile turns to cleaning.
  - [ ] On the phone, "Tab & close out →" on Priya R.'s row opens Room 3's tab, and no one-tap Done exists anywhere.
  - [ ] In Spanish, every close-out string shows in Spanish with nothing cut off.
- **Tests:** Playwright end-to-end at phone and desktop sizes on the seed (the `room9_closeout` scenario), with each card state driven through the fault-injection client; the language test for the longest Spanish strings.
- **Notes:** The canvas goes straight to "Paid" ([DeskRoom note 2](../screens.md#deskroom), [Room note 2](../screens.md#room)), and the phone's "Close out" marks a room paid with no payment ([Staff note 4](../screens.md#staff)). The training band comes in M7.

### M4-21 · Refund from a paid check, approved on another phone and capped

- **Status:** todo
- **Size:** M
- **Depends on:** M4-05, M4-07, M4-13; M2 (approvals)
- **Spec:** [Money rules](../spec/05-money-rules.md) rules 14 and 16; [Payment flows](../spec/07-payment-flows.md#refunds); [Data model](../spec/04-data-model.md) (`refunds`, `approvals` kind `refund`); [API](../spec/08-api.md) (`POST /checks/{c}/refunds`, `GET /refunds/{r}`, `POST /bookings/{b}/refunds`); [Tenancy and access](../spec/02-tenancy-access.md) (Approvals, roles); [screens: N22](../screens.md#n22-refund-from-check)
- **Build:**
  - `refunds` (payment_id, check_id, amount_cents, reason, status pending, succeeded, failed or canceled, stripe_refund_id, requested_by, approval_id, approved_by, business_date, adjusts_business_date).
  - `POST /checks/{c}/refunds` takes the lines to refund, how much comes off each payment and a reason. Only owners and managers ask. Each payment's part is capped at what it captured minus its earlier refunds (`422 over_refundable`). It answers `202 approval_pending`, routed to someone other than the requester (Andy's to Abhishek), who decides on their own phone.
  - On approval: write the reversing lines first (the item or room time plus its share of tax, gratuity and card fee), then refund each payment with `POST /v1/refunds` on the venue's account, keyed `<payment_id>:refund:<n>`; before capture, capture less or cancel instead.
  - Each refund's status follows `refund.updated` and `refund.failed`: screens show "Refund pending" until it succeeds, then "Refunded". Each success writes a negative `payment_allocations` row (kind refund) so the amount due stays at zero, and the payment becomes `partly_refunded` or `refunded`.
  - A failed refund goes back to the manager with Stripe's reason and leaves the amount owed to the guest, to retry or pay back in cash; a cash refund is a drawer move (`drawer_moves` kind refund).
  - A refund after the night closes posts to the current business date with `adjusts_business_date`.
  - `POST /bookings/{b}/refunds` refunds a deposit on a booking not yet checked in, by the same rules, and sends the Deposit refund text.
  - On a shared screen, a refund asks for the PIN again.
- **Acceptance:**
  - [ ] Andy asks to refund $120.00 of Marcus's deposit: it shows "Waiting for Abhishek" and lands in Abhishek's Approvals inbox, never Andy's.
  - [ ] $120.01 off Marcus's deposit answers `422 over_refundable`; after a $50.00 refund, at most $70.00 more can come off.
  - [ ] After Abhishek approves, screens show "Refund pending" until `refund.updated` says succeeded, then "Refunded"; with that webhook held back in the sandbox, it stays pending.
  - [ ] A refund Stripe fails goes back to Andy with Stripe's reason, and the money stays owed to Marcus.
  - [ ] Diego (front desk) and Maya (bartender) can't ask for a refund.
  - [ ] The check's amount due is $0.00 after a refund succeeds.
- **Tests:** the money-cases group `refunds`; sandbox integration (a refund that fails, with Stripe's refund-failure test card); webhook replays out of order (`refund.failed` then `refund.updated`); approval routing and role tests; chaos (kill after Stripe's refund succeeds and before our record).
- **Notes:** How a partial refund's share of tax and gratuity rounds isn't pinned down (money-cases ambiguity A8). Cautious default: share them by largest remainder of the revision's tax and gratuity lines, so refunding a whole check returns them exactly. The spec says large refunds ask for the passkey again but sets no amount; cautious default: every refund request asks again (the passkey in a passkey session, the PIN on a shared screen). "Refunds over a set amount alert the owner" has no amount either; the exceptions report and alerts come in M7 and M8. The attempt `action` list names no refund action, so the refund key follows the same `<payment_id>:<action>:<n>` pattern. Gratuity refunded after its pool is paid is M7's and waits on the lawyer.

### M4-22 · Offer Refund from check on the staff phone and DeskRoom

- **Status:** todo
- **Size:** S
- **Depends on:** M4-21
- **Spec:** [Payment flows](../spec/07-payment-flows.md#refunds); [screens: N22](../screens.md#n22-refund-from-check), [Staff note 5](../screens.md#staff), [DeskRoom note 8](../screens.md#deskroom)
- **Build:**
  - Refund from check on the staff phone (from the booking) and on DeskRoom (a paid check): pick the check, then the lines, then which payment each amount comes off, then a reason, then "[Send to Abhishek]", the button naming the approver.
  - Progress on the requester's screen: "Waiting for Abhishek", then "Refund pending", then "Refunded", or back to the manager with Stripe's reason.
  - Owners and managers only; the bar POS's Closed tonight gets the same sheet in M6.
- **Acceptance:**
  - [ ] Andy's refund sheet on Marcus's booking starts empty (never pre-filled), caps at $120.00 and ends on "[Send to Abhishek]".
  - [ ] Maya and Diego don't see Refund.
  - [ ] Each state reads right in English and in Spanish.
- **Tests:** end-to-end on the phone and on DeskRoom; role tests.
- **Notes:** The canvas refund sheet is pre-filled with $360.00 on Marcus's $120 deposit and refunds at once ([Staff note 5](../screens.md#staff)).

### M4-23 · Approve a lower party size after the gratuity applies

- **Status:** todo
- **Size:** S
- **Depends on:** M4-07; M2 (the party size control, approvals)
- **Spec:** [Money rules](../spec/05-money-rules.md) rules 3 and 9; [Data model](../spec/04-data-model.md) (`approvals` kind `party_size_down`); [API](../spec/08-api.md) (`POST /sessions/{s}/party-size` answers `202`); [screens: N13](../screens.md#n13-party-size-control), [N18](../screens.md#n18-approvals-inbox)
- **Build:**
  - Lowering the party size on a session whose check carries a gratuity answers `202 approval_pending` (kind `party_size_down`), routed like every approval; the requester sees "Waiting for Andy", and nothing changes until it's approved.
  - On approval: the segment closes and the next opens at the lower size (M2's rule), the gratuity basis's largest party size recorded becomes the approved size, and the next finalize reverses the old gratuity line and writes the new one.
  - Raising the party size never needs approval.
- **Acceptance:**
  - [ ] Diego lowers Room 9 from 12 to 10: "Waiting for Andy" shows, the clock keeps billing 12 until Andy approves on his phone, then bills 10 from that minute.
  - [ ] Andy's own request goes to Abhishek.
  - [ ] After approval and Present, the revision's gratuity basis records a party of 10.
- **Tests:** approval routing tests; `packages/rules` unit tests for the gratuity basis; end-to-end on the Board panel.
- **Notes:** The spec doesn't define when "the gratuity applies". At West 4 every room check carries it from check-in (`pay.gratuity.auto: rooms`), so every lower party size on a room needs approval. That's the cautious reading, since it protects the gratuity basis, but it may slow routine headcount fixes; flagged for the founder. The approval kind also covers "removing the gratuity", but the spec gives no route or screen for that, so none is built.

### M4-24 · Open the disputes inbox with its evidence gathered

- **Status:** todo
- **Size:** M
- **Depends on:** M4-03, M4-19; M2 (files and damage photos)
- **Spec:** [Stripe setup](../spec/06-stripe-setup.md) step 9; [Data model](../spec/04-data-model.md) (`disputes`, `files`); [API](../spec/08-api.md) (`GET /disputes`, `POST /disputes/{d}/evidence`, `/submit`); [screens: N37](../screens.md#n37-admin--payments-disputes-and-unmatched-payments)
- **Build:**
  - `disputes` (payment_id, stripe_dispute_id, reason, amount_cents, status, due_by, evidence_file_ids).
  - `charge.dispute.created` opens an item with its evidence already gathered: the itemized receipt PDF, the room clock times (the session's segments), the booking with the policy version the guest accepted and when (`bookings.policy_version_id`, `accepted_at`, `accepted_ip`, `accepted_ua`), damage photos, and who served (the accepting and delivering staff on the check's orders). For a bar tab, the order times and the tip picked on the reader join in M6.
  - The files go up through Stripe's Files API (`purpose=dispute_evidence`) on the venue's account and attach to the dispute's evidence; `POST /disputes/{d}/evidence` adds or replaces a piece; `POST /disputes/{d}/submit` submits before `due_by`.
  - `charge.dispute.closed`, `funds_withdrawn` and `funds_reinstated` update the item and are kept for the journal, which M7 posts.
  - Admin → Disputes, for owners and managers in a passkey session: the inbox with each deadline, the evidence gathered, and Submit.
- **Acceptance:**
  - [ ] A sandbox room-check payment on Stripe's dispute test card (4000 0000 0000 0259) opens a dispute that shows in the inbox with its due date, and with the receipt PDF, the clock times, the booking's accepted policy (where there is one), any damage photos and who served already attached.
  - [ ] Submit sends the evidence to Stripe, and the item shows it was submitted.
  - [ ] Maya and Diego can't open the inbox.
  - [ ] `charge.dispute.closed` marks it won or lost, and funds withdrawn and reinstated are recorded with their amounts.
- **Tests:** sandbox integration with the dispute test card; webhook replays; principal suite.
- **Notes:** Closes GA-S10. Bookings made by staff before M5 carry no accepted policy, so their disputes go without that piece.

### M4-25 · Build the card-fee engine, off at West 4

- **Status:** todo
- **Size:** M
- **Depends on:** M4-01, M4-06, M4-11, M4-13
- **Spec:** [Money rules](../spec/05-money-rules.md) rule 10; [Payment flows](../spec/07-payment-flows.md#card-fee-at-the-reader-off-at-west-4); [Settings](../spec/03-settings-rule-packs-modules.md) (`CardFee`, the rule pack's `cardFee` and `salesTax.surchargeTaxable`); [Open technical questions](../spec/14-open-questions.md); [milestones: GA-M1](../milestones.md#must-fix-items-and-where-they-close)
- **Build:**
  - `pay.cardFee` modes off (West 4), surcharge (credit only, one rate) and discount, checked against the rule pack on every save: the surcharge is capped at the in-person card cost (2.7%) and the networks' 3%, applies only to credit cards, and starts only 30 days after `noticeSentOn`.
  - Surcharge at the reader: `collect_payment_method` instead of processing in one step; the `terminal.reader.action_updated` webhook carries the collected card, whose funding type decides; for credit, update the PaymentIntent's `amount` and set `amount_details[surcharge][amount]` through Stripe's surcharge API (preview version `2026-03-25.preview`, used only on this path); the guest sees the new total within Stripe's 30-second window between collecting and confirming; then `confirm_payment_intent`; on success write the `card_surcharge` line and its tax line for that payment. Debit and prepaid cards change nothing.
  - The surcharge is worked on the amount going onto that card, before any tip, and each split share's card gets its own.
  - Cash discount: a `cash_discount` line and a matching tax reduction when the cash is taken.
  - A refund returns the same share of the fee and its tax.
  - With a surcharge on, every price shows the credit price (one display function that every screen, the site and receipts use).
  - The surcharge path stays behind a venue flag that we turn on only after its sandbox test passes and Stripe answers the open questions.
- **Acceptance:**
  - [ ] On a test venue with a 2.7% surcharge, Room 9's $498.60 on a credit card shows the guest $512.06 before confirming, and writes a $13.46 `card_surcharge` line plus $1.19 of tax on it while `surchargeTaxable` is on ($513.25 in all).
  - [ ] The same payment on a debit card, or in cash, stays $498.60.
  - [ ] A 3.5% surcharge (West 4's old fee) can't be saved, with the rule-pack reason; neither can a surcharge that starts less than 30 days after its notice date.
  - [ ] With the fee off, no West 4 screen shows a surcharge.
  - [ ] Refunding the whole surcharged payment returns the $13.46 and its tax.
- **Tests:** the money-cases group `card_fee`; a sandbox test of the whole collect → update → confirm path on simulated readers with credit and debit test cards; rule-pack validation tests.
- **Notes:** Closes GA-M1. Open questions, none of which blocks the gate since the fee is off at West 4: whether a server-driven reader can show a changed amount between collect and confirm (Stripe); whether a tip on the reader is part of the surcharged amount (Stripe, then the lawyer); whether a surcharge is taxable (the accountant; `surchargeTaxable` stays on until then); and how debit is treated under a cash discount (the lawyer; debit pays the card price until then). A surcharge can't rise with a growing hold, so bar tabs with the fee on close with a fresh tap (M6).

### M4-26 · Build Admin → Card fee & gratuity

- **Status:** todo
- **Size:** S
- **Depends on:** M4-02, M4-25; M1 (settings and Admin)
- **Spec:** [Settings](../spec/03-settings-rule-packs-modules.md) (`PaySettings`); [Tenancy and access](../spec/02-tenancy-access.md) (card-fee changes ask for the passkey again); [milestones: Admin by milestone](../milestones.md#admin-by-milestone); [screens: AdminDesk notes 18 and 26](../screens.md#admindesk)
- **Build:**
  - One section editing `pay`: the card fee (off at West 4), with a preview whose tax line follows `salesTax.surchargeTaxable`; the gratuity (`auto` off, rooms, parties or all; `pct`; `partyMin` for parties), always labeled "Gratuity"; the reader's tip screen (on; 18, 20 and 22%; $1, $2 and $3 under $10), whose save updates the Terminal Configuration and says readers can take up to 5 minutes; tip review (25%, $50, 2 hours); and Pay my share (on).
  - A card-fee change asks for the passkey again; every save runs the rule-pack checks, writes new versions and sends `settings.changed`.
- **Acceptance:**
  - [ ] West 4 shows the card fee off, a 20% gratuity on rooms, tips of 18, 20 and 22%, tip review at 25%, $50 and 2 hours, and Pay my share on.
  - [ ] A change to the tip choices reaches both readers' configuration.
  - [ ] No PIN session opens the section, and a card-fee change asks for the passkey again.
- **Tests:** settings validation tests; principal suite; end-to-end in Admin.
- **Notes:** The canvas's surcharge preview adds no tax on the surcharge ([AdminDesk note 18](../screens.md#admindesk)). `pay.pool` is M7's. `pay.roomHold` is off at West 4 and in no milestone ([Open points](#open-points)).

### M4-27 · Add minimum spend, off at West 4

- **Status:** todo
- **Size:** M
- **Depends on:** M4-06, M4-08; M2 (check-in, tiles, DeskRoom, Admin → Hours & prices); M3 (the room page)
- **Spec:** [Money rules](../spec/05-money-rules.md) rule 6 (Minimum spend); [Settings](../spec/03-settings-rule-packs-modules.md) (`prices.minSpend`); [Data model](../spec/04-data-model.md) (`room_sessions.min_spend_cents`, `check_lines` kind `min_spend`); [screens: Board note 21](../screens.md#board), [Order note 14](../screens.md#order), [AdminDesk note 23](../screens.md#admindesk)
- **Build:**
  - `prices.minSpend` rows (room size tier, business-date weekdays, band or all night, cents), edited in Admin → Hours & prices; empty at West 4, where Admin shows it off.
  - Check-in copies the minimum that applies into `room_sessions.min_spend_cents`: the big-party minimum when that rule applies, otherwise the one in `prices`.
  - Spend toward it is items and songs after comps, before tax and gratuity. The tile, DeskRoom and the room page show what's left ("$84 to your minimum").
  - Present adds any shortfall as a `min_spend` line (tax category `fee`), one of the computed lines each finalize reverses and writes again.
- **Acceptance:**
  - [ ] On a test venue with a $300.00 Friday minimum for large rooms, a session with $216.00 of drinks shows "$84 to your minimum" on the tile, DeskRoom and the room page, and Present adds an $84.00 `min_spend` line.
  - [ ] Room time doesn't count toward the minimum, and a comp lowers the spend.
  - [ ] At West 4, no tile, room tab or room page shows anything for it.
- **Tests:** `packages/rules` unit tests for the shortfall and its revisions; end-to-end on a test venue; a seed test that West 4 shows nothing.
- **Notes:** K4. Spec gap: rule 6 copies "the big-party minimum", but `DepositRule.bigParty` has no minimum field; the seed adds `minSpendCents: 0`. Cautious default: add that field to the settings type as the seed has it, 0 at West 4. Crediting the minimum against the room fee is phase 2.

### M4-28 · Reserve the prepaid-value ledger and session merges

- **Status:** todo
- **Size:** M
- **Depends on:** M4-04, M4-07, M4-09
- **Spec:** [Money rules](../spec/05-money-rules.md) rules 11, 12 and 16; [Data model](../spec/04-data-model.md) (`prepaid_accounts`, `prepaid_ledger`, `room_sessions` merges, `payments.method` prepaid); [decisions](../decisions.md) (D83)
- **Build:**
  - `prepaid_accounts` (kind, code_hash, guest_id, singer_id, issued_at, expires_on, status) and `prepaid_ledger` (account_id, kind issued, redeemed, expired or refunded, amount_cents, payment_id, check_id, by, at, business_date). A balance is the sum of its ledger rows, never a stored number.
  - Service functions with no routes and no screens: issue (money in, a liability), redeem onto a check (a `prepaid` payment and its allocation), expire, and refund (back to the paying card through the refund engine). None can take a balance below zero.
  - Each ledger kind maps to the prepaid-value account that M7's nightly journal posts.
  - Merging two sessions, with no route and no screen: the second session's `check_id` points at the first's check; its lines move as `transfer_out` and `transfer_in` lines in one transaction; its deposit or hold allocations move with them (the old allocation released and the same amount inserted on the first check), so both guarantees stay; each session keeps its own room and segments.
- **Acceptance:**
  - [ ] Issue $50.00, redeem $30.00 onto a check, expire $5.00 and refund $15.00: the balance reads $50.00, $20.00, $15.00 and $0.00, and the ledger sums match at every step.
  - [ ] Redeeming more than the balance is refused.
  - [ ] Merging Room 10's session into Room 9's keeps both deposits ($120.00 and $90.00) allocated to one check, both sessions' segments bill as before, and the merged amount due is the two checks' sum.
  - [ ] Merging a session whose check carries a card hold (on a test venue with room holds) keeps that hold's allocation on the merged check.
- **Tests:** property tests for the ledger (the balance is the sum, never negative); integration tests of a merge with a deposit and with a hold; the principal suite finds no route for either.
- **Notes:** K5 and K9 reservations: gift cards are phase 2 and stored value phase 3, and merges have no screen in phase 1. M6 uses the ledger for song credit bought at a song price (none at West 4).

### M4-29 · Run the go-live checklist for West 4

- **Status:** todo
- **Size:** S
- **Depends on:** M4-01, M4-02
- **Spec:** [milestones: M4](../milestones.md#m4--payments-and-receipts) (the go-live checklist); [Stripe setup](../spec/06-stripe-setup.md) steps 3 and 11; [Scope and architecture](../spec/01-scope-architecture.md) (When our cloud is down); [screens: Setup note 8](../screens.md#setup), [Setup note 10](../screens.md#setup)
- **Build:**
  - A checklist in Admin → Payments (owner) with three checks: West 4's Stripe account has the merchant category set for the venue, read from the account; each manager (and the owner) has a Stripe Dashboard login on West 4's account that can take payments; and each has a phone that runs Tap to Pay (an iPhone XS or later, or a supported Android phone). The owner confirms the last two for each person, with who and when.
  - Turning on Bar tabs & quick sale (`PATCH /modules/{id}`) is refused, with the reason, until the merchant category check passes.
  - The Console's venue list reads the same rows, so Admin and the Console never disagree.
- **Acceptance:**
  - [ ] With the merchant category not yet checked, turning on Bar tabs & quick sale is refused with the reason.
  - [ ] The checklist shows Andy and Abhishek each with a Dashboard login and a Tap to Pay phone confirmed, and passes for West 4.
  - [ ] The Console shows the same state for West 4.
- **Tests:** the module-guard test; principal suite (owner only); end-to-end.
- **Notes:** Stripe has no API that lists Dashboard users, so those two checks are the owner's confirmation. Which merchant category fits a karaoke bar is open with Stripe ([Open technical questions](../spec/14-open-questions.md)): the checklist stores the category we expect for the venue and checks the account against it. The spec names no table for these checks, only "the same rows" as Setup and the Console; cautious default: a small `setup_checks` table (venue_id, key, status, confirmed_by, confirmed_at), flagged. The outage drill (M8) uses these logins.

### M4-30 · Prove Room 9's close-outs end to end and run the live payment drill

- **Status:** todo
- **Size:** M
- **Depends on:** M4-01 to M4-29; outside: West 4's onboarding and both S710s registered to its Location
- **Spec:** [milestones: M4 done when](../milestones.md#m4--payments-and-receipts); [Testing and operations](../spec/13-testing-operations.md) (Tests, Environments); [demo seed: Things to try](../demo-seed.md#things-to-try)
- **Build:**
  - End-to-end suites (Playwright and the connected sandbox), each from a fresh seed load: Room 9 by one tap; Room 9 by 12 Pay my share payments; Room 9 split evenly three ways with one share in cash; revision 2 through Reopen; Marcus's refund; a sandbox dispute; one receipt four ways; the ledger and merge tests; the checklist.
  - A live drill runbook and script: small live payments on West 4's own account on the Bar S710 and the Front desk S710, captured and then refunded, with forced timeouts (a reader's network pulled mid-payment, and a drill-only venue flag that drops our copy of Stripe's answer for the drill's payments).
  - The drill's record: who, when, amounts and Stripe ids.
- **Acceptance:**
  - [ ] The chaos suite (M4-12) passes in CI and blocks a merge when it fails.
  - [ ] On the connected sandbox, Room 9 closes out as the seed says ($618.60, −$120.00, $498.60) by one tap; by 12 payments of $41.55; and by an even split of three $166.20 shares with one in cash; every split adds up to the cent.
  - [ ] Reopening #1042 and accepting the 2 × Margarita · Peach writes revision 2 at $652.11 with $532.11 left.
  - [ ] Live payments on both S710s are captured and refunded, and under forced timeouts Stripe's live Dashboard shows no double charge.
  - [ ] Andy's refund waits in Abhishek's inbox, can't go over $120.00, and shows "Refunded" only after Stripe confirms.
  - [ ] A sandbox dispute shows in the inbox with its evidence gathered.
  - [ ] Room 9's receipt reads the same printed, texted, emailed and on the public page.
  - [ ] The ledger and merge tests pass, and the go-live checklist passes for West 4.
- **Tests:** the suites above in CI against the sandbox, and the recorded live drill.
- **Notes:** The drill-only flag must never be set outside the drill's hour; the runbook says who sets and clears it.

## Coverage

Every "Ships" item, done-when line, Admin section and must-fix item of M4 in [milestones.md](../milestones.md#m4--payments-and-receipts), and the tickets that build it.

| Milestone item | Tickets |
| --- | --- |
| Ships: Stripe for West 4 | M4-01, M4-02, M4-03 |
| Ships: The payment core | M4-04, M4-05, M4-12 |
| Ships: Checks | M4-06, M4-07, M4-08, M4-25 |
| Ships: Room close-out | M4-11, M4-13, M4-14, M4-17, M4-20 |
| Ships: Pay my share (K2) | M4-15, M4-16, M4-18 |
| Ships: Two cash drawers | M4-13 |
| Ships: Minimum spend (K4) | M4-27 |
| Ships: Refunds | M4-21, M4-22, M4-17, M4-23 |
| Ships: Receipts | M4-19 |
| Ships: Disputes | M4-24 |
| Ships: Data-model reservations, no screens | M4-28 |
| Ships: The go-live checklist | M4-29 |
| Ships: Canvas boards | M4-16, M4-17, M4-20, M4-19, M4-22, M4-24, M4-26 |
| Done when: The chaos tests pass | M4-12, M4-30 |
| Done when: On the connected sandbox, Room 9 closes out | M4-08, M4-11, M4-14, M4-18, M4-20, M4-30 |
| Done when: Small live payments on West 4's own account | M4-30 |
| Done when: A refund Andy asks for | M4-21, M4-22, M4-30 |
| Done when: A dispute opened in the sandbox | M4-24, M4-30 |
| Done when: A receipt reads the same | M4-19, M4-30 |
| Done when: Tests prove the prepaid-value ledger | M4-28, M4-30 |
| Done when: The go-live checklist passes | M4-29, M4-30 |
| Admin: Hours & prices (minimum spend) | M4-27 |
| Admin: Printers & devices (drawers and readers) | M4-02, M4-13 |
| Admin: Card fee & gratuity | M4-26 |
| Admin: Payments (owner only) | M4-01, M4-29 |
| Admin: Connections (Stripe, Twilio and email) | M4-01 |
| Must-fix: GA-M1 (card fee) | M4-25, M4-26 |
| Must-fix: GA-M4 (tax lines and check numbers in M4) | M4-06, M4-07 |
| Must-fix: GA-M9 (the payment page in M4) | M4-15 |
| Should-have: GA-S3 (each share's tax and gratuity) | M4-14, M4-18 |
| Should-have: GA-S10 (the dispute inbox) | M4-24 |
| Nice-to-have: GA-N2 (the prepaid-value ledger) | M4-28 |

## Open points

Spec gaps met while writing these tickets, each built with the cautious default its ticket names:

- **The plan's size.** These tickets add up to about 52 to 78 working days against milestones.md's 3–4 weeks.
- **Revision 2 in the done-when** (M4-08): Present is refused while o1 rings, so revision 2 comes through Reopen, as money case `room9_reopen_check_revision2` does.
- **Keys the spec doesn't name** (M4-05, M4-21): the PaymentIntent's create call (`<payment_id>:create`) and refunds (`<payment_id>:refund:<n>`).
- **Unmatched payments has no table** (M4-12): `payments.method = 'external'` with no allocation until M7 builds the list.
- **The 20-second rule** (M4-11) also catches a guest who is slow to tap.
- **"Wrong amount? Fix the change"** against "a cash payment never changes after insert", and **when a house drawer session opens** (M4-13).
- **"My items"** and room time, and **no error code** for Pay my share being off (M4-18).
- **The receipt link's lifetime** (M4-19).
- **"Large refunds"** and **"refunds over a set amount"** have no amounts, and **partial-refund rounding** is ambiguity A8 (M4-21).
- **When "the gratuity applies"**, and **no route to remove a gratuity** (M4-23).
- **The big-party minimum** has no field in `DepositRule` (M4-27), and **taxed categories** have no field in the rule pack's type (M4-06).
- **The go-live checklist's rows** aren't named, and **the merchant category** is open with Stripe (M4-29).
- **Seed cards** can't be Stripe test cards, so display fields come from the seed (M4-10).
- **`pay.roomHold`** (a card hold at room check-in for venues without deposits) is in the settings and in M6's move-to-room rules, but in no milestone's "Ships". It's off at West 4 and not built here.
