-- M9-11 · The timed staff trial's tap and time capture (spec 13 · Tests, Timed staff trial).
--
-- Only practice: the API takes these rows only from a person or device in
-- training mode. Each is one tap on a staff screen (the button's visible name
-- and the screen's path), an error the screen showed (its code), or a badge
-- take-over's two moments (the badge read, the screen signed in). No amounts,
-- no guest data: a tap's label is the button's own words, cut to 80
-- characters. The trial report (trial:report) reads them by time window.
set lock_timeout = '5s';

create table trial_events (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  membership_id  uuid,
  device_id      uuid,
  kind           text not null check (kind in ('tap', 'error', 'badge', 'signed_in')),
  label          text check (label is null or length(label) <= 80),
  screen         text check (screen is null or length(screen) <= 120),
  at             timestamptz not null,
  received_at    timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
create index trial_events_at_idx on trial_events (venue_id, at);
alter table trial_events enable row level security;
alter table trial_events force row level security;
create policy venue_isolation on trial_events to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on trial_events to app_rw;
-- A one-venue restore (M8-20) copies it like every venue table.
create policy restore_wall on trial_events to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on trial_events to app_migrator;
