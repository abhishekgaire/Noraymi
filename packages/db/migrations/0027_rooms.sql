-- M2-04 · Rooms and their states (spec 04 · rooms, room_states). Fourteen at
-- West 4 in four size tiers. A room is archived, never deleted. room_states
-- holds each room's current state; the audit trigger keeps the history.
set lock_timeout = '5s';

create table rooms (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  name            text not null,
  size_tier       text not null,
  capacity_min    integer not null check (capacity_min >= 1),
  capacity_max    integer not null check (capacity_max >= capacity_min),
  cleaning_min    integer check (cleaning_min >= 0),     -- null: the venue's rooms.cleaningMin
  is_vip          boolean not null default false,
  bookable_online boolean not null default true,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, name)
);
alter table rooms enable row level security;
alter table rooms force row level security;
create policy venue_isolation on rooms to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on rooms to app_rw;
select audit_table('rooms');

create table room_states (
  venue_id uuid not null references venues (id),
  room_id  uuid not null,
  state    text not null check (state in ('available', 'in_use', 'wrap_up', 'cleaning', 'out_of_service')),
  reason   text,
  since    timestamptz not null,
  until    timestamptz,
  set_by   uuid,
  primary key (venue_id, room_id),
  foreign key (venue_id, room_id) references rooms (venue_id, id)
);
alter table room_states enable row level security;
alter table room_states force row level security;
create policy venue_isolation on room_states to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on room_states to app_rw;
select audit_table('room_states');

-- A tablet's room (0012 left the key for now).
alter table devices add foreign key (venue_id, room_id) references rooms (venue_id, id);
