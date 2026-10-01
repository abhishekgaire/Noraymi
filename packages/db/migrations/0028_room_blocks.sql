-- M2-05 · Room blocks (spec 04 · the money core, Room assignment). Bookings,
-- holds, sessions, cleaning, out of service and buyouts, which can't overlap
-- in one room: the exclusion constraint is the last word, not the screens.
-- The spec's SQL plus an id (for updates and the audit trail) and the venue
-- wall. An open-ended period ('[from,)') is a cleaning or out-of-service block
-- that lasts until staff end it.
set lock_timeout = '5s';

create extension if not exists btree_gist;

create table room_blocks (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues (id),
  room_id    uuid not null,
  period     tstzrange not null,
  kind       text not null check (kind in ('booking', 'hold', 'session', 'cleaning', 'out_of_service', 'buyout')),
  ref_id     uuid,
  expires_at timestamptz,                -- a hold lapses here; the hold sweep deletes it
  created_at timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id),
  check (kind = 'hold' or expires_at is null),
  check (not isempty(period)),
  exclude using gist (venue_id with =, room_id with =, period with &&)
);
create index room_blocks_ref_idx on room_blocks (venue_id, ref_id);
alter table room_blocks enable row level security;
alter table room_blocks force row level security;
create policy venue_isolation on room_blocks to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on room_blocks to app_rw;
grant select, delete on room_blocks to app_definer;
create policy definer_all on room_blocks to app_definer using (true) with check (true);

-- app_rw never deletes. Two doors, each held to the caller's venue:
-- the hold sweep removes holds that lapsed, and releasing frees one block
-- (a cancelled booking, a hold taken up). The audit trigger records both.
create or replace function expire_room_holds(p_now timestamptz) returns setof uuid
language sql security definer
set search_path = pg_catalog, public
as $$
  delete from room_blocks
   where venue_id = app_venue_id() and kind = 'hold' and expires_at <= p_now
  returning room_id
$$;
alter function expire_room_holds(timestamptz) owner to app_definer;
revoke all on function expire_room_holds(timestamptz) from public;
grant execute on function expire_room_holds(timestamptz) to app_rw;

create or replace function release_room_block(p_id uuid) returns boolean
language sql security definer
set search_path = pg_catalog, public
as $$
  with gone as (delete from room_blocks where venue_id = app_venue_id() and id = p_id returning 1)
  select exists (select 1 from gone)
$$;
alter function release_room_block(uuid) owner to app_definer;
revoke all on function release_room_block(uuid) from public;
grant execute on function release_room_block(uuid) to app_rw;
select audit_table('room_blocks');
