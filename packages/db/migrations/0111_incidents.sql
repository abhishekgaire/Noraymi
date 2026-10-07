-- Incidents (M8-08; spec 04 · incidents, incident_notes; screens N20; D58).
-- The guest's private "Need a manager, privately?" alert and the incident log:
-- only managers' and owners' phones read them; the board gets a count. Notes
-- are never edited, nothing here is deleted by the app, and a closed incident
-- is kept until keep_until (3 years, the rule pack's incidentsYears).
set lock_timeout = '5s';

create table incidents (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues (id),
  kind             text not null check (kind in ('unsafe', 'someone_needs_help', 'other')),
  room_id          uuid,
  session_id       uuid,
  room_guest_id    uuid,
  reported_via     text not null check (reported_via in ('room_page', 'staff_phone')),
  reported_by      uuid,                       -- a user, when a manager logs one by hand
  at               timestamptz not null,
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'closed')),
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  closed_by        uuid,
  closed_at        timestamptz,
  keep_until       timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, room_guest_id) references room_guests (venue_id, id),
  check ((acknowledged_at is null) = (acknowledged_by is null)),
  check ((closed_at is null) = (closed_by is null)),
  check ((status = 'closed') = (closed_at is not null)),
  check (status <> 'closed' or keep_until is not null),
  check ((reported_via = 'room_page') = (room_guest_id is not null)),
  check ((reported_via = 'staff_phone') = (reported_by is not null))
);
create index incidents_open_idx on incidents (venue_id, at) where status <> 'closed';
create index incidents_at_idx on incidents (venue_id, at desc);
alter table incidents enable row level security;
alter table incidents force row level security;
create policy venue_isolation on incidents to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on incidents to app_rw;
grant update (status, acknowledged_by, acknowledged_at, closed_by, closed_at, keep_until) on incidents to app_rw;
select audit_table('incidents');

create table incident_notes (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues (id),
  incident_id  uuid not null,
  text         text not null check (length(text) between 1 and 2000),
  added_by     uuid not null,                 -- a user
  added_at     timestamptz not null,
  unique (venue_id, id),
  foreign key (venue_id, incident_id) references incidents (venue_id, id)
);
create index incident_notes_incident_idx on incident_notes (venue_id, incident_id, added_at);
alter table incident_notes enable row level security;
alter table incident_notes force row level security;
create policy venue_isolation on incident_notes to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
-- Notes go to the log and are never edited: insert and read only.
grant select, insert on incident_notes to app_rw;
select audit_table('incident_notes');
