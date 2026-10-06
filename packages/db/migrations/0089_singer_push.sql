-- Singer alerts (M6-21; Song systems and texts · Alerts; D62): the singer's
-- phone subscribes to web push from the queue page, so "2 singers before you"
-- and "You're up next at the bar · come to the stage" reach it while the page
-- is closed. One row per browser subscription, held by the singer; a push
-- service that answers 404 or 410 revokes it. Staff phones keep theirs in
-- push_subscriptions, which belong to paired devices.
set lock_timeout = '5s';

create table singer_push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues (id),
  singer_id   uuid not null,
  endpoint    text not null,
  keys        jsonb not null,                       -- { p256dh, auth } from the browser
  created_at  timestamptz not null,
  revoked_at  timestamptz,
  unique (venue_id, endpoint),
  unique (venue_id, id),
  foreign key (venue_id, singer_id) references singers (venue_id, id)
);
create index singer_push_by_singer on singer_push_subscriptions (venue_id, singer_id)
  where revoked_at is null;

alter table singer_push_subscriptions enable row level security;
alter table singer_push_subscriptions force row level security;
create policy venue_isolation on singer_push_subscriptions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on singer_push_subscriptions to app_rw;
