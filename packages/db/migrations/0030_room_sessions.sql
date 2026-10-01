-- M2-07 · Room sessions and their clock segments (spec 04). The session is
-- the room clock; booked_end_at is soft and never stops it. Room time bills
-- from the segments (spec 05 rule 3). check_id points at the check that
-- arrives in M3; it's a plain id until then.
set lock_timeout = '5s';

create table room_sessions (
  id                     uuid primary key default gen_random_uuid(),
  venue_id               uuid not null references venues (id),
  room_id                uuid not null,
  booking_id             uuid,
  check_id               uuid,
  party_size             integer not null check (party_size >= 1),
  started_at             timestamptz not null,
  booked_end_at          timestamptz,
  ended_at               timestamptz,
  business_date          date not null,
  server_user_id         uuid,
  room_code_hash         text,
  token_version          integer not null default 1,
  host_token_hash        text,
  host_lock              boolean not null default false,
  ordering_locked        boolean not null default false,
  min_spend_cents        integer check (min_spend_cents >= 0),
  alcohol_cut_off_at     timestamptz,
  alcohol_cut_off_by     uuid,
  alcohol_cut_off_reason text,
  booked_by              uuid,
  created_at             timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id),
  foreign key (venue_id, booking_id) references bookings (venue_id, id)
);
create index room_sessions_open_idx on room_sessions (venue_id, room_id) where ended_at is null;
alter table room_sessions enable row level security;
alter table room_sessions force row level security;
create policy venue_isolation on room_sessions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on room_sessions to app_rw;
select audit_table('room_sessions');

create table session_segments (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  session_id      uuid not null,
  room_id         uuid not null,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  billable_guests integer not null check (billable_guests >= 1),
  rate_kind       text not null check (rate_kind in ('per_person', 'base_plus_extra', 'flat_by_size', 'vip')),
  hourly_cents    integer not null check (hourly_cents >= 0),
  band_id         text,
  increment_min   integer not null default 1 check (increment_min in (1, 15, 30, 60)),
  rounding        text not null default 'nearest' check (rounding in ('up', 'nearest', 'down')),
  paused          boolean not null default false,
  reason          text,
  approved_by     uuid,
  unique (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id),
  check (ended_at is null or ended_at >= started_at),
  check (not paused or approved_by is not null)
);
create index session_segments_session_idx on session_segments (venue_id, session_id, started_at);
alter table session_segments enable row level security;
alter table session_segments force row level security;
create policy venue_isolation on session_segments to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on session_segments to app_rw;
select audit_table('session_segments');
