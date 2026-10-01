# M1 · Foundations

The backlog for [M1 · Foundations](../milestones.md#m1--foundations), ticket by ticket. The [spec](../spec/README.md) decides how each piece works, [screens](../screens.md) says where to build differently from the frozen canvas, and the [demo seed](../demo-seed.md) supplies the names and numbers in every check. Where a ticket had to pick something the spec doesn't say, its Notes say so and name the cautious default it builds.

## Goal

The team signs in on paired devices; Admin edits hours, the team and features.

## Done when

Copied from [milestones.md](../milestones.md#m1--foundations):

- The principal suite calls every route as every principal, and the venue-wall suite calls every endpoint, job and webhook as venue A with venue B's ids. Both pass in CI and block a merge when they fail.
- In staging, Maya takes over the paired bar computer with a badge tap in under 2 seconds, and with name and PIN when her badge is at home. Andy opens Admin with a passkey, and a test shows no PIN session reaches any Admin route.
- A copied badge and a replayed badge read are both refused.
- Five wrong PINs lock that person on that device for 1, then 5, then 15 minutes. Ten wrong tries across names pause PIN sign-in on that device and alert the manager's phone, and the device's alarm channel keeps working.
- A settings save that breaks the rule pack is refused with the reason. A rule-pack version can't publish with one approver, and it applies at the next business-date boundary.
- Turning off Bar screen & tickets while Ordering from the room is on shows "Room orders would have nowhere to ring. Turn off Ordering from the room too?". Every route of a module that's off answers `404 module_off`.
- Killing the desktop app brings it back through the watchdog, and restarting the computer starts it at login, with nobody touching either.
- Diego switches to Español and every M1 staff screen is in Spanish. CI fails a build with a staff string missing in either language.
- Deactivating a membership ends its sessions, device keys, sockets and push subscriptions at once, and keeps its records.
- Each day's last audit hash lands in write-once storage, and changing an audit row breaks the chain check.

**Depends on:** nothing. Start now: order the NTAG 424 DNA badges and the USB NFC readers for the bar computer and the front desk.

**Size:** milestones.md plans 2–3 weeks. These 37 tickets are 18 S and 19 M: about 47 to 75 working days at S = ½–1 day and M = 2–3 days.

## Suggested order

Ticket numbers follow the dependencies, so working top to bottom is always safe. Tickets on one line can run side by side once the line before is done.

1. The ground: M1-01, then M1-02, M1-03 and M1-04.
2. The database and the plumbing: M1-05, then M1-06 and M1-08, then M1-07 and M1-09.
3. Rules, settings and modules: M1-10, M1-11, M1-12, M1-13, M1-14.
4. Devices and the seed: M1-15, M1-16, M1-17. From here every ticket can be checked in staging on the demo seed.
5. Sign-in: M1-18, M1-19, M1-20, then the staff app M1-21 and M1-22, then M1-23, M1-24, M1-25, M1-26 and M1-27.
6. The desktop app: M1-28, then M1-29 and M1-30. Order the badges and readers early, since M1-30 needs them in hand.
7. Admin: M1-31, then M1-32, M1-33 and M1-34.
8. The Console: M1-35, then M1-36.
9. The suites that block merges: M1-37. Its generator can start earlier and grow as routes land.

Definition of done: see CLAUDE.md.

## Tickets

### M1-01 · Scaffold the monorepo with lint, typecheck, tests, CI and the migration runner

- **Status:** done
- **Size:** M
- **Depends on:** none
- **Spec:** [Scope and architecture](../spec/01-scope-architecture.md) · the parts table; [Testing and operations](../spec/13-testing-operations.md) · Environments, Tests, Releases; [Security and data retention](../spec/12-security-retention.md) 12; [Money rules](../spec/05-money-rules.md) 2 (one pinned Temporal polyfill)
- **Build:**
  - pnpm workspaces: `apps/api` (Fastify on Node.js 22 LTS, the API and the job workers), `apps/staff` (React + Vite), `apps/desktop` (Electron), `apps/guest` (Next.js), `apps/console` (React + Vite), `packages/db`, `packages/rules` and `packages/shared`. TypeScript strict in every package, with project references.
  - ESLint and Prettier, Vitest for unit and integration tests, Playwright for end-to-end tests, and one pinned Temporal polyfill used by the server and every app.
  - `docker compose` with Postgres 16 and a local S3-compatible store, with object lock on for one bucket (M1-07 uses it).
  - The migration runner in `packages/db`: plain SQL files applied in order, each recorded once, run as the table owner. `pnpm db:migrate`, and `pnpm db:reset` for local use only.
  - GitHub Actions on every pull request: install, lint, typecheck, unit tests, integration tests against a Postgres 16 service, a Playwright smoke test per app, dependency scanning and container scanning. Each is a required check.
  - `.env.example` with Stripe test-mode keys and the Stripe CLI listener for local webhooks (Stripe calls start in M4), and Twilio test credentials.
- **Acceptance:**
  - [x] On a fresh clone, `pnpm install`, `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
  - [x] `docker compose up` starts Postgres 16 and the S3 store; `pnpm db:migrate` applies the first migration, and a second run applies nothing.
  - [ ] A pull request with a type error, a lint error or a failing test can't merge.
  - [x] Each of the five apps starts with `pnpm dev`, and its Playwright smoke test opens it.
- **Tests:** a migration-runner integration test (runs in order, runs once, a failing migration rolls back and stops the run); one smoke test per app.
- **Notes:** None of the canvas applies. Staging comes in M1-02. Built Sep 30, 2026:
  - **Versions.** Node 22.23.3, pnpm 12.8.1 (corepack), TypeScript 5.9.3 (not 7.x: typescript-eslint supports TypeScript below 6.1 only), Fastify 5.12, React 19.3, Vite 8.3, Next.js 16.3, Electron 44.4, Vitest 5.0, Playwright 1.63, ESLint 10, `temporal-polyfill` 1.0.5 pinned exactly and exported from `packages/shared` as the one Temporal.
  - **The S3 store is RustFS, not MinIO.** MinIO no longer publishes public images on Docker Hub or quay.io, so a fresh clone can't pull it. RustFS (Apache 2.0, S3 API with object lock, still labelled preview) runs locally and in CI only; staging uses a managed store (M1-02). Compose creates `west4-files` and `west4-audit` (object lock on) through an init container.
  - **Migration runner.** `schema_migrations` records each file's name and SHA-256; a file edited after it was applied stops the run. Each file runs in its own transaction under an advisory lock, as the role `DATABASE_URL` names (the table owner). `db:reset` refuses any `NODE_ENV` other than development or test, and any non-local host. The first migration, `0001_baseline.sql`, creates `pgcrypto` for the later hash chain (M1-07) and PIN hash (M1-23).
  - **The third Acceptance line is a GitHub setting, not code.** The workflow makes each job a separate named check (Lint, Typecheck, Unit tests, Integration tests, Smoke × 5, Dependency scan, Container scan). Marking them required, so a failing one blocks a merge, is branch protection on `main`, set once the repo has a GitHub remote. It stays unchecked until then.
  - **Dependency scanning** is `pnpm audit --audit-level=high` plus Dependabot (npm, actions, Docker). **Container scanning** is Trivy on the API image at CRITICAL and HIGH, ignoring unfixed. npm and corepack are removed from the runtime image so the scan covers only what runs.
  - **`GET /v1/health`** exists now as the API's smoke target and returns `ok` and `server_time`, as M1-02 describes.
  - **Strings.** Even the placeholder screens read from the shared English and Spanish catalog (`packages/shared/src/i18n`); the Spanish catalog's type makes a missing key a typecheck error, and a unit test checks both ways.
  - `pnpm seed` exists and exits with a message until M1-17 builds the loader.
  - Install scripts are allowed only for `esbuild` and `electron` (`allowBuilds` in `pnpm-workspace.yaml`).

### M1-02 · Stand up staging and deploy to it from CI

- **Status:** doing
- **Size:** S
- **Depends on:** M1-01
- **Spec:** [Scope and architecture](../spec/01-scope-architecture.md) · the Runs on column; [Testing and operations](../spec/13-testing-operations.md) · Environments; [Security and data retention](../spec/12-security-retention.md) 5 and 6
- **Build:**
  - A staging environment in one US East region: API and worker containers, managed Postgres 16, S3-compatible object storage with a write-once bucket (M1-07), a key service and a secrets manager. The PIN pepper (M1-23), the badge keys (M1-25) and the rule-pack signing key (M1-10) live in the key service.
  - Separate hostnames for the staff app, the Console and the guest web. The staff app is served outside the guest CDN.
  - GitHub Actions deploys `main` to staging once the checks pass, then runs the migrations.
  - A staging-only switch that allows the simulated clock (M1-06) and the demo PINs (M1-23). A production build refuses to start with it.
- **Acceptance:**
  - [ ] Merging to `main` deploys to staging, and `GET /v1/health` answers with `server_time`.
  - [ ] The staff app, the Console and the guest web each load from their own hostname.
  - [ ] Every secret comes from the secrets manager; none is in the repo or an image.
  - [ ] A production build started with the staging switch refuses to start.
- **Tests:** a post-deploy smoke test that calls the health route on staging.
- **Notes:** The spec names no cloud provider. The founder picks one that has managed Postgres 16, object lock, a key service and a secrets manager in one US East region. `GET /v1/health` isn't in the [API](../spec/08-api.md) table; it's an operations route that returns no venue data. Sep 30, 2026:
  - **AWS, `us-east-1` (D85).** Terraform in `infra/staging` (see `infra/README.md`): a VPC in two zones; ECS Fargate services `api`, `worker` and `guest` (0.25 vCPU, 512 MB each) behind one load balancer; RDS Postgres 16.15 on `db.t4g.micro`, single-AZ on staging (`db_multi_az` turns the standby on for production); S3 buckets for files, the audit export (Object Lock on from creation) and the two static apps; a KMS data key and an ECC signing key for rule packs; Secrets Manager for the PIN pepper, badge master key, Stripe, Twilio and the CloudFront origin secret; CloudWatch logs with 30-day retention.
  - **Hostnames.** No domain exists yet, so each app has its own `*.cloudfront.net` hostname with HTTPS: API and guest web in front of the load balancer, staff app and Console as static sites in S3 behind their own distributions. The staff app is therefore outside the guest CDN. CloudFront reaches the load balancer over HTTP inside AWS with a shared secret header and a header naming the app; a domain later adds ACM certificates and HTTPS to the origin.
  - **Secrets.** Terraform creates only the secret containers; `infra/scripts/seed-secrets.sh` fills them with random values (and Stripe and Twilio placeholders), so no secret is in the repo, an image or the Terraform state. RDS manages its own master password and ECS injects it as `DB_PASSWORD`; the API and the migration runner build the URL from `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`.
  - **Deploys.** `.github/workflows/deploy-staging.yml` runs after CI passes on `main` through a GitHub OIDC role (no AWS keys in GitHub): builds and pushes both images, registers task definitions, runs `db:migrate` as a one-off ECS task and checks its exit code, rolls the three services, publishes the static apps and runs `scripts/smoke-staging.mjs` (health with `server_time`, then the three hostnames). Infrastructure is applied by hand from a laptop, never from CI.
  - **The staging switch** is `WEST4_ENV` plus `ALLOW_STAGING_FEATURES=true`. `apps/api/src/config.ts` throws at start-up when the switch is on with `WEST4_ENV=production` (unit-tested); the task definitions derive the switch from the environment name, so a production environment can never set it.
  - **Cautious defaults:** the database backup window is 4–5 AM New York and maintenance is Wednesday 5–6 AM, both after the 4 AM alcohol stop and before the 6 AM cutover; RDS forces TLS; the tasks run in public subnets with public IPs instead of paying for a NAT gateway.

### M1-03 · Add the migration linter

- **Status:** done
- **Size:** S
- **Depends on:** M1-01
- **Spec:** [Testing and operations](../spec/13-testing-operations.md) · Releases; [Tenancy and access](../spec/02-tenancy-access.md) · The database walls; [Data model](../spec/04-data-model.md) · the intro and The money core
- **Build:** `pnpm db:lint`, run in CI on every migration file. It fails when:
  - a migration doesn't set `lock_timeout`, or builds an index on an existing table without `create index concurrently`;
  - a new column on an append-only table isn't nullable (the list lives in `packages/db`: `venue_settings`, `audit_log`, `venue_events`, the money core and the rest), or a migration updates or deletes money rows;
  - a table with a `venue_id` column lacks `enable` and `force row level security`, the `venue_isolation` policy or `unique (venue_id, id)`;
  - a foreign key to a venue-owned table leaves out `venue_id`;
  - `app_rw` is granted `update` on a money column, or `delete`, `truncate`, `references` or `trigger` on anything;
  - a backfill doesn't run as the audited migration role.
- **Acceptance:**
  - [x] A migration without `lock_timeout` fails `pnpm db:lint`, naming the file and the line.
  - [x] A venue table without `force row level security`, or without `unique (venue_id, id)`, fails.
  - [x] `references checks (id)` fails and `references checks (venue_id, id)` passes.
  - [x] `grant delete on check_lines to app_rw` fails.
  - [ ] CI runs the linter, and a failure blocks the merge. *(The "Migration lint" job runs on every PR; blocking the merge waits on branch protection, see M1-01's notes.)*
- **Tests:** a passing and a failing fixture migration for each rule.
- **Notes:** The money tables arrive in M2 and M4; the rules for them go in now so no later migration slips past. Built Sep 30, 2026:
  - `pnpm db:lint [files...]` lints `packages/db/migrations` in order and prints `file:line: rule: message`. It runs in CI as the "Migration lint" job, and the db package's unit tests run it on the real migrations too.
  - **How it reads SQL.** A statement splitter (comments, strings, dollar quotes, line numbers) and per-statement patterns, not a full SQL parser: the DDL the spec uses (`force row level security`, `create policy`, column grants) is outside what the pure-JS parsers cover, and the native Postgres parser needs a compiled binding. Anything the patterns don't recognise is ignored, so a rule can be fooled by unusual syntax; the fixtures pin the shapes the spec uses.
  - **Lists** live in `packages/db/src/lint/config.ts`: the money core (`checks`, `check_revisions`, `check_lines`, `payments`, `payment_attempts`, `payment_allocations`, `payment_events`, `refunds`, `venue_counters`, `drawer_moves`, `tip_pools`, `night_closes`), the append-only tables (those plus `venue_settings`, `audit_log`, `venue_events`, `webhook_events`, `rule_pack_versions`), the money columns (`*_cents`, `qty`, `amount`) and the tenancy roots (`organizations`, `venues`, `users`), which a foreign key may reference by `id` alone. Add to them as tables land.
  - **Cautious default: the audited migration role is `app_migrator`.** The spec says backfills run "as an audited migration role" without naming it. A backfill (an `update`, `delete` or `insert` on a table the file didn't create) must sit between `set role app_migrator` and `reset role`. M1-07's audit triggers should record that role.
  - The venue-wall rule checks the file that adds `venue_id` (by `create table` or `add column`) for `enable` and `force row level security`, the `venue_isolation` policy and `unique (venue_id, id)`, the last only when the table has an `id` column (`room_blocks` has none). Venue tables are carried from one migration to the next, so `references checks (id)` fails in any later file.
  - `create index` without `concurrently` is allowed only on a table the same file creates.

### M1-04 · Write the business-date and money helpers test-first

- **Status:** done
- **Size:** S
- **Depends on:** M1-01
- **Spec:** [Money rules](../spec/05-money-rules.md) 1 and 2; [the spec's conventions](../spec/README.md#conventions) · Money, Business date, Time zone
- **Build:**
  - Money helpers in `packages/shared`: integer cents with `currency: "usd"`, never floats; a percentage of a total rounded half up on exact values (`floor((2 × amount × num + den) / (2 × den))`); and a divider that hands leftover cents to the largest remainders, ties to the first parts.
  - Time helpers in `packages/rules` on the pinned Temporal: `businessDate(instant, timeZone, cutover)` returns the business date and the minutes from midnight at its start (12:30 AM is minute 1,470); `wallClock(businessDate, "HH:MM", timeZone, cutover)` returns the instant (a time before the cutover, such as "04:00", falls on the calendar day after the business date), using Temporal's "compatible" rule (a time in the repeated hour is its first occurrence, one in the skipped hour is the hour after). Durations come from elapsed time, never from subtracting clock times.
- **Acceptance:**
  - [x] Every case in the `business_date` group of [money-cases.json](../../seed/money-cases.json) passes: 12:30 AM Sat Sep 26 is business date Fri Sep 25 at minute 1,470; 5:59 AM Sat is still Fri; 6:00 AM Sat is Sat; both 1:30 AMs on Nov 1, 2026 belong to Sat Oct 31.
  - [x] `wallClock(2026-10-31, "04:00")` is Nov 1, 2026, 4:00 AM EST (−05:00), and `wallClock(2027-03-13, "04:00")` is Mar 14, 2027, 4:00 AM EDT (−04:00).
  - [x] Dividing 3266 cents in two gives 1633 + 1633, and 3267 gives 1634 + 1633.
  - [x] No money helper takes or returns a float.
- **Tests:** the `business_date` group (7 cases), written first; property tests for the divider (the parts add up, no two differ by more than a cent, and the first `amount mod n` parts are the larger ones).
- **Notes:** The `splits` group runs on this divider in M4, with the split screens. Money-cases ambiguity A7 (wall-clock minutes on the daylight-saving nights) is the reading used here. Built Sep 30, 2026:
  - **`packages/shared/src/money.ts`:** `cents(n)` (the only way to make a `Cents`; refuses anything but a safe integer), `usd(amount)`, `percentOf(amount, num, den)` (the ticket's integer formula, in BigInt; refuses a negative base, since comps and voids are exact negatives and never rounded), `divideEvenly(amount, parts)` and `divideByWeights(amount, weights)` (largest remainder, ties to the first parts; the even split is the weighted one with equal weights, and a property test says so).
  - **`packages/rules/src/time.ts`:** `businessDate(instant, timeZone, cutover)` and `wallClock(businessDate, "HH:MM", timeZone, cutover)` on the pinned Temporal, with `parseCutover`. A round-trip test walks every 7th minute of a normal night and both daylight-saving nights through `wallClock` then `businessDate`.
  - **Tests beyond the ticket's list.** The `splits` group's six `split_even` cases already pass on `divideEvenly`. The eleven `check_totals` cases pin `percentOf` (their `tax_cents` is 8.875% of `tax_base_cents`) and `divideByWeights` (their `tax_by_category_cents` is the rounded tax shared by each category's net base, the reading in money-cases meta `tax_by_category`). Property tests run on `fast-check`.
  - Nothing here reads a clock: both helpers take the instant or the date as an argument.

### M1-05 · Build the tenancy tables and row-level security

- **Status:** done
- **Size:** M
- **Depends on:** M1-03
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · The hierarchy, The database walls; [Data model](../spec/04-data-model.md) · Venue, people and platform; [Security and data retention](../spec/12-security-retention.md) 2; [Testing and operations](../spec/13-testing-operations.md) · Capacity
- **Build:**
  - `organizations` (legal_name, stripe_account_id, billing_customer_id), `venues` (org_id, name, slug, address, time_zone, day_cutover, rule_pack_id, stripe_location_id), `users` (name, email, phone_e164, mfa_required) and `memberships` (user_id, venue_id, role, status, pin_verifier, pin_digits, locale, tip_eligible, occupation_code, eligibility_set_by, eligibility_set_at, training, deactivated_at). Roles are `owner`, `manager`, `bartender`, `front_desk` and `staff`.
  - Database roles: `app_rw` without `BYPASSRLS`, a no-login role that owns the definer functions, and the audited migration role.
  - The `venue_isolation` policy, enabled and forced, on every venue table. The `org_read` policy for report tables only, valid in a read-only transaction marked `app.scope = 'org'`, through `owner_venues()` over active owner memberships. `users` shows a user to themselves and to members of the current venue; `organizations` shows the current venue's.
  - The API's request wrapper: one short transaction per request that sets `app.venue_id`, `app.user_id` and `app.request_id` with `set_config(…, true)`. A query without a venue errors. `app_rw` gets 5-second limits on statements and on idle transactions.
  - The pattern for requests that arrive without a venue: `SECURITY DEFINER` functions owned by the no-login role, with a pinned `search_path`, that take a secret and return only ids. `resolve_device` comes with devices (M1-15), `resolve_sms_number` in M2, `resolve_room_session` in M3, `resolve_stripe_account` in M4 and `resolve_booking_token` in M5.
  - Test helpers in `packages/db` for two venues, A and B.
- **Acceptance:**
  - [x] With `app.venue_id` unset, `select * from memberships` raises an error instead of returning rows.
  - [x] As venue A, selecting venue B's membership by its id returns nothing, and inserting a row with venue B's `venue_id` fails the policy.
  - [x] `app_rw` has no `BYPASSRLS`, and the M1-03 linter passes on every table.
  - [x] `org_read` returns rows only in a read-only transaction with `app.scope = 'org'`, only for venues where the user is an active owner.
  - [x] A user sees their own row and the members of the current venue, and no one else.
- **Tests:** integration tests in `packages/db`, one for each statement above.
- **Notes:** Auth tables the data model implies but doesn't name come in M1-19, M1-20 and M1-23. Built Sep 30, 2026:
  - **Migration `0002_tenancy.sql`:** `organizations`, `venues`, `users`, `memberships` with the spec's columns; the roles `app_rw` (no login in the migration, no BYPASSRLS, `noinherit`, 5-second `statement_timeout` and `idle_in_transaction_session_timeout`), `app_definer` (owns the definer functions) and `app_migrator` (the audited backfill role, M1-03); `app_venue_id()` raises when `app.venue_id` isn't set; `owner_venues()` and `current_org_id()` are `SECURITY DEFINER` with a pinned `search_path`, owned by `app_definer`, executable only by `app_rw`.
  - **Policies name their role.** Permissive policies are OR-ed per role, so a policy "for everyone" fires inside the definer functions too and raises. `venue_isolation` on `memberships` is `to app_rw`; `app_definer` gets its own read policy. On `venues`, `venue_self` steps aside in org scope so `org_read` decides alone; outside org scope a missing venue still errors.
  - **`org_read` lives on `venues` for now** (owner reports list the organization's venues). Report tables in later milestones copy the same policy; it must never go on `guests`, `messages` or `id_checks`.
  - **The request wrapper** is `withVenue(pool, {venueId, userId, requestId}, work)` and `withOrgScope(pool, {userId}, work)` in `packages/db` (`src/tenancy.ts`), and `apps/api/src/db.ts` exposes them as `app.db` on Fastify. Routes get the principal-aware version with M1-08 and M1-14.
  - **How the API connects.** `APP_DATABASE_URL` (app_rw) is separate from `DATABASE_URL` (the table owner, migrations). Locally `packages/db/local/init-roles.sql` creates the login on a fresh Compose volume (an existing one needs it run once by hand). On staging, `db:migrate` gives `app_rw` the password in `APP_DB_PASSWORD`, which comes from the new `west4/staging/app-db-password` secret; the API and worker tasks connect as `app_rw` and only the migration task holds the owner password.
  - **Tests** connect as the owner and `set role app_rw` (the migration grants the roles to the owner), so no `app_rw` password is needed in CI. `seedTwoVenues()` and `appPool()` in `packages/db/src/test-helpers.ts` are the venue A and B helpers every later venue-wall test uses.

### M1-06 · Build the jobs table, the workers, the scheduler and the simulated clock

- **Status:** done
- **Size:** M
- **Depends on:** M1-04, M1-05
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · The database walls (Jobs); [Scope and architecture](../spec/01-scope-architecture.md) · Jobs and scheduler; [Money rules](../spec/05-money-rules.md) 2 (the scheduler runs in UTC); [Demo seed · Now](../demo-seed.md#now)
- **Build:**
  - `jobs` (venue_id, kind, dedupe_key unique, priority, run_at, attempts, max_attempts, locked_until, last_error, status), claimed through a definer function with `SKIP LOCKED` and a lease (`locked_until`) in a short transaction.
  - Three worker pools: critical (payments and readers), normal (texts) and bulk (exports and retention). Each step runs like a request, in its own short transactions with the venue set, and a guard throws if a Stripe or Twilio call starts inside an open transaction.
  - Retries with exponential backoff and jitter from 5 seconds up to 10 minutes, until the kind's `max_attempts`; then the dead letters (`status = 'dead'`).
  - One scheduler, the leader under an advisory lock, running in UTC. It works out each run time per date from wall-clock times in the venue's zone (M1-04), so a 1:30 AM job neither runs twice nor gets skipped, and it fans scheduled work out as one job per venue.
  - One clock for the API, the workers and the scheduler, sent as `server_time`. In staging and tests it's a simulated clock that starts at Fri Sep 25, 2026, 10:41:00 PM and can be moved to 4:00, 4:12 and 4:30 AM; production can't move it (M1-02). Business times come from this clock, never from the database's `now()`.
- **Acceptance:**
  - [x] A failing job retries about 5 seconds later, backs off to at most 10 minutes with jitter, and goes to the dead letters with `last_error` after `max_attempts`.
  - [x] Two workers claiming 100 jobs never run one twice.
  - [x] A daily 1:30 AM job runs once on Nov 1, 2026, at the first 1:30; a daily 2:30 AM job runs once on Mar 14, 2027, at 3:30 AM EDT.
  - [x] Only one scheduler leads at a time, and killing it lets another take over within a minute.
  - [x] A job step that calls Stripe or Twilio inside an open transaction throws.
  - [ ] In staging, `server_time` reads 2026-09-25T22:41:00-04:00 after a fresh seed load. *(The clock and the route exist and are unit-tested to read exactly that; the seed load that sets it is M1-17, and staging's first deploy waits on the Terraform apply in M1-02.)*
- **Tests:** integration tests for claiming, leases, retries and dead letters; scheduler tests on the simulated clock across both daylight-saving nights.
- **Notes:** Audit rows keep the database's real `now()` (M1-07); only business times follow the simulated clock. The staging control that moves the clock is an operations route, not in the API table. Built Sep 30, 2026:
  - **Migration `0003_jobs.sql`:** the `jobs` table (spec 04's columns plus `pool`, `payload`, `created_at`, `finished_at`), a partial claim index, `venue_isolation` for `app_rw`, and `claim_jobs(pool, now, lease, limit)`: a `SECURITY DEFINER` function that takes due `queued` jobs and `running` jobs whose lease ran out, `for update skip locked`, and stamps the lease and the attempt. `venues_for_scheduler()` is the definer the scheduler uses to fan out. `clock_control` is the one-row table behind the shared simulated clock.
  - **Code** in `packages/db/src/jobs`: `enqueue` (inside a venue transaction; `on conflict (dedupe_key) do nothing`), `claim`, `complete`, `fail` (backoff or dead), `retryDelaySeconds` (5 s × 2^(attempt−1), capped at 600 s, ±25% jitter), `Worker` (one per pool; each handler step is its own `withVenue` transaction), `Scheduler` (session advisory lock for leadership; plans today's and tomorrow's business dates per venue with `wallClock`, keyed `kind:venue:date`) and `StoredClock`. `apps/api/src/worker.ts` runs the three pools and the scheduler; `apps/api/src/jobs/registry.ts` is where later tickets register handlers and schedules.
  - **The outside-call guard.** `withVenue` and `withOrgScope` mark their transaction in an `AsyncLocalStorage`; `assertOutsideTransaction("stripe")` throws inside one. The Stripe (M4) and Twilio (M2) clients must call it before every request.
  - **The clock.** `packages/shared/src/clock.ts`: `Clock`, `systemClock`, `SimulatedClock` (moves, then keeps ticking), `FrozenClock` (tests) and `SEED_NOW`. Processes in staging use `StoredClock`, which re-reads `clock_control` every 2 seconds, so a move through `POST /v1/ops/clock` reaches the API, the workers and the scheduler. The route only exists when `ALLOW_STAGING_FEATURES` is on; elsewhere it is a 404.
  - **`server_time` is shown in New York time** (`2026-09-25T22:41:00-04:00`), the platform's home zone, so the demo seed's reading matches what the ticket says; the instant underneath is zone-free.
  - **Kill-and-takeover.** The leader holds its lock on its own connection, so when its process dies the lock drops with the connection; the other scheduler retries every 15 seconds, well inside the minute.

### M1-07 · Build the audit triggers, the per-venue hash chain and the daily write-once export

- **Status:** done
- **Size:** M
- **Depends on:** M1-05, M1-06
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · The database walls (Audit rows); [Data model](../spec/04-data-model.md) · `audit_log`; [Security and data retention](../spec/12-security-retention.md) 4 and How long we keep things
- **Build:**
  - `audit_log` (venue_id, actor, approver, support_grant_id, action, target, changed_fields, old_values, new_values, request_id, at, prev_hash, hash), written only by `SECURITY DEFINER` triggers from the request's `app.*` settings and `now()`, never by the app. `app_rw` can't update, delete or truncate it.
  - Guest contact details, listed per table (the `guests` table joins the list in M2), are marked changed without their values.
  - A hash chain per venue: each row's hash covers the previous hash and the row, written in order per venue.
  - A daily job exports each venue's last hash of the business date to write-once storage (object lock in compliance mode). `verify_audit_chain(venue, from, to)` names the first broken row.
  - An event trigger raises an alert on any DDL or `TRUNCATE`. Heartbeats never reach the audit log.
- **Acceptance:**
  - [x] Changing Diego's role writes one audit row with the old and new role, the actor and the request id.
  - [x] A column on the redaction list shows as changed, with no old or new value.
  - [x] Editing an audit row's `new_values` as the database owner makes `verify_audit_chain` report that row.
  - [x] After the 6:00 AM cutover, the business date's last hash is in the write-once bucket, and overwriting or deleting it fails.
  - [x] `truncate` on any table raises the alert, and `app_rw` can't update or delete `audit_log`.
- **Tests:** trigger integration tests; a chain-break test; an export test against the local object-lock bucket.
- **Notes:** The `approver` and `support_grant_id` columns fill in from M2 (approvals) and M8 (support grants). Audit rows are kept 6 years; the retention job is M8. Built Sep 30, 2026:
  - **Migration `0004_audit.sql`:** `audit_log` (spec 04's columns; `app_rw` may only select its venue's rows, and only `app_definer` may insert), `audit_redactions`, `security_alerts`, the trigger `audit_row()` (SECURITY DEFINER, owned by `app_definer`; one advisory transaction lock per venue keeps the chain in order), `verify_audit_chain(venue, from, to)` (returns the first broken row id or null), `audit_head_before(venue, instant)` for the export, `truncate_alert()` on every table, and the event trigger `ddl_alert` on `ddl_command_end`, which also attaches the truncate alert to every new table. The migration runner sets `app.migrating` inside each migration's transaction so its own DDL raises no alert.
  - **The chain.** `hash = sha256(prev_hash || payload)`, where the payload is the venue, actor, action, target, changed fields, old and new values (jsonb, so canonical), request id and the row's `at` in UTC microseconds. `at` is the database's `clock_timestamp()`, never the simulated clock.
  - **Which venue's chain.** The row's `venue_id`, or the venue's own id on `venues`, or the request's `app.venue_id`, else the platform chain `00000000-0000-0000-0000-000000000000` (seeds, Console actions on `users` and `organizations`). Audited from the start: `organizations`, `venues`, `users`, `memberships`. `jobs` and `clock_control` are not (churn; heartbeats and the like never reach the log). New tables opt in with `select audit_table('name')` in their migration.
  - **Redactions, cautious default.** `users.email`, `users.phone_e164` and `memberships.pin_verifier` are on the list from day one, so staff contact details and the PIN hash never enter the log; the `guests` columns join it in M2. The spec only requires guest contact details to be withheld; widening it to staff contact details is reversible in one row.
  - **The export** is the job `audit.export_heads`, scheduled at 06:05 (just after the cutover) in the bulk pool, one per venue: it puts `audit-heads/<venue>/<business date>.json` (id, hash, at, exported_at) into the audit bucket with Object Lock in compliance mode for 6 years, and `If-None-Match: *`, so an existing key is never replaced; a second export of the same date fails loudly and goes to the dead letters. A plain S3 delete on a locked key only adds a delete marker; the locked version stays and can't be deleted, which the test checks against the local RustFS bucket. CI's integration job now runs RustFS too.
  - **Alerts** land in `security_alerts` and as a Postgres warning; wiring them to paging is M8. Creating event triggers needs a superuser locally and `rds_superuser` on RDS, which the migration owner has in both.

### M1-08 · Build the API conventions: the route registry, errors, idempotency and paging

- **Status:** done
- **Size:** M
- **Depends on:** M1-05
- **Spec:** [API](../spec/08-api.md) · Conventions; [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what; [Security and data retention](../spec/12-security-retention.md) 9; [Testing and operations](../spec/13-testing-operations.md) · Capacity
- **Build:**
  - The Fastify app, with venue routes under `/v1/venues/{venueId}/…` (the membership is checked, then the venue is set), public routes under `/v1/public/…` and webhooks under `/v1/hooks/…`.
  - A route registry: every route declares its principals (the list in Tenancy and access), its module (or core) and its role action. Any other caller gets `403 forbidden`, and CI fails on a route with no entry.
  - The error shape `{ "error": { "code", "message", "retryable" } }` and the codes screens branch on: `module_off`, `forbidden`, `version_conflict`, `in_progress`, `alcohol_closed`, `cut_off`, `ordering_closed`, `orders_open`, `room_not_free`, `over_amount_due`, `over_refundable`, `key_reused`, `approval_pending`, `payment_unknown`, `reader_busy` and `reader_offline`.
  - `Idempotency-Key` on every POST and PATCH, required on money routes. `idempotency_keys` (venue_id, principal_id, key, route, request_hash, state, response, created_at) is written before the work starts. A copy that arrives while the first runs gets `409 in_progress`, the same key with another body gets `422 key_reused`, and a finished request replays its answer for 7 days (a job clears older keys).
  - `server_time` and `min_client_version` on every response; `If-Match` against a `version` with `409 version_conflict`; lists with a cursor (`?after=`, at most 100 items) and `?status=` or `?state=` filters; rate limits per venue on staff routes; `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on token routes.
- **Acceptance:**
  - [x] The same POST sent twice with one key does its work once and returns the same answer both times.
  - [x] The same key with a different body answers `422 key_reused`; a second copy while the first is running answers `409 in_progress`.
  - [x] Every response carries `server_time` and `min_client_version`.
  - [x] A list of 250 items returns 100 and a cursor to the next page.
  - [x] A route with no principals declared fails CI.
- **Tests:** idempotency integration tests (in order, at once, a different body, a replay after a restart); a registry test that fails on an undeclared route.
- **Notes:** The registry is what the M1-37 suites read, so every later route is covered the day it lands. Built Sep 30, 2026:
  - **Where it lives:** `apps/api/src/http/`. `conventions.ts` is one Fastify plugin that wires everything; `app.ts` registers it first and every route after it, inside one routes plugin, so the registry's `onRoute` hook sees them all. A route declares itself with `{ config: route({ principals, module, action, idempotency, tokenRoute, rateLimit }) }`; `app.routes` lists them after start-up, and `app.ready()` throws `UndeclaredRouteError` naming any route without an entry, which fails every test and CI.
  - **Principals** (`principal.ts`) follow the table in Tenancy and access: `owner_manager` (a passkey session with an owner or manager membership at the venue; a PIN session never qualifies, so Admin routes stay closed to it), `staff`, `shared_device`, `room_tablet`, `guest_room`, `guest_booking`, `guest_link`, `singer`, `printer`, `up_next_display`, `support`, `webhook` and `public`. `request.principal` starts anonymous; each authenticator ticket (M1-15, M1-19, M1-24, M1-25, M2 to M5) adds one to `authenticators`. A venue route's membership check is `principalIs(principal, name, venueId)`; anything else is `403 forbidden`.
  - **`request.inVenue(work)`** is the request's one short transaction with `app.venue_id`, `app.user_id` and `app.request_id` set (M1-05's wrapper). Routes outside a venue use the platform id.
  - **Idempotency** (`idempotency.ts`, migration `0005_idempotency.sql`): the key row is inserted and committed in its own transaction before the handler runs, keyed by venue, caller and key with the route and a SHA-256 of the method, path and body; `409 in_progress` while `running`, `422 key_reused` on a different hash, a stored `{status, body}` replayed for 7 days with `Idempotent-Replayed: true`, and a 5xx marks the row `failed` so a retry runs again. `idempotency: "required"` on money routes makes a missing key a 400. The bulk job `idempotency.clear_old` (06:20 daily) calls `clear_idempotency_keys()`, a definer, since `app_rw` can't delete.
  - **Every response** carries `server_time` and `min_client_version` as JSON fields (on object bodies) and as `X-Server-Time` and `X-Min-Client-Version` headers, plus `X-Request-Id`. `MIN_CLIENT_VERSION` comes from the environment, `0.0.0` until the first client release.
  - **Errors** (`errors.ts`): `ApiError(code, message)` with the spec's code-to-status table; `retryable` is true for `in_progress`, `reader_busy`, `reader_offline`, `rate_limited` and `internal`. Unknown routes answer `404 not_found`, bad input `400 invalid_request`, in the same shape.
  - **Lists** (`paging.ts`): `parseListQuery` (limit capped at 100, `after`, `status`, `state`) and `page(rows, limit, cursorOf)`, which expects `limit + 1` rows and returns `next_cursor`. **Versions** (`version.ts`): `ifMatch(request)` and `assertVersion(current, expected)` for `409 version_conflict` with the current version in `details`.
  - **Rate limits**: `@fastify/rate-limit`, keyed by venue, on every route whose principals include staff, owner_manager or shared_device, 600 a minute by default (`rateLimit: false` opts out; the health route does). **Token routes** (`tokenRoute: true`) send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
  - **Not here yet:** `404 module_off` (M1-13) and the `role_permissions` check on `action` (M1-14) plug into the same registry entry.

### M1-09 · Build the event relay and the live WebSockets

- **Status:** done
- **Size:** M
- **Depends on:** M1-06, M1-08
- **Spec:** [API](../spec/08-api.md) · Live events; [Scope and architecture](../spec/01-scope-architecture.md) · Live updates
- **Build:**
  - `venue_events` (venue_id, seq, type, entity_id, entity_version, at), written in the same transaction as each change through one helper.
  - One relay, the leader under an advisory lock, stamps `seq` in commit order: only on rows whose transaction committed before every one still running.
  - Every API container tails `venue_events` by `seq` on its own connection, woken by NOTIFY and polling each second as a backstop, and pushes to its own WebSockets.
  - Each screen opens one WebSocket, filtered to what its principal may see: a room tablet gets only its room's channel, and a locked shared device only room numbers and ring state. The hello carries `server_time`.
  - A screen that reconnects sends the last `seq` it saw and gets everything after it. Events are kept 72 hours (a job deletes older ones); a gap means a full refetch, and `entity_version` lets a screen ignore a stale read. The client library in `packages/shared` groups refetches for 250 ms and backs off reconnects with jitter. Deploys drain sockets slowly.
  - An event carries only `seq`, `type`, `id`, `entity_version` and `at`, never money math.
- **Acceptance:**
  - [x] An event written in a transaction reaches a socket on either of two API containers within a second on a local machine.
  - [x] A screen that reconnects with its last `seq` gets exactly what it missed; one that asks for a `seq` older than 72 hours is told to refetch.
  - [x] Killing the relay leader loses no event, and `seq` keeps going up.
  - [x] A socket on Room 9's channel never receives an event for another room.
  - [x] An event with any field beyond the five fails a test.
- **Tests:** integration tests with two API processes; a relay failover test; a filter test for each kind of principal.
- **Notes:** The 3-second order-to-alarm target is checked under load in M8. Built Sep 30, 2026:
  - **Migration `0006_events.sql`:** `venue_events` with the five wire fields plus routing columns (`room_id`, `audience` of venue, room, staff, managers, user or display, `user_id`) and stamping columns (`xid`, `seq`, `stamp`). `stamp_venue_events()` stamps, in `(xid, id)` order, only rows whose transaction id is below the current snapshot's `xmin`, that is rows whose transaction committed before every transaction still running: `seq` counts per venue in `venue_event_counters`, `stamp` is one global tail position. A trigger `NOTIFY`s `west4_events` on insert; stamping `NOTIFY`s `west4_stamped`. `tail_venue_events`, `venue_events_after`, `venue_events_bounds` and `clear_venue_events` are definers, since the tail crosses venues.
  - **Code:** `packages/db/src/events.ts` has `emitEvent(client, …)` (call it inside the change's transaction), `toWire`, `Relay` (leader under a session advisory lock; wakes on NOTIFY, polls each second) and `Tail` (each API container's follower, from the current end of the stamp sequence). `apps/api/src/http/events.ts` serves `GET /v1/venues/{v}/events` over `@fastify/websocket` and holds each container's sockets; `event-filter.ts` is `visibleTo(subscription, event)`, one rule per principal kind.
  - **Frames.** `hello { server_time, seq }` on open; events as exactly `{ seq, type, id, entity_version, at }` (a test checks the key set); `caught_up { seq }` after a replay; `refetch` when the asked-for seq is older than what's kept; `reconnect` when the container drains. A seq is per venue, so a filtered socket (a room tablet) naturally skips numbers; the client remembers the highest seq it was told (events and `caught_up`) and the server replays from there, so the gap rule is the server's `refetch`, not a count on the client.
  - **Refused callers** on the socket route get the upgrade and then close code 4403 (`websocket: true` in the registry entry); an HTTP 403 on an upgrade request leaves a raw socket Node's server waits on at shutdown, which is why. `forceCloseConnections` is on, and the plugin's `preClose` terminates whatever the slow drain (reconnect frames spread over 5 seconds) didn't close.
  - **The client library** is `EventClient` in `packages/shared/src/events-client.ts`: runtime-agnostic (the browser's WebSocket or `ws` is passed in), refetches grouped for 250 ms, reconnects backed off from 500 ms to 30 s with ±25% jitter, `?after=` on reconnect.
  - **Retention:** the bulk job `events.clear_old` at 06:40 daily calls `clear_venue_events(now − 72 h)`.
  - **Tests:** two API instances on one database (each with its own relay and tail), delivery under a second on both, replay of exactly the missed seqs, relay crash and takeover with no lost event, Room 9's channel, the too-old `refetch`, the 4403 close; unit tests for the filter per principal, the five-field wire shape, and the client's grouping and backoff.

### M1-10 · Load the New York County rule pack and resolve its versions

- **Status:** done
- **Size:** S
- **Depends on:** M1-04, M1-05
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Rule packs; [Data model](../spec/04-data-model.md) · `rule_packs`; [Security and data retention](../spec/12-security-retention.md) 11
- **Build:**
  - `rule_packs` (id, version, effective_on, data, approved_by (two people), signature). Venues can read it and never write it.
  - The `us-ny-new-york-county` pack, version `2026.09`, exactly as spec 03 gives it (alcohol, promotions, salesTax, wages, cardFee, gratuity, cash, idScan, texting, retention), typed as `RulePack` in `packages/shared`.
  - A signature check (Ed25519 over the canonical JSON, key in the key service) before a version is used.
  - `rulePackFor(venue, businessDate)`: the newest signed version with two approvers whose `effective_on` is on or before the business date, so a new version starts at a business-date boundary. Every read returns the version string, which check revisions store from M4.
  - The data behind Admin's notice: what changes between the version in force and a later one, and the date it starts. The Console's publishing and Admin's notice are built in M1-36.
- **Acceptance:**
  - [x] West 4 reads `us-ny-new-york-county` `2026.09` on business date Fri Sep 25, 2026.
  - [x] A version with a bad signature, or with fewer than two approvers, is never used.
  - [x] A version effective Sat Sep 26 isn't used at 4:00 AM on Sat Sep 26 (business date Sep 25), and is used from 6:00 AM.
  - [x] `app_rw` can't insert or update `rule_packs`.
- **Tests:** unit tests for version resolution across the cutover; a signature test.
- **Notes:** `2026.09` is loaded by a bootstrap script that signs it with the staging key and records two named approvers from our side; later versions go through the Console (M1-36). `salesTax.jurisdictionCode` and `surchargeTaxable` wait for the accountant ([Open technical questions](../spec/14-open-questions.md)). Built Sep 30, 2026:
  - **Types and data** in `packages/shared/src/rule-pack.ts`: `RulePack`, `newYorkCounty` (2026.09, the spec's values; `salesTax.jurisdictionCode` is `null` until the accountant answers and `surchargeTaxable` keeps the spec's `true`), `canonicalJson` (keys sorted at every level, so the same pack always signs to the same bytes) and `rulePackChanges(current, next)`, the data behind Admin's notice.
  - **Migration `0007_rule_packs.sql`:** `rule_packs (id, version, effective_on, data, approved_by text[], signature, key_id, published_at)` and `rule_pack_signing_keys (key_id, public_key, retired_at)`. `app_rw` may only select both (tested).
  - **Signing** (`packages/db/src/rule-packs.ts`): Ed25519 over the canonical JSON, base64. The private key is `RULE_PACK_SIGNING_KEY` (PEM), held on staging in Secrets Manager under the data KMS key; the public keys live in the table, so a key can be rotated or retired and old versions re-checked. AWS KMS has no Ed25519, which is why the key is a KMS-encrypted secret rather than a KMS key; the unused asymmetric KMS key left Terraform (never applied).
  - **`rulePackFor(client, packId, businessDate)`** returns the newest version with a valid signature against an active key, at least two distinct approvers and `effective_on` on or before the business date, with its version string. `rulePackVersions()` lists every usable version for the notice. Both run as `app_rw`.
  - **Bootstrap.** `db:migrate` now also calls `loadBuiltInRulePacks()`: `publishRulePack()` with `RULE_PACK_APPROVERS` (cautious default "Abhishek Gaire,Claude Code"; change it in the environment) and `RULE_PACK_EFFECTIVE_ON` (default 2026-09-01). Locally, with no key set, a throwaway key signs the load; on staging the task carries the secret. Idempotent.

### M1-11 · Build versioned venue settings with the rule-pack checks on every save

- **Status:** done
- **Size:** M
- **Depends on:** M1-08, M1-09, M1-10
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Settings, When a change starts, One place for each fact, the key table and every type; [API](../spec/08-api.md) · Settings and modules
- **Build:**
  - `venue_settings` (venue_id, key, version, value jsonb, saved_by, saved_at), append-only.
  - The typed keys in `packages/shared`, each with a schema: `hours`, `prices`, `deposit`, `pay`, `drawer`, `tabs`, `pos`, `ordering`, `rooms`, `barMode`, `alerts`, `phone`, `website`, `messages`, `safety` and `languages`, with the types exactly as spec 03 writes them.
  - `GET /settings/{key}` (the value, its version and the business date it starts) and `PUT /settings/{key}` (a new version after the schema and rule-pack checks). "Save and publish" writes the changed keys in one transaction and sends one `settings.changed`.
  - Rule-pack checks, refused with the reason: the house last call (`hours.lastCall`) is never later than the pack's `alcohol.lastSale`; a card surcharge is credit only, at most the in-person card cost (2.7%) and the networks' 3%, and starts only 30 days after `noticeSentOn`; a cash discount only where the pack allows one; the gratuity label stays "Gratuity"; `languages.staff` holds only English and Spanish; `safety.occupancyLimit` is empty or a whole number and is never defaulted.
  - Start dates: a change to `drawer`, to the tip-pool method (`pay.pool`) or to `pos.layouts` starts at the next business date ("Starts Sat Sep 26"); every other key is live at once. A read for a business date returns the version in force then.
- **Acceptance:**
  - [x] `PUT /settings/hours` with `lastCall: "04:30"` is refused with a reason that names the house last call and the pack's 4:00 AM, and nothing is saved.
  - [x] `lastCall: "03:00"` saves the next version and sends `settings.changed`; the old version stays readable.
  - [x] A 3.5% card surcharge is refused (over 2.7%), and a 2.7% one with `noticeSentOn` today is refused until 30 days later.
  - [x] A `drawer` change saved at 10:41 PM on Fri Sep 25 reads "Starts Sat Sep 26", and business date Sep 25 still gets the old version.
  - [x] Saving two keys together writes both or neither.
- **Tests:** a unit test for each check; integration tests for versions, start dates and the one-transaction save.
- **Notes:** Special and closed dates are `closures` rows (M1-12), texts live in `message_templates` (M2) and modules in `venue_modules` (M1-13), never in settings. The API table lists only `PUT /settings/{key}`; Save and publish needs one transaction, so this adds `PUT /settings` taking several keys (not in the table, flagged). Built Sep 30, 2026:
  - **Schemas and types** in `packages/shared/src/settings.ts`: the sixteen keys as zod schemas with spec 03's shapes, `strict()` so an unknown field is refused (which is also how a stray gratuity `label` is kept out), and the TypeScript types derived from them. `parseSetting(key, value)` returns the value or the reasons, each naming the key and path. `startsNextBusinessDate(key, previous, next)` is true for a drawer change, a tip-pool method change and a bar POS layout change.
  - **Rule-pack checks** in `packages/rules/src/settings-checks.ts`, one per rule, each returning the reasons in the words Admin shows: the house last call against the pack's last sale (compared as minutes on the business date, so 11 PM is earlier than 4 AM); a surcharge at most the in-person card cost (`IN_PERSON_CARD_COST_PCT = 2.7`, Stripe's in-person rate) and the networks' 3%, and only from `noticeSentOn` + 30 days; a cash discount only where the pack allows one; staff languages English and Spanish only, each once; the occupancy limit empty or a positive whole number, never defaulted.
  - **Migration `0008_venue_settings.sql`:** spec 04's columns plus `starts_on` (the business date a version takes effect), primary key `(venue_id, key, version)`, `app_rw` select and insert only, audited. `audit_table()` is redefined to add only the triggers a table is missing, since 0004's DDL event trigger already attaches the truncate alert to every new table.
  - **`saveSettings()`** (`packages/db/src/settings.ts`) validates every key, runs the checks, then writes each new version and one `settings.changed` event (entity id: the keys saved, joined) inside the request's transaction, so a refusal anywhere saves nothing. `starts_on` is decided against the version in force today, so a `pay` save that changes the pool method waits as a whole until tomorrow, including any other field in it; `readSetting(venue, key, businessDate)` returns the newest version that has started by that date, and `settingHistory()` the change log.
  - **Routes** (`apps/api/src/routes/settings.ts`, `owner_manager`, actions `settings.read` and `settings.write`): `GET /settings/{key}` with `?business_date=` and `?history=1`, `PUT /settings/{key}` with `{ value }`, and `PUT /settings` with `{ values }`. A refusal is `400 invalid_request` with the reasons joined in `message` and listed in `details.reasons`. A key that was never set answers `404 not_found` rather than a default, since venue facts are never invented.
  - **Not here:** the venue's `rule_pack_id` falls back to `us-ny-new-york-county` until setup writes it (M1-17 seeds it).

### M1-12 · Build closures and each business date's opening hours

- **Status:** done
- **Size:** S
- **Depends on:** M1-11
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `hours`, One place for each fact; [Data model](../spec/04-data-model.md) · `closures`; [API](../spec/08-api.md) · Bookings (`POST /closures`); [Money rules](../spec/05-money-rules.md) 2
- **Build:**
  - `closures` (venue_id, date, kind, opens, closes, note): special dates and closed dates in one list. `GET` and `POST /closures`.
  - `hoursFor(venue, businessDate)`: the opening, the close and the house last call as instants, from `hours.weekly` and any closure, resolved on the wall clock (a close of "04:00" belongs to the business date it ends). Screens and jobs read "open now" from it and the venue's clock, never the device's.
- **Acceptance:**
  - [x] Fri Sep 25, 2026 opens at 4:00 PM and closes Sat at 4:00 AM EDT; Sat Oct 31 closes at 4:00 AM EST on Nov 1.
  - [x] A closure for Thu Dec 24 closing at 11:00 PM moves that night's close to 11:00 PM, and its last call to no later than 11:00 PM.
  - [x] "Open now" is true at 10:41 PM on the seed and false at 4:30 AM.
- **Tests:** unit tests on a normal night and both daylight-saving nights; an API test for closures.
- **Notes:** Pushing the hours to Google Business Profile is M5. Listing the bookings a closed date affects is M2 (M2-33). A `closures` row has no last call of its own; cautious reading built here: the house last call is never later than that night's close (flagged). Built Sep 30, 2026:
  - **Migration `0009_closures.sql`:** `closures (id, venue_id, date, kind closed|special, opens, closes, note, created_by, created_at)`, one row per venue and business date, a special date needing an opening or a close; `app_rw` may select, insert and update (nothing deletes a closure; a mistaken one is edited, and Admin's editing screen is M1-33). Audited.
  - **`hoursFor(venue, businessDate, hours, closure)`** in `packages/rules/src/hours.ts` returns the opening, the close and the house last call as instants, from `hours.weekly` for the business date's weekday (Sunday 0 to Saturday 6, like JavaScript's `Date.getDay()`, since spec 03 leaves the numbering open) overridden by a special closure, resolved with `wallClock` so "04:00" lands on the next calendar day and the two daylight-saving nights come out 15 and 13 hours long. `openNow(hours, at)` is opening ≤ at < close.
  - **Routes** (`apps/api/src/routes/closures.ts`): `GET /closures` (date order, `?from=`, `?to=`, cursor by date) and `POST /closures` for owners and managers; `GET /hours?business_date=` for every staff principal and shared devices, answering the instants in the venue's zone and `open_now` from the app clock. `GET /hours` isn't in the API table (flagged). A new closure sends `settings.changed` with entity `closures`, since the calendar, the board and the site cache read hours like a setting; the spec's event table names no closure event.

### M1-13 · Build modules, their dependencies, `404 module_off` and venue flags

- **Status:** done
- **Size:** M
- **Depends on:** M1-08, M1-09
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Modules, What each module hides; [API](../spec/08-api.md) · Settings and modules; [Testing and operations](../spec/13-testing-operations.md) · Tests (module tests)
- **Build:**
  - `venue_modules` (venue_id, module_id, allowed, state), with state on, stopping or off. The switchable modules: Website, Online booking & deposits, Walk-in waitlist, Rooms & room clock, Ordering from the room, Bar screen & tickets, Bar tabs & quick sale, Bar mode, Packages & specials, Song system control, Guest texts, Marketing texts, Team, time clock & tips, Safety & ID records, and Reports & accounting. Kitchen & food, Event sales, Guests, loyalty & gift cards, and Multiple locations exist as rows, but no phase 1 screen shows them. The four core modules (Payments & checks, Alcohol controls & rule pack, Admin & settings, Devices & printers) are always on.
  - Dependencies: Online booking & deposits, Packages & specials, Song system control and Event sales need Rooms & room clock; Ordering from the room needs Rooms & room clock and Bar screen & tickets; Bar mode needs Bar tabs & quick sale; Marketing texts needs Guest texts. A module can be on only while what it needs is on.
  - `GET /modules` and `PATCH /modules/{id}`. Turning off a module others need answers with "These turn off with it: …" and waits for a confirm; turning off Bar screen & tickets while Ordering from the room is on asks "Room orders would have nowhere to ring. Turn off Ordering from the room too?". Off is refused while the module has open sessions or tabs; each module registers that check when its tables land.
  - Stopping takes no new bookings, tabs or waitlist entries, and still lets existing ones be viewed, closed, cancelled and refunded.
  - Every route of a module that's off answers `404 module_off`, from the route registry, except guest routes for existing bookings (manage, cancel, refund status) and guest links for existing waitlist spots, receipts and payments.
  - What each module hides, as one table of data in `packages/shared` that every screen, the website and the text sender read.
  - `venue_flags` (venue_id, flag, on, set_by), read by the API and the screens, with our own test venue first in line.
- **Acceptance:**
  - [x] Turning off Bar screen & tickets at West 4 asks "Room orders would have nowhere to ring. Turn off Ordering from the room too?"; yes turns both off, and no changes nothing.
  - [x] Turning off Rooms & room clock lists "These turn off with it: Online booking & deposits, Ordering from the room, Packages & specials" (the ones on at West 4).
  - [x] Ordering from the room can't be turned on while Bar screen & tickets is off, and a core module can't be turned off.
  - [x] With any module off, every route registered to it answers `404 module_off`.
  - [x] A module whose `allowed` is false can't be turned on from Admin.
- **Tests:** spec 13's module tests: dependencies and their confirms; `404 module_off` on every route of each module (one fixture route per module now, and the real routes as later milestones add them); the effects table matched against what each screen hides.
- **Notes:** Build the dependency of Ordering from the room on Bar screen & tickets that the canvas lacks ([AdminDesk](../screens.md#admindesk) note 11, [Console](../screens.md#console) note 4). The spec doesn't say which answer a creation route gives while its module is stopping; this uses `404 module_off` for new bookings, tabs and waitlist entries only. Built Sep 30, 2026:
  - **The table** is `packages/shared/src/modules.ts`: the 23 modules (15 phase 1 switchable, 4 core, 4 phase 2 rows), each with `needs` from spec 03's table and `hides` as four lists of ids (staff app screens, staff phone tabs, website and room-page sections, texts) that screens, the website and the text sender check. Names, states and the confirm and refusal sentences are catalog strings in English and Spanish (`module.<id>.name`, `modules.confirm.*`, `modules.refused.*`). `turnsOffWith(states, id)` walks dependents transitively; `missingNeeds`, `needsRoomOrdersConfirm`.
  - **Migration `0010_venue_modules.sql`:** `venue_modules (venue_id, module_id, allowed, state, updated_by, updated_at)` and `venue_flags (venue_id, flag, on, set_by, set_at)`, both audited. A module with no row is not allowed and off; core modules are always on whatever the rows say. The Console writes `allowed` (M1-35); Admin moves `state`.
  - **Routes** (`apps/api/src/routes/modules.ts`): `GET /modules` (every module with allowed, state, needs, hides and what would turn off with it), `PATCH /modules/{id}` with `{ state, confirm? }`, `GET /flags`. Turning a module off or to stopping when others need it answers `{ applied: false, needs_confirm: true, turns_off, question }` and changes nothing; the same call with `confirm: true` applies to all of them. The question is the spec's sentence for Bar screen & tickets while Ordering from the room is on, else "These turn off with it: …". Turning on needs `allowed` (`403`) and every dependency on (`400` naming what's missing). A core module answers `400`. `openWorkChecks` is where each module registers its "open sessions or tabs" refusal (`409 orders_open`) as its tables land; empty now. A change sends `settings.changed` with entity `modules`.
  - **`404 module_off`** is enforced in the conventions plugin from each route's `module`, through `ModuleGate` (`apps/api/src/http/module-gate.ts`), a per-container cache of each venue's states (3 seconds, cleared on this container's own changes). `off` blocks every route of the module; `stopping` blocks only routes marked `createsNewWork`; routes marked `exemptWhenOff` (guest routes for existing bookings, waitlist spots, receipts, payments) always work. A WebSocket route closes with 4403 instead.
  - The tests use one fixture route per switchable module; real routes are covered the day they declare their module.

### M1-14 · Load the five default roles into `role_permissions` and check them before every write

- **Status:** done
- **Size:** S
- **Depends on:** M1-08
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Roles (the permission table); [Data model](../spec/04-data-model.md) · `role_permissions`; [API](../spec/08-api.md) · Conventions (Principals); [Glossary · Roles](../glossary.md#roles)
- **Build:**
  - `role_permissions` (venue_id, role, action, allowed, needs_approval), filled with the defaults for Owner, Manager, Bartender, Front desk and Staff (a runner), one action per row of the spec's table. Check-in, the waitlist, bookings and guest texts are separate actions, so a runner gets check-in and the waitlist only.
  - The front desk's bar POS and its accepting room orders "when covering the bar" are rows that Admin → Team can switch off (M1-31).
  - A guard that checks the caller's role against `role_permissions` before every write, from the action each route declares (M1-08). Screens hide what a role can't do, but the API is the check.
- **Acceptance:**
  - [x] Each action in the spec's table, tried as each of the five roles, is allowed or refused exactly as the table says.
  - [x] A runner (`staff`) cutting off a room gets `403 forbidden`.
  - [x] With the front desk's bar POS switched off, Diego's bar POS and accept-order calls answer `403`.
  - [x] Bartenders, the front desk and runners get `403` on every Admin action.
- **Tests:** the role half of spec 13's role and approval tests, table-driven over fixture routes.
- **Notes:** The duty (Bar, Front desk, Runner, Manager) is picked at clock-in in M7 and never changes permissions. "When covering the bar" needs the duty; until M7, the Admin switch alone decides. Built Sep 30, 2026:
  - **The table** is `packages/shared/src/roles.ts`: the five roles, twenty actions (one per row of the spec's table, with check-in, the waitlist, bookings and guest texts as separate actions, and Admin split into `admin.access`, `admin.payments`, `admin.team` and `admin.console` so managers get Admin without Payments, Team and Console), `defaultPermissions[action][role]` exactly as the table, and `switchableByAdmin` (the front desk's `pos.use` and `orders.accept`). Names are catalog strings in English and Spanish (`role.<id>`, `permission.<action>`).
  - **Migration `0011_role_permissions.sql`:** the venue's changes only, keyed `(venue_id, role, action)`, audited; no row means the default. `permissionFor(overrides, role, action)` is the one answer everything reads.
  - **The guard** lives in the conventions plugin (`PermissionGate`, `apps/api/src/http/permission-gate.ts`, cached like the module gate): before every write (anything but GET, HEAD and OPTIONS) by a signed-in person, the action the route declares is checked for the caller's role at the venue; a miss is `403 forbidden`. Reads pass on the principal check alone. Devices, guests, singers and webhooks have no role and aren't role-checked; their principal rules decide. A route that declares an action outside the table throws at request time, so a typo can't silently allow.
  - **Routes** (`apps/api/src/routes/permissions.ts`): `GET /permissions` (the effective table with defaults and what Admin may switch) and `PATCH /permissions/{role}/{action}` for the two switchable rows, owner only (`admin.team`). Admin → Team's screen (M1-31) uses them. The settings, closures and modules routes now declare `admin.access`.
  - **Tests:** the table tried as every role over one fixture write per action (100 calls), the runner cut-off, the front desk switch, and the Admin actions as the three non-Admin roles even with a passkey session.

### M1-15 · Pair devices with one-time codes and signed device keys, and revoke them

- **Status:** done
- **Size:** M
- **Depends on:** M1-08, M1-09
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what (Shared device, Room tablet); [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Pairing; [Data model](../spec/04-data-model.md) · `devices`; [API](../spec/08-api.md) · Sign-in, team and devices
- **Build:**
  - `devices` (venue_id, kind, name, public_key, room_id, user_id, cash_drawer_id, network, clock_skew_ms, app_version, consecutive_failures, training, last_seen_at, disabled_at, revoked_at), with kinds `bar_computer`, `front_desk`, `room_tablet`, `reader`, `printer`, `nfc_reader`, `router`, `staff_phone`, `up_next_display` and `mic_outlet`.
  - `POST /devices/pair` (a manager, from Admin → Printers & devices) makes a one-time code. `POST /v1/devices/claim` takes the code and the public key of a non-extractable WebCrypto key the device made, and returns the device id.
  - Every device request is signed (method, path, body hash, timestamp and a nonce) and checked. `resolve_device` finds the venue from the signature (definer, pinned `search_path`, ids only).
  - A shared device with nobody signed in may call only badge and PIN unlock and heartbeats, and gets a channel that carries only room numbers and ring state, so room orders still show and chime while it's locked.
  - `PATCH /devices/{d}` (the name, and a tablet's room); `POST /devices/{d}/revoke` ends the device's sessions and closes its sockets at once.
- **Acceptance:**
  - [x] A code made in Admin pairs the bar computer once; the same code fails a second time, and an expired code fails.
  - [x] A request with a bad or missing signature, or a replayed one, answers `403`.
  - [x] Revoking the bar computer closes its WebSocket within a second, and its next request answers `403`.
  - [x] A locked shared device's channel carries room numbers and ring state and nothing else.
- **Tests:** integration tests for pairing, signing, replay and revoking; a filter test for the locked channel.
- **Notes:** The spec doesn't fix the code's length or life; this uses 8 characters and 10 minutes (flagged for the founder). The drawer and training fields of `PATCH /devices/{d}` come in M4 and M7. Built Sep 30, 2026:
  - **Migration `0012_devices.sql`:** `devices` with spec 04's columns and the ten kinds (`room_id` gets its key when `rooms` lands in M2), `device_pairing_codes` (the code stored as a SHA-256, shown once) and `device_nonces`. Two definers with a pinned `search_path`: `claim_device(code_hash, public_key)` trades an unclaimed, unexpired code for a new device row and returns the device and venue ids; `resolve_device(id, nonce, window)` returns the device's venue, kind, key and standing, records the nonce and says whether it was fresh, so a replay inside the window is refused. Codes use an alphabet without look-alike characters.
  - **The signature** (`packages/shared/src/device-signing.ts`, shared with the desktop and staff apps): ECDSA P-256 with SHA-256 from a non-extractable WebCrypto key, over `method\npath\nsha256(body)\ntimestamp\nnonce`, sent as `X-Device-Id`, `X-Device-Timestamp`, `X-Device-Nonce` and `X-Device-Signature`. The window is ±5 minutes, on the real clock (security, never the simulated clock). ECDSA rather than Ed25519 because every browser's WebCrypto has it.
  - **The authenticator** (`apps/api/src/http/device-auth.ts`) runs on every request with a device id: an incomplete, stale, unknown, revoked, replayed or wrong signature is `403 forbidden`, never silently anonymous. Bar computers, front desks, room tablets, printers and Up next displays become device principals; a staff phone's request is signed too but the person's own session is the principal (M1-24).
  - **Routes** (`apps/api/src/routes/devices.ts`): `POST /devices/pair` (Admin), `POST /v1/devices/claim` (public, rate-limited), `GET /devices`, `PATCH /devices/{d}` (name and a tablet's room) and `POST /devices/{d}/revoke`, which stamps `revoked_at`, sends `device.offline` for Admin → Printers & devices, and closes the device's sockets with code 4401 at once; its next request is refused.
  - **A locked shared device** connects to the events socket with `?locked=1` and gets only ring state (M1-09's filter); which routes it may call with nobody signed in is the registry's `shared_device` principal, so the unlock routes (M1-24, M1-25) and heartbeats (M1-16) list it and nothing else does.

### M1-16 · Record heartbeats and clock offsets, and alert when a device goes quiet

- **Status:** done
- **Size:** S
- **Depends on:** M1-06, M1-12, M1-15
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Clocks, Heartbeats; [API](../spec/08-api.md) · Live events (`device.offline`, `device.online`)
- **Build:**
  - A heartbeat from every device every 30 seconds (`POST /v1/devices/heartbeat`, signed), with its app version, network and clock reading, never written to the audit log. USB printers and NFC readers report through their host computer.
  - `clock_skew_ms` from the reading against `server_time`; a device more than 30 seconds off raises an alert.
  - Two minutes of silence during opening hours (M1-12) raises `device.offline`, and the next heartbeat raises `device.online`. Alerts go to the venue's managers, grouped into one "venue offline" alert when every device drops at once.
- **Acceptance:**
  - [x] A tablet that stops at 10:41 PM raises `device.offline` at 10:43 PM on the simulated clock; one that stops at 4:30 AM, after the close, raises nothing.
  - [x] A device 45 seconds off raises the clock alert, and one 20 seconds off doesn't.
  - [x] When all 28 seeded devices go quiet together, managers get one "venue offline" alert, not 28.
  - [x] No heartbeat is in `audit_log`.
- **Tests:** integration tests on the simulated clock.
- **Notes:** The heartbeat route isn't in the API table; the spec only says devices check in every 30 seconds. Paging us when a money path is at risk is M8. Until M2 names the manager on duty (M2-15), these alerts go to every manager's phone.
  - **Built (Sep 30).** Migration `0013_heartbeats.sql`: `device_heartbeats` (one row per device: last seen, app version, network, clock skew, offline-since, clock-alerted-at) and `venue_outages` (one row per venue, `offline_since` set while the whole venue is down). Neither is audited; 0004 already said heartbeats never reach `audit_log`. The four heartbeat columns left `devices` (an audited table), and `resolve_device` no longer stamps `last_seen_at` on every signed request, which had been writing an audit row per request. `POST /v1/devices/heartbeat` in `apps/api/src/routes/devices.ts`: signed by any device kind (the authenticator now records the signed device on the request even for kinds that aren't principals, such as staff phones); body `{ app_version, network, clock, attached? }`; answers `clock_skew_ms` (device clock minus the server's real clock), `clock_alert`, `back_online` and `attached_ignored`. `recordHeartbeat` and `flagQuietDevices` in `packages/db/src/heartbeats.ts`; the sweep in `apps/api/src/jobs/device-watch.ts`, run every 15 s by the scheduler's leader through a new `sweeps` option on `Scheduler`. `GET /devices` now includes `last_seen_at`, `online`, `clock_skew_ms` and `app_version`.
  - **Events.** `device.offline` and `device.online` to the venue (board and Admin), `venue.offline` and `venue.online` and `device.clock_skew` to managers only. Spec 08's live-events table names the three new types. There is no push or text yet: the alert is the live event on the managers' sockets until the notification work lands.
  - **Cautious defaults.** A venue with no `hours` setting is never "open", so nothing is raised there. A device that has never heartbeated isn't tracked (it's "not set up", not offline). A device whose last heartbeat said `network.type = "cellular"` (a manager's phone on LTE) doesn't count toward "the whole venue dropped", or the grouped alert could never fire while one such phone is online. `venue.offline` fires when every tracked device is quiet in one pass; devices flagged during a venue-wide outage each raise `device.online` when they return, and the first one back raises `venue.online`. The clock alert fires once per episode and clears silently when the clock is back within 30 s. Skew is against the server's real clock, like the signature window, so staging's simulated clock doesn't make every device look wrong.
  - **Fixed on the way.** Authentication moved from `onRequest` to `preValidation` in `conventions.ts`: at `onRequest` the body isn't parsed yet, so a signed POST's body hash was always the hash of "" and any client that signed its body was refused. M1-15's tests only signed GETs and never saw it. Also `USB printers and NFC readers report through their host`: the host lists them in `attached`; other kinds and other venues' ids are ignored and named back in `attached_ignored`.
  - **Later.** M1-17 seeds the 28 devices with heartbeats; the Board and Admin → Printers & devices screens show these events; M2-15 narrows the managers' alerts to the manager on duty; M8 pages us when a money path is at risk. Fifteen-second sweeps mean an alert lands within 2:15 of the last heartbeat.
### M1-17 · Load the M1 part of the demo seed into staging and local dev

- **Status:** done
- **Size:** S
- **Depends on:** M1-02, M1-11, M1-13, M1-14, M1-15
- **Spec:** [Demo seed · Loading the seed](../demo-seed.md#loading-the-seed); [Testing and operations](../spec/13-testing-operations.md) · The demo seed; [west4-friday.json](../../seed/west4-friday.json)
- **Build:**
  - A loader in `packages/db` for `seed/west4-friday.json`. Slugs become UUIDs, and each slug is kept as an external id so a test can find `room_9` or `maya` by name. Each later ticket adds its own part of the file.
  - The M1 part: `venue`, `settings`, `role_permissions`, `team` and `devices` (28 rows, 13 of 14 room tablets online). Demo PINs join in M1-23 and test badges in M1-25.
  - Settings mapped to spec 03's shapes where the seed's keys differ: `prices.billingStepMin` → `prices.billing.incrementMin`, `tabs.flagCents` → `tabs.flagOverCents`, `rooms.cleaningEndsBy` → `rooms.cleaningEnds`, `rooms.flagCleaningAfterMin` → `rooms.cleaningFlagMin`, `barMode.songsPerSingerPerRound` → `barMode.songsPerRound`, `occupancy.maxOccupancy` → `safety.occupancyLimit`, and `minimumSpend` → an empty `prices.minSpend`. `ordering.on` and `ordering.cancelUntil` are dropped: one is a module and the other a rule.
  - Modules from `venue.modules_on` and `modules_off`, with `allowed` true for the phase 1 modules and false for the four phase 2 ones.
  - `pnpm seed` for local dev and staging. Every load sets the simulated clock to Fri Sep 25, 2026, 10:41 PM, and each end-to-end test starts from a fresh load.
- **Acceptance:**
  - [x] After a load, West 4 has four memberships (Abhishek G. owner, Andy C. manager, Maya S. bartender, Diego R. front desk), 28 devices and the settings above, and `server_time` is 10:41 PM.
  - [x] Two loads give the same external ids.
  - [x] The loader refuses to run against production.
- **Tests:** a loader integration test that checks counts and a sample of values against the JSON.
- **Notes:** The seed's settings keys differ from spec 03 in the places above. The spec wins, so the loader maps them; the doc owners should align the seed. `null` in the seed stays empty and is never filled in.
  - **Built.** `packages/db/src/seed.ts`: `loadDemoSeed()` reads `seed/west4-friday.json` (`WEST4_SEED_FILE` overrides the path; the API image copies `seed/` to `packages/db/seed`), wipes the venue's M1 rows (devices and their heartbeats, codes and nonces, settings, modules, permission rows, memberships, seed ids) and reloads them in one transaction, then sets `clock_control` to Fri Sep 25, 2026, 10:41 PM. `pnpm seed` and `cli.js seed` run it; `scripts/seed.js` is gone. Every slug becomes the same UUID on every load (a version 5 UUID of the slug under a fixed namespace) and is kept in the new `seed_ids` table (migration 0014; `seedId(client, venueId, "maya")` looks one up). A person's slug (`maya`) is the `users` row; `maya.membership` is the membership. Tests: `seed.test.ts` (the mappings, no database) and `seed.int.test.ts` (counts, values, two loads, the refusal).
  - **Staging and end-to-end.** `deploy-staging.yml` runs the migrate task a second time with the `seed` command after every deploy. Playwright's global setup runs `pnpm seed` before every run, so the e2e CI job now has Postgres, migrates first, and starts the API with the staging switch; `e2e/api.spec.ts` checks that `server_time` reads 2026-09-25T22:4x-04:00 after the load (M1-06's last acceptance line).
  - **Production refusal.** `WEST4_ENV=production`, or a database host containing "prod", stops the load before it connects (`SeedRefused`).
  - **Permissions.** The seed's twelve prose rows map to the action ids in `packages/shared`; a row is written only where the seed differs from the default table (spec 03: no row means the default). West 4's table equals the defaults, so zero rows are written and the loader logs that.
  - **Modules.** Seed names map to module ids (`booking` → `online_booking`, `messages` → `guest_texts`, `songControl` → `song_system`, `marketing` → `marketing_texts`, `events` → `event_sales`, `crm` → `guests_loyalty`, `multiLocation` → `multi_location`). The four phase 2 modules are `allowed: false`; `song_system` and `marketing_texts` are phase 1, off but allowed.
  - **Devices.** Each online device gets a heartbeat at 10:41 PM; the Room 4 tablet gets one three hours old with `offline_since` set, so `listDevices` shows 13 of 14 tablets online. Staff phones are paired to their person (`user_id`) and have no heartbeat and no public key: a real pairing (M1-15) replaces that when a phone joins. `room_id` waits for M2; `cash_drawer_id` for M4.
  - **Cautious defaults, for the founder to confirm** (spec 03 requires these fields and neither the seed nor the spec states them for West 4; each is exported as `SEED_SETTING_DEFAULTS` so one change fixes them all): `prices.billing.rounding` "up" (changes nothing at a 1-minute step); `prices.booking` {minHours 1 (the first-hour minimum), maxHours 12 (open 4 PM to 4 AM), maxGuests = the largest seeded room's capacity, startSlots []}; `deposit.late` "keep" and `deposit.noShow` "keep" (the Admin canvas's first choice); `deposit.value` 0 (unused in firstHour mode); `drawer.secondCounter` "never", `drawer.paidOutApprovalCents` 2500 (the canvas's $25), `drawer.perPerson` {bartenders, countLater false} (unused with house drawers); `rooms.cleaningMin` 0 (no cleaning time reserved until Admin sets one); `messages.reminderAt` "14:00" (the spec says "afternoon of"); `pos.layouts` {} (no published layouts yet). `phone.callNumber` and `textNumber` are the seed's venue phone. Values the spec does state are filled from it (tip screen fixed amounts and threshold, Pay my share on, stay-on-when-free, drink credit, up-next alerts, room-ending 10 min, offer-expiring 5 min, warn at 90%, staff languages en and es).
  - **Dropped from the seed's settings:** `settings.rulePack` (the rule pack is its own row), `tabs.consentVersion` and `consentText` (a `policy_versions` row, built in M4), `deposit.bigParty.minSpendCents` (spec 03 keeps minimum spend in `prices.minSpend`; it is 0 at West 4), `occupancy.text` (a screen string), `minimumSpend.note` and the `*_source` notes. `dayCutover` and `timeZone` go on the `venues` row.
  - **Also not in the seed:** the organization's legal name (the venue's name stands in) and the address's parts (the seed's one line is split at its commas into line1, city and state; no ZIP).

### M1-18 · Send email through a transactional provider

- **Status:** done
- **Size:** S
- **Depends on:** M1-06
- **Spec:** [Scope and architecture](../spec/01-scope-architecture.md) · Email; [M1 · Ships](../milestones.md#m1--foundations) (the email provider sends invites and account recovery)
- **Build:**
  - A provider-neutral email adapter, sent from jobs in the normal pool: invites (M1-23) and account recovery (M1-20) now, receipts and reports later.
  - A local mail catcher in `docker compose`; a failure retries like any job and ends in the dead letters.
  - Staging sends only to our own addresses (an allow-list). No email ever carries a PIN.
- **Acceptance:**
  - [x] An invite email job lands in the local catcher.
  - [x] A provider error retries with backoff, then dead-letters with the reason.
  - [x] Staging refuses to send to an address outside the allow-list.
- **Tests:** adapter unit tests with a fake provider; a job integration test.
- **Notes:** The spec names no provider; the founder picks one. Built provider-neutral so the pick costs one setting:
  - `apps/api/src/email/`: `Mailer` (the adapter), `SmtpMailer` (nodemailer over `SMTP_URL`; every transactional provider offers an SMTP relay, so the founder's pick is that URL in the `smtp-url` secret) and `FakeMailer` for tests; `settings.ts` (`SMTP_URL`, `EMAIL_FROM`, `EMAIL_ALLOW_LIST`); `policy.ts` (the allow-list: addresses and `@domains`, case-insensitive); `templates.ts` (typed templates, words from the i18n catalogs in English and Spanish; only `invite` so far, M1-20 adds the recovery notice).
  - `apps/api/src/jobs/send-email.ts`: job kind `email.send` in the normal pool, `enqueueEmail()` for callers, and the handler. The payload is a strict schema of template name, address, locale and typed data, so a PIN or any other stray field is rejected rather than sent; the body is rendered at send time and never stored in the queue. The Message-ID is `<job-{id}@west4.email>` on every retry, the nearest thing SMTP has to an idempotency key.
  - **Allow-list, cautious default:** staging refuses an outside address twice, at enqueue (the caller sees the error) and at send (the job dead-letters with the domain, never the address). An unset `EMAIL_ALLOW_LIST` on staging is an empty list, so staging sends nothing until the founder puts our own addresses in `infra/staging` (`email_allow_list`); the worker logs one line about it at start. Local and production have no list.
  - Local mail catcher: `axllent/mailpit` in `docker-compose.yml` (inbox at http://localhost:8025) and in CI's integration job.
  - Staging: `SMTP_URL` secret (`smtp-url`, placeholder from `seed-secrets.sh`), `EMAIL_FROM` and `EMAIL_ALLOW_LIST` variables. Until the founder picks a provider and sets the secret, staging sends fail and dead-letter.
  - A malformed payload retries with backoff like any other failure before dead-lettering; nothing dead-letters at once. Harmless, noted for M1-06's follow-ups.

### M1-19 · Sign in owners and managers with a passkey or an authenticator app

- **Status:** done
- **Size:** M
- **Depends on:** M1-08, M1-14, M1-18
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what (Owner or manager); [API](../spec/08-api.md) · Conventions (Sign-in); [Security and data retention](../spec/12-security-retention.md) 3; [Admin](../screens.md#admin) note 1
- **Build:**
  - `POST /v1/auth/login`: the email identifies the account, and the sign-in is a passkey (WebAuthn, user verification required) or an authenticator-app code (TOTP). Two-step sign-in can't be turned off (`users.mfa_required` is true for every owner and manager).
  - Each session records how it was opened: passkey, authenticator, PIN or badge. Sessions last 12 hours and lock after 30 idle minutes.
  - Admin (settings, team changes and exports) and deciding approvals open only in a passkey session. A PIN or badge session never reaches them, on any device.
  - Large refunds, exports, team changes and card-fee changes ask for the passkey again on each such write.
  - A session cookie on the web and a bearer token in the desktop app (kept in the keychain by M1-28).
  - Tables the data model implies but doesn't name: `auth_credentials` (user_id, kind passkey or totp, credential_id, public_key, sign_count, secret_enc, created_at, last_used_at, revoked_at) and `auth_sessions` (principal, user_id, membership_id, device_id, assurance, started_at, last_seen_at, expires_at, ended_at, end_reason).
- **Acceptance:**
  - [x] Andy signs in with a passkey and opens Admin.
  - [x] Signed in with the authenticator app instead, Admin answers `403 forbidden` ("Admin needs a passkey"), and he can't decide an approval.
  - [x] A session idle for 30 minutes locks, and every session ends at 12 hours.
  - [x] A team change inside a passkey session asks for the passkey again.
  - [x] Every Admin route called with a PIN session or a badge session answers `403` (the full sweep is in M1-37).
- **Tests:** WebAuthn ceremonies with Playwright's virtual authenticator; TOTP with fixed secrets; session expiry on the simulated clock.
- **Notes:** The spec says "email plus a passkey or an authenticator app" and names no password. Cautious reading built here, recorded as D86: no passwords, and the authenticator path first sends a one-time code to the email, so it stays two steps. Flagged for the founder.
  - **Built.** `packages/db/migrations/0015_auth.sql`: `auth_credentials`, `auth_sessions` and `auth_challenges` (walled by the person, `user_id = app_user_id()`, since a passkey works at every venue its owner belongs to), the `require_mfa` trigger that sets `users.mfa_required` for every owner and manager (plus a one-time backfill as `app_migrator`), and two resolver functions for the moments nobody is signed in yet: `auth_user_by_email` and `auth_resolve_session` (which also moves `last_seen_at`, locks at 30 idle minutes and ends at 12 hours, on the clock the caller passes). `packages/db/src/auth.ts`: the queries, `withUser()` (a transaction as one person and no venue), AES-256-GCM sealing of authenticator secrets under `AUTH_SECRET_KEY`. `apps/api/src/auth/`: `totp.ts` (RFC 6238, tested against the RFC's vectors), `webauthn.ts` (`@simplewebauthn/server`, user verification required), `session-auth.ts` (the cookie `west4_session` on the web, `Authorization: Bearer` in the desktop app) and `routes.ts` (`POST /v1/auth/login`, `/enroll`, `/step-up`, `/logout`, `GET /v1/auth/me`). The registry gained `assurance: "passkey"` and `stepUp: true`; the conventions plugin refuses every `admin.*` action and `approvals.decide` outside a passkey session with `403 forbidden` ("Admin needs a passkey" / "Approving needs a passkey"), and a `stepUp` write without a fresh `X-Step-Up` token with `403 step_up_required`. New error codes `session_locked` and `session_expired` (401) tell the screen which happened; both are in spec 08 now.
  - **Enrollment (not in the ticket, but nothing signs in without it).** The first passkey or authenticator is enrolled after a code emailed to the account, only while the account has no credential at all; later ones need a passkey session with a step-up; an authenticator session may add its first passkey (so a seeded demo account can graduate to a passkey). Adding credentials from Admin → Team and revoking them is left to M1-31.
  - **Cautious defaults.** A locked session is ended (`end_reason = idle`) and the person signs in again; there is no unlock-in-place. An unknown email gets the same answers as a known one (passkey options with no allowed credentials; "code sent") so addresses can't be probed, and the auth routes are limited to 30 requests a minute per IP. Five wrong tries use up an emailed code or a pending authenticator secret. An authenticator code is accepted once (the step is remembered) with one 30-second step of drift. A passkey whose counter goes backwards is refused. The emailed code lives in the email job's payload until the job is cleaned up; the challenge stores only its hash.
  - **Sessions are not audited** (a `last_seen_at` update per request would flood the log); credentials are.
  - **Config.** `AUTH_SECRET_KEY` (64 hex), `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `SESSION_COOKIE_SAME_SITE`. Local falls back to a fixed development key, `localhost` and the three local origins; the development key is refused outside local, and production refuses to start without the passkey domain. Staging: the `auth-secret-key` secret (random from `seed-secrets.sh`), the staff CloudFront domain as the passkey domain, and `SameSite=None` because the API is on another site than the staff app.
  - **Seed.** `demo_email` and `demo_totp_secret` on Abhishek and Andy (placeholders on `demo.west4.local`, flagged in the seed), so local dev signs in with the email code from Mailpit plus any authenticator app. On staging the email code can't be delivered to a `.local` address: sign-in there waits on real addresses (Admin → Team, M1-31) on the allow-list. Founder's call whether the demo accounts should carry their real emails instead.
  - **Tests.** `apps/api/src/auth/auth.int.test.ts` (a software passkey in `test-passkey.ts` runs the ceremonies inside Vitest; the simulated clock drives the 30-minute and 12-hour limits) and `e2e/api.spec.ts` (Chromium's virtual authenticator enrols and signs in through the real browser API). `pg` became a root dev dependency so the smoke test can read the emailed code from the job queue, since the smoke run starts no worker.
  - **For later tickets.** M1-24 and M1-25 open their `pin` and `badge` sessions through `openSession()` with `principal = 'staff'`; M1-27 ends a person's sessions with `endAllSessions()`; M1-31 (team changes), exports, large refunds and card-fee changes declare `stepUp: true`; the staff app's sign-in screen (M1-26) uses `signIn.*` strings added to the catalogs.
### M1-20 · Add recovery codes and owner recovery

- **Status:** done
- **Size:** S
- **Depends on:** M1-18, M1-19
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Offboarding (owner recovery); [Security and data retention](../spec/12-security-retention.md) 3
- **Build:**
  - Ten single-use recovery codes, shown once at enrollment and stored hashed, in `recovery_codes` (user_id, code_hash, used_at), a table the data model implies but doesn't name.
  - An owner who loses access recovers with a recovery code or through a second owner, after a 48-hour delay, with notice to every manager at once by email.
- **Acceptance:**
  - [x] Abhishek's recovery code works once, and the same code fails a second time.
  - [x] A recovery started at 10:41 PM on Fri Sep 25 completes no earlier than 10:41 PM on Sun Sep 27, and Andy gets the notice at once.
- **Tests:** integration tests on the simulated clock; the notice email in the local catcher.
- **Notes:** "Recovers with a single-use recovery code or through a second owner, after a 48-hour delay" reads either way. Cautious reading built here: the delay covers both paths. Flagged for the founder.
  - **Built.** `packages/db/migrations/0016_recovery.sql`: `recovery_codes` (user_id, code_hash, used_at, plus revoked_at for a retired set) and `owner_recoveries` (who, by which path, requested_at, ready_at = +48 h, completed_at, cancelled_at), both walled by the person like the other auth tables, with two definer functions: `auth_co_owner` (is the caller an active owner at a venue the person also owns) and `auth_owner_recovery_contacts` (every owner and manager at every venue the person owns). Helpers in `packages/db/src/auth.ts`; routes in `apps/api/src/auth/routes.ts`: `POST /v1/auth/recover` (email + code, no session), `POST /v1/auth/recover/second-owner` (passkey session + step-up, co-owner only), `POST /v1/auth/recover/cancel` (the owner or a co-owner, passkey session), `POST /v1/auth/recovery-codes` (a fresh set, passkey + step-up, owners only); `GET /v1/auth/me` adds `recovery_codes_left`. The notice is the `owner_recovery_notice` email template, in English and Spanish, queued in one job per recipient the moment the recovery starts. Tests: `apps/api/src/auth/recovery.int.test.ts` on the simulated clock (the notice is checked in the queued job; the local mail catcher shows it once the email worker runs), plus the template in `templates.test.ts`. Spec 08 names the routes.
  - **How it completes.** Once the 48 hours are up, the owner enrols a new passkey or authenticator through the normal `POST /v1/auth/enroll` path (emailed code first), exactly as a new account would; that enrollment revokes every earlier sign-in method and session and marks the recovery completed. Before then, the enroll route sends nothing and refuses, so nothing can open early.
  - **Cautious defaults, flagged for the founder.** (1) The delay covers both paths, as the ticket says. (2) The notice goes to every owner *and* manager at each venue the owner owns, the owner's own address included: the spec names managers, and the second owner and the owner's own inbox are the two people most likely to spot a fraudulent start. (3) Any owner of a shared venue can cancel a pending recovery from a passkey session; the spec names nobody, and without a canceller the 48 hours would guard nothing. Managers can't cancel: they tell an owner. (4) Codes are for owners only (spec 12 · 3), issued at the first enrollment and again after a recovery, ten at a time, shown once; a fresh set on demand retires the old one. (5) A code is spent the moment it's accepted, before the notice goes out, so it works once whatever happens next; codes are ten characters from a 32-letter alphabet without 0/O/1/I (50 bits), stored as a SHA-256 hash.
  - **Later.** The sign-in screens (M1-21 onward) show the ten codes once and the "recovery started · ready from …" state; their strings are already in the catalogs (`recovery.*`). Recovery notices to a manager's phone (SMS) are not built; email only, as the ticket says.

### M1-21 · Build the staff app shell with every string in English and Spanish

- **Status:** done
- **Size:** M
- **Depends on:** M1-01, M1-09, M1-13, M1-14
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Languages; [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · rules 1, 11 and 12; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `languages`; [Testing and operations](../spec/13-testing-operations.md) · Tests (language tests); [Screens · Rules for every screen](../screens.md#rules-for-every-screen)
- **Build:**
  - `apps/staff` in React and Vite: one codebase with phone and desktop layouts, routing to each role's home.
  - The string catalog in `packages/shared`, in English (`en`) and Spanish (`es`), with plurals, numbers and money formatted per language. No string literal in staff JSX (an ESLint rule), and a CI script that fails the build when a key is missing in either language.
  - The language comes from `memberships.locale`, and `languages.staff` lists what the venue offers. Menu items keep their menu names in both languages.
  - "Now", "tonight" and every time on screen come from the venue's time zone and business date (M1-04, M1-12), never the device's clock.
  - The desktop side menu, built from the modules and the signed-in role: Tonight, Bar POS, Bar orders, Song queue (bar mode only), Calendar, Messages, Reports, Close the night, Admin and Lock. Each entry appears when its screen ships.
  - The WebSocket client from M1-09. The words come from the [glossary](../glossary.md#the-words-on-screen), with "Lock", never "Lock the iPad".
- **Acceptance:**
  - [x] Adding a string to `en` only fails CI and names the missing key.
  - [x] A string literal in a staff component fails lint.
  - [x] Switching the signed-in person to Español re-renders every visible string from the `es` catalog.
  - [x] Screens read 10:41 PM on the seed whatever the device clock says.
  - [x] Each M1 screen in Spanish, at 390 and at 1280 pixels wide, has no cut-off text.
- **Tests:** the catalog check in CI; a Playwright pass that renders each staff screen in its longest language and fails on clipped text (spec 13's language tests).
- **Notes:** A fluent speaker checks every staff screen's Spanish in M9. The Console is our own staff's tool, not a venue staff screen, so it ships in English; its strings still go through a catalog.
  - **Built.** `apps/staff` is a React Router app: `App.tsx` (providers and routes), `session.tsx` (who is signed in, their language), `clock.tsx` (the venue's clock from the API's `server_time`, the device clock only measures elapsed time), `events.tsx` (the M1-09 WebSocket client, with the offline band), `navigation.ts` (the side menu from modules and the role's permissions, `homeFor(role)`), `layout/Shell.tsx` (top bar, side menu on desktop, drawer on phones), `layout/LanguageSwitch.tsx` ("English · Español"), and screens `SignIn`, `Home` (each role's home until its screen ships) and `NotFound`. Vite proxies `/v1` (HTTP and WebSocket) to the API so the session cookie stays same-origin.
  - **Catalog.** `packages/shared/src/i18n`: `t(locale, key, params)` fills `{placeholders}`, `tn` picks plurals by `Intl.PluralRules`, `formatMoney` formats integer cents (no float; the formatter is handed a decimal string), `formatTime`/`formatDate` use the venue's time zone. Spanish is `es-US`: dollars and thousands as in the US, times as "10:41 p.m.". `pnpm i18n:check` (`scripts/i18n-check.mjs`) fails CI naming any key missing in either language or with different placeholders; it runs in the CI lint job and in `pnpm check`. ESLint rule `west4/no-jsx-literals` (`eslint-rules/`) fails any words in staff JSX text, `{"…"}` children or readable attributes (aria-label, title, placeholder, alt); symbols alone (☰, ·) pass.
  - **API.** `GET /v1/auth/me` now also returns `server_time` and, per membership, `locale`, `venue {name, time_zone, day_cutover}`, `modules` (state per module) and `permissions` (allowed actions for the role at that venue). `PATCH /v1/auth/me {membership_id, locale}` changes the signed-in person's own language, checked against the venue's `languages.staff`. Migration 0017 adds the definer function `auth_memberships_of`.
  - **Cautious default.** When a venue has no `languages` setting saved, both phase 1 languages are offered (spec 03: "English and Spanish in phase 1"); the seed saves `{ staff: ["en", "es"] }` for West 4.
  - **Menu entries.** All ten entries are defined with their module screen id and role action; only Tonight, Bar POS and Lock show today (`shipped: true`). Each later screen ticket flips its entry. "Runs" is the runner's phone home (`/runs`), not a side-menu entry.
  - **Sign-in here is the M1-19 web sign-in** (email, then a passkey or the authenticator app's code plus the emailed code) using the browser's own WebAuthn JSON APIs, no library. M1-24 and M1-26 add name tiles, PIN and badge and give the screen its final shape. Lock ends the session on this screen (logout) and shows sign-in with "Locked · sign in to continue"; shared-screen lock without ending the device pairing comes with M1-24.
  - **Tests.** `apps/staff/src/render.test.tsx` renders every shell screen to HTML in Spanish and in English and fails on any text that isn't a catalog string of that language (or data). `navigation.test.ts` covers module and permission filtering and each role's home. `e2e/staff.spec.ts` signs Andy in with a virtual passkey, pins the browser clock to 2031 and still reads 10:41 PM, switches to Español and checks every visible string against the `es` catalog, then checks each shell screen at 390 and 1280 px for clipped text (an element whose text overflows a box that hides overflow, or a sideways page scroll), and locks. The desktop smoke test now expects the sign-in heading. The staging deploy still publishes only the API and guest images; the staff app's hosting lands with M1-22/M1-28.

### M1-22 · Install the staff app to the home screen and send push

- **Status:** done
- **Size:** S
- **Depends on:** M1-15, M1-21
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Staff phones; [Scope and architecture](../spec/01-scope-architecture.md) · Staff app; [Tenancy and access](../spec/02-tenancy-access.md) · Offboarding; [Staff](../screens.md#staff) note 14
- **Build:**
  - A service worker that caches the app shell only, never API data, and a web app manifest, so the staff app installs to the home screen.
  - Web push (VAPID). A phone subscribes once it's the person's paired `staff_phone`; subscriptions live in `push_subscriptions` (device_id, endpoint, keys, created_at, revoked_at), a table the data model implies but doesn't name.
  - An iPhone setup screen that walks staff through Add to Home Screen first, since web push works only after that.
  - A push service in `apps/api` that sends to one person's phones, to a role's phones, and later to the manager on duty (M2-15). Revoking a device revokes its subscriptions.
- **Acceptance:**
  - [ ] On an Android phone, and on an iPhone added to the home screen, a test push reaches Andy's phone. _Needs a real phone against staging; the staff app has no public hostname until its hosting lands (M1-28 / go-live gate). The whole path short of the vendor push service is covered by tests._
  - [x] A revoked device's subscription receives nothing.
  - [x] The service worker never caches an API response.
- **Tests:** a push-service unit test with a fake push endpoint; a Playwright test of the install and subscribe flow.
- **Notes:** Which pushes each role gets is set by the milestones that raise them (calls and wrap-up alerts in M2; runs, the 30-second and 4-minute order alerts in M3; approvals in M2).
  - **Built.** `apps/staff/public/sw.js` caches the app shell only (navigations, scripts, styles, images, fonts and the manifest on this origin); anything under `/v1/` is never intercepted. It shows a push as a notification and a tap opens the push's path. `manifest.webmanifest` plus icons (a plain amber mark, no words) make the app installable; `index.html` carries the iOS meta tags. `apps/staff/src/push.ts` makes the phone's device key (non-extractable WebCrypto, kept in IndexedDB), registers the phone as the person's `staff_phone`, subscribes with the VAPID public key and saves the subscription in a request signed by the phone. `screens/Setup.tsx` ("Alerts on this phone", reached from the phone drawer) walks an iPhone through Add to Home Screen first, then one tap turns alerts on and a test alert checks it; states: loading, needs home screen, ready, working, on, denied, unsupported, failed.
  - **API.** Migration 0018 adds `push_subscriptions` (venue_id, device_id, endpoint, keys, created_at, revoked_at) with row-level security. Routes: `GET /v1/push/vapid-key`; `POST /v1/venues/:v/devices/staff-phone` (a signed-in person registers their own phone); `POST /v1/venues/:v/push/subscriptions` (must be signed by a `staff_phone` whose owner is the session's person; a revoked phone is refused); `POST /v1/venues/:v/push/test`. `apps/api/src/push/`: settings (VAPID from the environment; a fixed local-only pair in local dev), `WebPushSender` on the `web-push` library and `FakePushSender` for tests, and the `push.send` job: audience is a person or a role (M2-15 adds the manager on duty), the words are a catalog key rendered in each phone owner's language, sends happen outside any transaction, and a 404/410 revokes that subscription. `revokeDevice` now also revokes the device's subscriptions, so M1-27's offboarding gets it for free.
  - **Authenticators.** Every authenticator now runs on each request and the first principal wins (`http/conventions.ts`): a staff phone's signature is checked and recorded as `request.signedDevice` under its owner's session, which the subscription route needs. Before, the session authenticator's answer stopped the chain.
  - **Cautious defaults.** Pushes carry only a catalog key and a path, never guest data. Local VAPID keys are a fixed pair in `push/settings.ts`; staging and production must set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`.env.example`), and `infra/` needs those secrets before staging can push (not added here: a secret to create, which is the founder's).
  - **Tests.** `routes/push.int.test.ts`: registering the phone, signed subscription (unsigned or another person's session is 403), a test push through the fake endpoint in the owner's language, a role-wide push, a gone endpoint revoked, a revoked device receiving nothing. `apps/staff/src/sw.test.ts` loads the worker into a fake scope and checks what it answers. `e2e/staff.spec.ts` stands in for the browser's push service and checks the manifest, a controlling service worker, the registered phone, the saved subscription, the queued test alert and a cache with no API response. Playwright now runs one worker because the API and staff tests both re-enrol Andy's passkey.
  - **Left for later.** The desktop app and shared screens don't subscribe (phones only, per spec 09). The install prompt on Android is the browser's own; the setup screen only explains it. The seed's staff phones have no device key, so they can't push until each person opens the app on their phone.

### M1-23 · Invite staff, confirm their phone with a code, and let them set their own PIN

- **Status:** todo
- **Size:** M
- **Depends on:** M1-15, M1-18, M1-19, M1-21, M1-22
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what (Staff member), PINs; [API](../spec/08-api.md) · Sign-in, team and devices (`POST /team/invite`, `/team/{m}/reset-pin`); [N25 Set your PIN](../screens.md#n25-set-your-pin); [Pin](../screens.md#pin) note 8
- **Build:**
  - `POST /team/invite` (the owner, in a passkey session) creates the membership with its role and `pin_digits` (4 for staff, 6 for managers and owners) and emails an invite link.
  - The link opens on the person's own phone: they confirm their phone number once with a texted code, choose a PIN and pick their language ("English · Español"). Owners and managers also enroll a passkey. The phone is claimed as the person's `staff_phone` device (M1-15) and offered push (M1-22).
  - The PIN blocklist refuses common and sequential PINs (1234, 1111, 0000, 2580 and the rest of the list in `packages/shared`). A PIN is stored as Argon2id over `HMAC(pepper, venue_id ‖ membership_id ‖ PIN)`, with the pepper in the key service. No device caches a PIN hash.
  - `POST /team/{m}/reset-pin` sends a new link to the person's own phone. Nobody sets another person's PIN, and a PIN is never texted, emailed or shown.
  - Tables the data model implies but doesn't name: `invites` (membership_id, token_hash, expires_at, used_at) and `phone_codes` (phone_e164, code_hash, expires_at, attempts, verified_at).
  - The seed loader stores the demo PINs (Maya `4071`, Diego `6358`, Andy `730915`, Abhishek `915204`) as verifiers in staging only; production refuses them.
- **Acceptance:**
  - [ ] Diego's invite opens on his phone, confirms his number with a code, refuses 1234, 1111, 0000 and 2580, and accepts a 4-digit PIN of his own; Andy's invite needs 6 digits.
  - [ ] The database holds only Argon2id verifiers, and the same PIN for Maya and Diego gives two different verifiers.
  - [ ] A reset sends a new link to Maya's phone, and her old PIN stops working at once.
  - [ ] No screen, email or text contains a PIN, and the seed's demo PINs load only in staging.
- **Tests:** unit tests for the blocklist and the verifier; an end-to-end invite on a phone viewport with a fake text sender.
- **Notes:** The spec doesn't say which Twilio account sends phone codes. They aren't among the 14 venue texts, so they go from our platform's account (test credentials locally, our own test phones in staging), not West 4's subaccount (flagged). The server-checked CAPTCHA and daily limits on phone codes come in M2-27. Cautious default: a reset stops the old PIN at once rather than when the new one is set. People and roles are imported in M9, never PINs.

### M1-24 · Sign in on shared screens and phones with name and PIN, with lockouts

- **Status:** todo
- **Size:** M
- **Depends on:** M1-16, M1-22, M1-23
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · PINs, Who can call what; [Data model](../spec/04-data-model.md) · `pin_lockouts`; [API](../spec/08-api.md) · Sign-in, team and devices (`POST /v1/auth/pin`); [Security and data retention](../spec/12-security-retention.md) 3; [Pin](../screens.md#pin)
- **Build:**
  - `POST /v1/auth/pin`: the device's signature, the membership from the name tile and the PIN. A shared screen shows name tiles, so every try counts against one person. On a person's own phone, their PIN opens their session there.
  - `pin_lockouts` (venue_id, membership_id, device_id, failures, locked_until): five wrong tries lock that person on that device for 1 minute, the next five for 5 minutes, then 15 minutes each time; a right PIN resets them.
  - Ten wrong tries in a row on one device, across any names, pause PIN sign-in there until a manager pairs it again, and push an alert to the manager's phone. The device's alarm and heartbeat channel keeps working while it's paused.
  - A staff session on a shared device ends when the device locks or another badge takes over. A helper that later routes use to ask for the PIN again (refunds, cash counts and no-sale).
- **Acceptance:**
  - [ ] Maya signs in on the bar computer with her name and PIN (`4071` in staging).
  - [ ] Five wrong PINs lock Maya on the bar computer for 1 minute while she can still sign in at the front desk; the next five lock her for 5 minutes, then 15.
  - [ ] Ten wrong tries across Maya and Diego on the bar computer pause PIN sign-in there, and Andy's phone gets the alert.
  - [ ] While PIN sign-in is paused, the bar computer's heartbeats and its ring channel keep arriving.
- **Tests:** integration tests for the lockout ladder and the pause on the simulated clock; a channel test during the pause.
- **Notes:** "The manager's phone" means the manager on duty, which M2-15 defines; until then the alert goes to every manager's phone. The spec sets no session length for staff on their own phones; this uses the owner and manager cap of 12 hours (flagged).

### M1-25 · Check NTAG 424 DNA badges by their SUN message

- **Status:** todo
- **Size:** M
- **Depends on:** M1-15, M1-24
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Badges; [Data model](../spec/04-data-model.md) · `staff_badges`; [API](../spec/08-api.md) · Sign-in, team and devices (`POST /v1/auth/badge`, `/team/{m}/badges`, `/badges/{b}/disable`)
- **Build:**
  - `staff_badges` (venue_id, membership_id, uid_hash, key_version, last_counter, label, paired_by, paired_at, last_tap_at, disabled_at).
  - `POST /v1/auth/badge` takes the device's signature and the badge's SUN message. The server decrypts the tag's data (UID and read counter), works out the tag's key from the venue's master key in the key service and `key_version`, checks the CMAC, and accepts the tap only if the counter is above `last_counter`, which it then stores.
  - A disabled badge or a deactivated membership is refused. Someone else's tap takes over the screen at once and ends the other person's session there.
  - A badge session rings drinks, opens and closes tabs, takes payments and accepts orders; refunds, cash counts and no-sale ask for the PIN again; Admin needs a passkey.
  - `POST /team/{m}/badges` pairs a badge (the reader side is M1-30) and `POST /badges/{b}/disable` switches it off. The seed loader adds four test badges for the fake reader.
- **Acceptance:**
  - [ ] A tap from Maya's badge signs her in on the bar computer, answered by the server in under 300 ms.
  - [ ] The same SUN message sent twice: the second is refused (a replayed read).
  - [ ] A tag that answers with Maya's UID but a CMAC from another key is refused (a copied badge), and so is a message whose counter is lower than the last.
  - [ ] Diego's tap while Maya is signed in takes over at once; a disabled badge is refused.
- **Tests:** unit tests on the SUN examples in NXP's application note AN12196, written first; integration tests with a fake reader.
- **Notes:** Unsent drinks staying with the person who rang them is M6's bar POS.

### M1-26 · Build the sign-in screen and each role's home

- **Status:** todo
- **Size:** S
- **Depends on:** M1-21, M1-24, M1-25
- **Spec:** [Pin](../screens.md#pin); [Admin](../screens.md#admin); [Staff screens and the bar POS](../spec/10-staff-screens-bar-pos.md) · rule 1 (One home per role); [Tenancy and access](../spec/02-tenancy-access.md) · Languages; [Glossary · Say this, not that](../glossary.md#say-this-not-that)
- **Build:**
  - The Pin board on the bar and front-desk computers and on staff phones: a badge tap, or a name tile then the PIN pad (4 or 6 digits). The words are "badge or name and PIN" everywhere, the Lock label included.
  - "English · Español" on each person's own sign-in, saved to `memberships.locale`.
  - Homes by role: bartenders the bar POS, the front desk and managers the Tonight board, runners the Runs tab. Each home is a stub until M2, M3 and M6 build it. A phone opens the portal of the person who signed in, with that role's tabs only.
  - The line "Refunds, cash counts and no-sale ask for the PIN again; Admin needs a passkey", and Lock.
  - The Admin stub on phones: "Admin needs your passkey. Open it in the desktop app or in a browser." It never shows a PIN pad.
- **Acceptance:**
  - [ ] Maya's name and PIN on the bar computer open her home; Andy's and Diego's open the Tonight home.
  - [ ] On his phone, Diego picks Español at sign-in, and every M1 screen he can reach (sign-in, his home, Set your PIN, the Admin stub) is in Spanish, including his next sign-in on the front-desk computer.
  - [ ] No screen says "name and PIN" without "badge or".
  - [ ] The sign-in screen reads 10:41 PM on the seed, whatever the device clock says.
- **Tests:** Playwright on phone and desktop sizes in both languages; a copy test for the fixed sentences.
- **Notes:** [Pin](../screens.md#pin) notes 1 and 4–8 apply. Notes 2 and 3 (the duty at clock-in, the clock-out checklist and "Maya on 6h 41m") need the time clock, which comes in M7 ([N24](../screens.md#n24-clock-in-duty-and-clock-out-checklist)). Diego's Bar POS link "while he covers the bar" also needs the duty; until M7 the Admin switch decides.

### M1-27 · Offboard a person in one step

- **Status:** todo
- **Size:** S
- **Depends on:** M1-22, M1-24, M1-25
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Offboarding; [API](../spec/08-api.md) · Sign-in, team and devices (`POST /team/{m}/deactivate`)
- **Build:** `POST /team/{m}/deactivate` (the owner, passkey session, asked again) sets the membership's `status` and `deactivated_at`, switches off its badges, revokes its `staff_phone` devices and their keys, and ends every session in one transaction; after it commits, the person's sockets close and their push subscriptions are deleted. Every record they made stays.
- **Acceptance:**
  - [ ] Deactivating Diego ends his sessions on the front-desk computer and his phone, revokes his phone's key, closes his sockets and deletes his push subscriptions, all within a second.
  - [ ] Diego's badge and PIN are refused everywhere afterwards.
  - [ ] Diego's audit rows and every row he made are still there and still name him.
- **Tests:** an integration test that checks each item above.
- **Notes:** The spec has no reactivation step, so none is built.

### M1-28 · Build the Electron desktop shell with its security checklist

- **Status:** todo
- **Size:** M
- **Depends on:** M1-15, M1-21
- **Spec:** [Scope and architecture](../spec/01-scope-architecture.md) · Desktop app; [Security and data retention](../spec/12-security-retention.md) 6 and 10, How long we keep things (desktop cache); [Glossary · Desktop app](../glossary.md#people-devices-and-access)
- **Build:**
  - `apps/desktop`: Electron around the staff app, loaded from its own hostname.
  - Electron's security checklist: context isolation, sandboxing, no Node.js in remote content, a narrow preload API, a checked sender on every IPC message, navigation and new windows limited to our hostnames, and code-signed builds and updates.
  - The owner or manager bearer token is kept in the operating system's keychain through `safeStorage`; the device's signing key stays non-extractable (M1-15).
  - An encrypted SQLite cache (SQLCipher) keyed through `safeStorage`, holding only the current business date and wiped at the cutover. The offline view that reads it comes in M8.
  - The app follows `min_client_version`: an older build keeps working and updates between business days (M1-29).
- **Acceptance:**
  - [ ] The renderer can't reach Node.js (`require` fails), and an IPC message from an unexpected frame is refused.
  - [ ] Navigating to a host that isn't ours is blocked.
  - [ ] The cache file can't be read without the key, and after 6:00 AM it holds nothing from the business date before.
  - [ ] No token is in any plain file on disk.
- **Tests:** one automated test per checklist item; a cache test on the simulated clock.
- **Notes:** The alarm sound and the USB print host come in M3, the drawer kick in M4, and the offline view and queue mode in M8.

### M1-29 · Add the watchdog, start at login, keep awake and updates at the cutover

- **Status:** todo
- **Size:** S
- **Depends on:** M1-12, M1-28
- **Spec:** [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Room orders at the bar (the desktop app keeps the computer awake, starts at login, restarts itself through a watchdog and updates only between business days); [Testing and operations](../spec/13-testing-operations.md) · Releases
- **Build:**
  - Start at login on Windows and macOS, signed back in as its paired device with nobody signed in.
  - Keep the computer and its screen awake.
  - A watchdog, a small separate process run by the operating system (a launchd agent on macOS, a scheduled task or service on Windows), that restarts the app when it exits or stops answering.
  - Updates download in the background and install only at the business-day cutover (6:00 AM venue time) or at the first start after it, never mid-night. Only signed updates install.
- **Acceptance:**
  - [ ] Killing the app's process brings it back within 10 seconds with nobody touching the computer.
  - [ ] Restarting the computer starts the app at login, paired and showing the sign-in screen.
  - [ ] The screen doesn't sleep while the app runs.
  - [ ] An update published at 10:41 PM on Fri Sep 25 installs after 6:00 AM on Sat Sep 26, not before.
- **Tests:** a watchdog test on both operating systems in CI (or a scripted manual check on the bar computer if CI can't run it); an updater test on the simulated clock.
- **Notes:** The spec picks no watchdog tool; any that the operating system restarts itself will do.

### M1-30 · Read badges from the USB NFC reader in the desktop app, and pair them

- **Status:** todo
- **Size:** M
- **Depends on:** M1-25, M1-28
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Badges; [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Devices at West 4, Supported hardware; [AdminDesk](../screens.md#admindesk) note 4
- **Build:**
  - The desktop app reads the NDEF message from a USB NFC reader (PC/SC) at the bar computer and at the front desk, and sends the SUN message to `POST /v1/auth/badge` over the device's signed channel.
  - The reader is an `nfc_reader` device reported through its host computer's heartbeats.
  - Pairing from Admin → Team ("Pair (tap the reader)"): one tap on a new tag writes its SUN settings and its key worked out from the venue's master key with a `key_version`, then records `uid_hash` and `last_counter` against the membership. "Switch off" calls `POST /badges/{b}/disable`.
- **Acceptance:**
  - [ ] In staging, Maya takes over the paired bar computer with a badge tap in under 2 seconds, from the tap to her home on screen, on each of 20 taps.
  - [ ] With her badge at home, Maya takes over with her name and PIN.
  - [ ] Pairing a new badge to Diego takes one tap in Admin → Team, and it then works at both the bar and the front desk.
- **Tests:** an integration test with a reader emulator; the timed tap check on the staging bar computer with a real reader and badge.
- **Notes:** The spec doesn't say who sets up a factory tag's keys; this ticket does it at pairing (flagged). Needs the badges and readers ordered at the start of M1.

### M1-31 · Build the Admin shell and Admin → Team

- **Status:** todo
- **Size:** M
- **Depends on:** M1-19, M1-21, M1-23, M1-27, M1-30
- **Spec:** [AdminDesk](../screens.md#admindesk) notes 4, 5, 6 and 8; [Admin by milestone](../milestones.md#admin-by-milestone) (Team); [Tenancy and access](../spec/02-tenancy-access.md) · Roles, Languages, Offboarding; [API](../spec/08-api.md) · Sign-in, team and devices (`PATCH /team/{m}`)
- **Build:**
  - The AdminDesk shell, in the desktop app or any browser, opening only in a passkey session. A list of sections with a one-line hint each. Managers see every section except Payments, Team and Console. "Save and publish" writes the changed keys in one transaction, and nothing reaches the website or the room screens until Save.
  - The M1 sections: Team (this ticket), Features (M1-32), Hours & prices (M1-33) and Printers & devices (M1-34). Later milestones add theirs.
  - Admin → Team (owner only): each person with their role, invite state and a Language column (English or Español); a Badges column with "Pair (tap the reader)" and "Switch off"; invite, PIN reset and deactivate; role and language changes through `PATCH /team/{m}`, which ask for the passkey again; and the switch for the front desk using the bar POS when covering the bar. `GET /team` lists the people.
- **Acceptance:**
  - [ ] Abhishek sees Team; Andy's Admin has no Team, Payments or Console.
  - [ ] Setting Diego's language to Español in Team makes his next sign-in Spanish.
  - [ ] A role change asks for the passkey again and writes an audit row.
  - [ ] With Abhishek set to Español, every M1 Admin section is in Spanish.
- **Tests:** Playwright for each Team action; a permission test for the owner-only section.
- **Notes:** Tip eligibility and training mode come to Team in M7. `GET /team` isn't in the API table (flagged). [AdminDesk](../screens.md#admindesk) note 7 (training mode) waits for M7.

### M1-32 · Build Admin → Features

- **Status:** todo
- **Size:** S
- **Depends on:** M1-13, M1-31
- **Spec:** [AdminDesk](../screens.md#admindesk) notes 11, 12 and 22; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Modules, What each module hides; [Glossary · The escalation sentence](../glossary.md#the-escalation-sentence)
- **Build:**
  - Every phase 1 module within what the Console allows, each with its state (on, stopping or off), what it needs and what it hides (the effects table from M1-13). The core modules show as always on. Modules the plan doesn't allow read "Not in your plan".
  - The confirms from M1-13, including "Room orders would have nowhere to ring. Turn off Ordering from the room too?".
  - Bar screen & tickets described with the one escalation sentence: "Ages on screen: amber at 2 min, pink at 4 when the manager on duty is told; bar phones at 30 s; a text or call at 6; chime as backup."
  - Live counts ("5 open bar tabs · 8 rooms in use" at 10:41 PM on the seed) fill in as M2 and M6 add rooms and tabs.
- **Acceptance:**
  - [ ] At West 4, Features shows 13 modules on and Song system control and Marketing texts off, and doesn't show the four phase 2 modules.
  - [ ] Turning off Bar screen & tickets shows "Room orders would have nowhere to ring. Turn off Ordering from the room too?".
  - [ ] No module text says "Orders ring the bar until accepted".
- **Tests:** Playwright for the confirms; a copy test for the escalation sentence.
- **Notes:** The canvas and the glossary count "13 of 19", but spec 03 says no phase 1 screen shows the four phase 2 modules; build the spec and let the count follow what's shown (flagged).

### M1-33 · Build Admin → Hours & prices: weekly hours, the house last call and special dates

- **Status:** todo
- **Size:** S
- **Depends on:** M1-11, M1-12, M1-31
- **Spec:** [Admin by milestone](../milestones.md#admin-by-milestone) (Hours & prices, M1 part); [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · `hours`; [AdminDesk](../screens.md#admindesk)
- **Build:** the `hours` key (each day's opening and closing, closing after midnight such as 4:00 AM, and the house last call) and special and closed dates as `closures` rows. The house last call is checked against the rule pack on save (M1-11). Google shows as not connected (M5 connects it). Rates, bands, minimums, the VIP rate, booking limits and the damage fee join in M2, and minimum spend in M4.
- **Acceptance:**
  - [ ] West 4's hours read Mon to Fri 4:00 PM to 4:00 AM and Sat and Sun 2:00 PM to 4:00 AM.
  - [ ] Setting the house last call to 4:30 AM is refused with the reason, and 3:00 AM saves.
  - [ ] Adding a special date writes a `closures` row and changes that date's hours.
- **Tests:** Playwright for each field; the refused save.
- **Notes:** West 4's weekday hours come from the AdminDesk board's demo; only the 4 AM close is fixed by the brief ([Demo seed · West 4 and its rules](../demo-seed.md#west-4-and-its-rules)).

### M1-34 · Build Admin → Printers & devices: pairing and revoking

- **Status:** todo
- **Size:** S
- **Depends on:** M1-15, M1-16, M1-31
- **Spec:** [Admin by milestone](../milestones.md#admin-by-milestone) (Printers & devices, M1 part); [Devices, printing and offline](../spec/09-devices-printing-offline.md) · Devices at West 4, Pairing; [AdminDesk](../screens.md#admindesk) notes 4 and 9
- **Build:** a list of every device row with its kind, where it is, online state and when it was last seen, from the same rows the Console reads; "Pair a device" makes a one-time code; Revoke; rename; and setting a room tablet's room (`PATCH /devices/{d}`). The NFC readers are listed as devices. Printers are set up in M3, drawers and readers in M4, and the router in M8.
- **Acceptance:**
  - [ ] West 4's list shows the bar and front-desk computers, two NFC readers, two receipt printers, the Bar S710 and the Front desk S710, 14 room tablets with 13 online (Room 4's off), the Up next TV and the router.
  - [ ] A code made here pairs a new browser as a device, and Revoke signs it out at once.
- **Tests:** Playwright for pairing and revoking.
- **Notes:** None.

### M1-35 · Build the Console: sign-in with FIDO2 keys, the venue list, the module allow-list and venue flags

- **Status:** todo
- **Size:** M
- **Depends on:** M1-08, M1-13, M1-16
- **Spec:** [Console](../screens.md#console) notes 1, 2, 4 and 5; [Scope and architecture](../spec/01-scope-architecture.md) · Console; [Security and data retention](../spec/12-security-retention.md) 7; [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Modules
- **Build:**
  - `apps/console` on its own hostname. Our staff sign in with our single sign-on and a FIDO2 security key (WebAuthn with a hardware key required). Our staff accounts live in `console_staff` (sso_subject, name, email, active), a table the data model implies but doesn't name.
  - A read-only venue list with device health from the same device rows as Admin → Printers & devices.
  - Each venue's module allow-list (`venue_modules.allowed`, from its plan and add-ons), and its venue flags (`venue_flags`), with our own test venue first.
  - Every Console action is audited with our staff member's identity.
- **Acceptance:**
  - [ ] Signing in without a FIDO2 key fails.
  - [ ] West 4 shows 13 of 14 room tablets online (Room 4's off), both readers online and "Backup internet · on", the same as Admin.
  - [ ] Allowing a module for West 4 makes it switchable in Admin → Features at once.
  - [ ] Turning a venue flag on for our test venue leaves West 4's flags unchanged.
- **Tests:** WebAuthn sign-in with a virtual security key; integration tests for the allow-list and flags.
- **Notes:** Support grants and the emergency actions come in M8; plans, billing and tickets wait for the full panel in phase 2. The spec doesn't say what happens when we stop allowing a module a venue has on; cautious default built here: refused until the venue turns it off (nothing disappears mid-service), flagged.

### M1-36 · Publish rule-pack versions in the Console with two approvers and a signature

- **Status:** todo
- **Size:** S
- **Depends on:** M1-10, M1-31, M1-35
- **Spec:** [Settings, rule packs and modules](../spec/03-settings-rule-packs-modules.md) · Rule packs; [Security and data retention](../spec/12-security-retention.md) 11; [Console](../screens.md#console) note 2
- **Build:**
  - A Console flow for a new version: its data and `effective_on`, a first approver, a second approver who is a different person, then the signature from the key service. A version with one approval can't publish.
  - Admin shows every venue that uses the pack what changes and when, before it applies.
  - The version applies at the first business-date boundary on or after `effective_on` (M1-10).
- **Acceptance:**
  - [ ] A version with one approver can't publish, and the same person approving twice counts once.
  - [ ] A version published effective Sat Sep 26 leaves business date Fri Sep 25 on `2026.09`, and takes over at 6:00 AM on Sat Sep 26.
  - [ ] Andy sees what changes and the start date in Admin before it applies.
- **Tests:** integration tests for the two-person rule and the signature; a Playwright test of the Admin notice.
- **Notes:** None.

### M1-37 · Run the principal and venue-wall suites in CI and block merges

- **Status:** todo
- **Size:** M
- **Depends on:** M1-06, M1-08, M1-15, M1-19, M1-24, M1-25
- **Spec:** [Tenancy and access](../spec/02-tenancy-access.md) · Who can call what, The database walls (Tests); [Testing and operations](../spec/13-testing-operations.md) · Tests (principal and venue-wall tests); [Security and data retention](../spec/12-security-retention.md) 2
- **Build:**
  - A generator over the route registry that calls every route as every principal: nobody, an owner in a passkey session, an owner in an authenticator session, a manager, staff with a PIN on a shared device, a badge session, a shared device with nobody signed in, staff with a PIN on their own phone, a room tablet, a guest in a room, the host, a guest with a booking, a guest with a link, a singer, a printer, the Up next display and our support staff. It expects `401` or `403` wherever the route doesn't declare that principal.
  - The venue-wall suite: every endpoint as venue A with venue B's ids expects "not found"; every job kind run for venue A with venue B's ids finds nothing; every webhook resolves only its own venue as later milestones add them.
  - A new route, job kind or webhook with no declaration or no wall case fails CI. Both suites are required checks.
- **Acceptance:**
  - [ ] Both suites run on every pull request and a failure blocks the merge.
  - [ ] One generated assertion shows that no PIN session and no badge session reaches any Admin route.
  - [ ] Adding a route without principals, or a job kind without a wall case, fails CI.
- **Tests:** the two suites themselves, plus a test that a planted leak (a route that skips the venue check) makes them fail.
- **Notes:** Later milestones don't add their own suite tickets; their routes, jobs and webhooks join these suites the day they land.

## Coverage

Every item milestones.md lists for M1, and the tickets that build it.

| Item | What milestones.md says | Tickets |
| --- | --- | --- |
| Ships · Tenancy | Organizations, venues, users and memberships; row-level security, the resolver functions, venue foreign keys, grants and the read-only owner scope | M1-05, M1-03, M1-37 |
| Ships · Sign-in | Passkey or authenticator with recovery codes; staff invites with a phone code, then badge or name and PIN; blocklist, lockouts, peppered hash; SUN-checked badges on a USB reader; offboarding; the email provider | M1-18, M1-19, M1-20, M1-23, M1-24, M1-25, M1-27, M1-30 |
| Ships · Roles | The five default roles in `role_permissions`, checked before every write | M1-14 |
| Ships · Devices | Pairing with one-time codes, signed device keys, heartbeats, clock offsets and revoking; home-screen install and push | M1-15, M1-16, M1-22 |
| Ships · The desktop app shell | Electron with its security checklist, the encrypted cache and keychain token, start at login, keep awake, the watchdog, updates at the cutover and the USB badge reader | M1-28, M1-29, M1-30 |
| Ships · Settings, the rule pack and modules | Versioned `venue_settings` checked on every save; the New York County pack; business dates; `closures`; `venue_modules` with states, dependencies and `404 module_off`; `venue_flags` | M1-04, M1-10, M1-11, M1-12, M1-13 |
| Ships · Plumbing | The jobs table and scheduler, the event relay and WebSockets, idempotency keys, the audit hash chain and the migration linter | M1-03, M1-06, M1-07, M1-08, M1-09 |
| Ships · Languages | Every staff string in a catalog in English and Spanish; each person picks theirs | M1-21, M1-23, M1-26, M1-31 |
| Ships · The minimal Console, part 1 | SSO with FIDO2 keys; two-approver signed rule-pack publishing; the module allow-list and venue flags; the venue list with device health | M1-35, M1-36 |
| Ships · Staging | Seeded from the demo seed; local development on Docker Postgres and Stripe's sandbox | M1-01, M1-02, M1-17 |
| Ships · Canvas boards | Pin, AdminDesk, Admin and Console, with the badge column, the language picker and the module effects from the spec | M1-26, M1-31, M1-32, M1-33, M1-34, M1-35 |
| Admin · Team | People, roles, invites, badges and each person's language | M1-31, M1-30 |
| Admin · Features | Modules within the plan, their dependencies and what each hides | M1-32 |
| Admin · Hours & prices | Weekly hours, the house last call and special dates (M1 part) | M1-33 |
| Admin · Printers & devices | Pairing and revoking (M1 part) | M1-34 |
| GA-M9 | The security and PCI baseline: sign-in closes in M1 | M1-19, M1-20, M1-23, M1-24, M1-25, M1-27; the baseline's other M1 parts in M1-01, M1-05, M1-07, M1-28, M1-35, M1-36 |
| Done when · 1 | The principal and venue-wall suites pass in CI and block a merge | M1-37 |
| Done when · 2 | Maya's badge takeover in under 2 s and her name and PIN; Andy opens Admin with a passkey; no PIN session reaches Admin | M1-24, M1-25, M1-30, M1-19, M1-37 |
| Done when · 3 | A copied badge and a replayed read are refused | M1-25 |
| Done when · 4 | Lockouts of 1, 5 and 15 minutes; ten wrong tries pause the device and alert the manager; the alarm channel keeps working | M1-24 |
| Done when · 5 | A save that breaks the rule pack is refused with the reason; a version can't publish with one approver and applies at the next business-date boundary | M1-11, M1-10, M1-36 |
| Done when · 6 | The Bar screen & tickets confirm; `404 module_off` on every route of a module that's off | M1-13, M1-32 |
| Done when · 7 | The watchdog brings the app back, and it starts at login | M1-29 |
| Done when · 8 | Diego in Español sees every M1 staff screen in Spanish; CI fails on a missing string | M1-21, M1-26 |
| Done when · 9 | Deactivating a membership ends sessions, keys, sockets and push at once and keeps records | M1-27 |
| Done when · 10 | The daily audit hash lands in write-once storage, and a changed audit row breaks the chain | M1-07 |
