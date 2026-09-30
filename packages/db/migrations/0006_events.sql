-- 0006 · venue_events: live events written with each change, stamped in
-- commit order by the relay leader (spec 01 · Live updates; spec 08 · Live
-- events; M1-09).
set lock_timeout = '5s';

create table venue_events (
  id             bigint generated always as identity primary key,
  venue_id       uuid not null references venues (id),
  type           text not null,
  entity_id      text not null,
  entity_version int not null default 0,
  at             timestamptz not null default now(),
  -- routing, never sent on the wire
  room_id        uuid,                          -- room.* and order.* events name their room
  audience       text not null default 'venue' check (audience in ('venue', 'room', 'staff', 'managers', 'user', 'display')),
  user_id        uuid,                          -- audience = 'user': the one person (draft.updated)
  -- stamping
  xid            xid8 not null default pg_current_xact_id(),
  seq            bigint,                        -- per venue, in commit order; null until the relay stamps it
  stamp          bigint,                        -- global tail position, set with seq
  unique (venue_id, id)
);
create index venue_events_unstamped_idx on venue_events (xid) where seq is null;
create index venue_events_tail_idx on venue_events (stamp) where stamp is not null;
create index venue_events_venue_seq_idx on venue_events (venue_id, seq) where seq is not null;
create sequence venue_events_stamp_seq;
grant select on sequence venue_events_stamp_seq to app_rw;  -- the tail starts from the current end
grant usage, select on sequence venue_events_stamp_seq to app_definer;  -- the relay stamps

create table venue_event_counters (
  venue_id uuid primary key references venues (id),
  last_seq bigint not null default 0
);
alter table venue_event_counters enable row level security;
alter table venue_event_counters force row level security;
create policy venue_isolation on venue_event_counters for select to app_rw using (venue_id = app_venue_id());
create policy definer_all on venue_event_counters to app_definer using (true) with check (true);
grant select on venue_event_counters to app_rw;

alter table venue_events enable row level security;
alter table venue_events force row level security;
create policy venue_isolation on venue_events to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_all on venue_events to app_definer using (true) with check (true);
grant select, insert on venue_events to app_rw;
grant select, insert, update, delete on venue_events to app_definer;
grant select, insert, update on venue_event_counters to app_definer;

-- Wake the relay when a row lands (NOTIFY fires on commit).
create or replace function venue_events_notify() returns trigger
language plpgsql
as $$
begin
  perform pg_notify('west4_events', new.venue_id::text);
  return null;
end $$;
create trigger venue_events_notify after insert on venue_events for each row execute function venue_events_notify();

-- The relay leader calls this: stamp, in commit order, every row whose
-- transaction committed before every transaction still running (its xid is
-- below the current snapshot's xmin). seq counts per venue; stamp is the
-- global tail position. Returns how many rows were stamped.
create or replace function stamp_venue_events(p_limit int default 1000) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
  n int := 0;
  v_seq bigint;
begin
  for r in
    select id, venue_id from venue_events
    where seq is null and xid < pg_snapshot_xmin(pg_current_snapshot())
    order by xid, id
    limit p_limit
  loop
    insert into venue_event_counters (venue_id, last_seq) values (r.venue_id, 1)
      on conflict (venue_id) do update set last_seq = venue_event_counters.last_seq + 1
      returning last_seq into v_seq;
    update venue_events set seq = v_seq, stamp = nextval('venue_events_stamp_seq') where id = r.id;
    n := n + 1;
  end loop;
  if n > 0 then
    perform pg_notify('west4_stamped', n::text);
  end if;
  return n;
end $$;
alter function stamp_venue_events(int) owner to app_definer;
revoke all on function stamp_venue_events(int) from public;
grant execute on function stamp_venue_events(int) to app_rw;

-- Every API container tails stamped rows across venues, then filters per socket.
create or replace function tail_venue_events(p_after_stamp bigint, p_limit int default 500)
returns table (stamp bigint, venue_id uuid, seq bigint, type text, entity_id text, entity_version int, at timestamptz, room_id uuid, audience text, user_id uuid)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select stamp, venue_id, seq, type, entity_id, entity_version, at, room_id, audience, user_id
  from venue_events where stamp > p_after_stamp order by stamp limit p_limit
$$;
alter function tail_venue_events(bigint, int) owner to app_definer;
revoke all on function tail_venue_events(bigint, int) from public;
grant execute on function tail_venue_events(bigint, int) to app_rw;

-- A reconnecting screen: everything after its last seq for its venue, plus the
-- oldest seq still kept, so the caller can tell a gap from a normal catch-up.
create or replace function venue_events_after(p_venue uuid, p_after_seq bigint, p_limit int default 1000)
returns table (seq bigint, type text, entity_id text, entity_version int, at timestamptz, room_id uuid, audience text, user_id uuid)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select seq, type, entity_id, entity_version, at, room_id, audience, user_id
  from venue_events where venue_id = p_venue and seq > p_after_seq order by seq limit p_limit
$$;
alter function venue_events_after(uuid, bigint, int) owner to app_definer;
revoke all on function venue_events_after(uuid, bigint, int) from public;
grant execute on function venue_events_after(uuid, bigint, int) to app_rw;

create or replace function venue_events_bounds(p_venue uuid)
returns table (oldest_seq bigint, latest_seq bigint)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select min(seq), max(seq) from venue_events where venue_id = p_venue and seq is not null
$$;
alter function venue_events_bounds(uuid) owner to app_definer;
revoke all on function venue_events_bounds(uuid) from public;
grant execute on function venue_events_bounds(uuid) to app_rw;

-- Events are kept 72 hours; the bulk job calls this.
create or replace function clear_venue_events(p_before timestamptz) returns bigint
language sql volatile security definer
set search_path = pg_catalog, public
as $$
  with gone as (delete from venue_events where at < p_before and seq is not null returning 1)
  select count(*) from gone
$$;
alter function clear_venue_events(timestamptz) owner to app_definer;
revoke all on function clear_venue_events(timestamptz) from public;
grant execute on function clear_venue_events(timestamptz) to app_rw;
