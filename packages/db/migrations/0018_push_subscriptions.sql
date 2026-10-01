-- M1-22 · Web push for staff phones.
-- push_subscriptions is the table the data model implies but doesn't name:
-- one row per browser subscription on a paired staff_phone (spec 09 · Staff
-- phones). Revoking the device revokes its subscriptions (spec 02 ·
-- Offboarding), and a push service that answers 404 or 410 revokes one too.
set lock_timeout = '5s';

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues (id),
  device_id   uuid not null,
  endpoint    text not null,
  keys        jsonb not null,                       -- { p256dh, auth } from the browser
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (venue_id, endpoint),
  unique (venue_id, id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
create index push_subscriptions_device_idx on push_subscriptions (venue_id, device_id) where revoked_at is null;

alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
create policy venue_isolation on push_subscriptions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on push_subscriptions to app_rw;
