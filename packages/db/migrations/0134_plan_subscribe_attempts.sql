-- Our plan's subscribe attempts (M8-15 fix, Oct 9, 2026). Starting a venue's
-- plan writes one row here before it asks Stripe Billing for the
-- subscription, and the row's id is the call's idempotency key. A retry of
-- the same attempt (same plan and room count, no subscription recorded yet)
-- reuses the row, so Stripe answers with the subscription it already made;
-- a new attempt, such as resubscribing after a cancel, gets a new row and a
-- new key. The old key was the venue and the plan alone, so a resubscribe
-- with other items within Stripe's 24 hours was refused as a key reused
-- with different parameters.
set lock_timeout = '5s';

create table plan_subscribe_attempts (
  id                      uuid primary key default gen_random_uuid(),
  venue_id                uuid not null references venues (id),
  plan                    text not null check (plan in ('bar', 'rooms', 'rooms_kitchen')),
  rooms                   integer not null check (rooms >= 0),
  -- Set once Stripe's subscription is recorded in venue_subscriptions.
  stripe_subscription_id  text check (char_length(stripe_subscription_id) <= 255),
  created_at              timestamptz not null default now(),
  finished_at             timestamptz,
  unique (venue_id, id)
);
alter table plan_subscribe_attempts enable row level security;
alter table plan_subscribe_attempts force row level security;
create policy venue_isolation on plan_subscribe_attempts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on plan_subscribe_attempts to app_rw;
grant update (stripe_subscription_id, finished_at) on plan_subscribe_attempts to app_rw;
select audit_table('plan_subscribe_attempts');
-- A one-venue restore (M8-20) copies it like every venue table.
create policy restore_wall on plan_subscribe_attempts to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on plan_subscribe_attempts to app_migrator;
