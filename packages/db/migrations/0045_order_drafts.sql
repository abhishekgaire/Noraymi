-- Unsent drinks (M3-07; spec 04 · order_drafts; spec 10 rule 8): each person's
-- own for each tab (check_id) or the quick sale (no check), saved on the
-- server as they're rung, so a badge swap, a crash or the other terminal
-- loses nothing. Never part of a check; emptied when sent (and at the night
-- close, M7). A PUT carries the version it read.
set lock_timeout = '5s';

create table order_drafts (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  membership_id  uuid not null,
  check_id       uuid,
  device_id      uuid,
  lines          jsonb not null default '[]',
  version        integer not null default 1,
  updated_at     timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, membership_id) references memberships (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
create unique index order_drafts_key_idx on order_drafts (venue_id, membership_id, check_id) nulls not distinct;
alter table order_drafts enable row level security;
alter table order_drafts force row level security;
create policy venue_isolation on order_drafts to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert, update on order_drafts to app_rw;
select audit_table('order_drafts');
