-- Room calls (M2-20; spec 04 · room_calls; screens N19). "Another mic, please"
-- reaches the board and every staff phone's Calls list; On it records who and
-- when and clears it everywhere. Help alerts are incidents (M8), not calls.
set lock_timeout = '5s';

create table room_calls (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues (id),
  session_id  uuid not null,
  kind        text not null check (kind in ('mic', 'tv', 'check', 'other')),
  created_at  timestamptz not null,
  acked_by    uuid,                       -- a user
  acked_at    timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  check ((acked_at is null) = (acked_by is null))
);
create index room_calls_open_idx on room_calls (venue_id, created_at) where acked_at is null;
alter table room_calls enable row level security;
alter table room_calls force row level security;
create policy venue_isolation on room_calls to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on room_calls to app_rw;
grant update (acked_by, acked_at) on room_calls to app_rw;
select audit_table('room_calls');
