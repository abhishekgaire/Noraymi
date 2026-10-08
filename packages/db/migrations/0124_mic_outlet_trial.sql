-- M8-23 · The one-room mic power trial (K1; spec 11 · Mic power trial; D83).
--
-- Our own switched outlet on one room's wireless-mic receiver, never on the
-- song player, is a `devices` row of kind mic_outlet (0012). It asks us what
-- to do; we answer with a short-lived signed command, on while the room has
-- an open session and off otherwise. mic_outlet_switches is the trial log:
-- one row each time the answer for an outlet changes, with why.
set lock_timeout = '5s';

create table mic_outlet_switches (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues (id),
  device_id  uuid not null,
  room_id    uuid,
  state      text not null check (state in ('on', 'off')),
  reason     text not null check (reason in ('session_open', 'no_session', 'trial_off')),
  at         timestamptz not null,
  unique (venue_id, id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
create index mic_outlet_switches_device_idx on mic_outlet_switches (venue_id, device_id, at);
alter table mic_outlet_switches enable row level security;
alter table mic_outlet_switches force row level security;
create policy venue_isolation on mic_outlet_switches to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on mic_outlet_switches to app_rw;
-- A one-venue restore (M8-20) copies it like every venue table.
create policy restore_wall on mic_outlet_switches to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on mic_outlet_switches to app_migrator;
