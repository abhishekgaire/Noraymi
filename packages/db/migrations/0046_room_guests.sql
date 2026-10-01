-- Joining a room (M3-08; spec 04 · room_guests; spec 09 · Joining a room;
-- spec 12 · 9). A guest trades the room's code once for a 128-bit token in an
-- httpOnly cookie; only its hash is kept. The Room code text's link joins its
-- opener as the host. token_version is the session's when the token was
-- issued: a move, a host lock or a new code raises the session's, and joined
-- phones are given a fresh token and the new code on their next call.
-- room_code_enc is the code sealed with the API's secret key, so joined phones
-- can be shown the new one; wrong_codes counts toward the ten that rotate it.
set lock_timeout = '5s';

alter table room_sessions add column room_code_enc text;
alter table room_sessions add column wrong_codes integer not null default 0;
alter table room_sessions add column code_alert_at timestamptz;

create table room_guests (
  id                      uuid primary key default gen_random_uuid(),
  venue_id                uuid not null references venues (id),
  session_id              uuid not null,
  room_id                 uuid not null,             -- the room the token was issued in
  token_hash              text not null unique,
  token_version           integer not null,
  name                    text check (name is null or length(name) between 1 and 40),
  is_host                 boolean not null default false,
  joined_at               timestamptz not null,
  last_seen_at            timestamptz,
  left_at                 timestamptz,
  alcohol_cut_off_at      timestamptz,
  alcohol_cut_off_by      uuid,
  alcohol_cut_off_reason  text,
  unique (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id)
);
create index room_guests_session_idx on room_guests (venue_id, session_id);
alter table room_guests enable row level security;
alter table room_guests force row level security;
create policy venue_isolation on room_guests to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert, update on room_guests to app_rw;
select audit_table('room_guests');

alter table orders add constraint orders_room_guest_fkey
  foreign key (venue_id, room_guest_id) references room_guests (venue_id, id) not valid;
alter table orders validate constraint orders_room_guest_fkey;

-- The resolvers below read these two tables before a venue is set, and return ids only.
grant select on room_guests, room_sessions to app_definer;
create policy definer_read on room_guests for select to app_definer using (true);
create policy definer_read on room_sessions for select to app_definer using (true);

-- A guest's cookie, before any venue is known: the venue and the guest it belongs to.
create or replace function resolve_room_session(p_token_hash text)
returns table (venue_id uuid, room_guest_id uuid)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select g.venue_id, g.id from room_guests g where g.token_hash = p_token_hash and g.left_at is null
$$;
alter function resolve_room_session(text) owner to app_definer;
revoke all on function resolve_room_session(text) from public;
grant execute on function resolve_room_session(text) to app_rw;

-- The host link from the Room code text: the venue and the open session it belongs to.
create or replace function resolve_room_host(p_hash text)
returns table (venue_id uuid, session_id uuid)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select s.venue_id, s.id from room_sessions s where s.host_token_hash = p_hash and s.ended_at is null
$$;
alter function resolve_room_host(text) owner to app_definer;
revoke all on function resolve_room_host(text) from public;
grant execute on function resolve_room_host(text) to app_rw;
