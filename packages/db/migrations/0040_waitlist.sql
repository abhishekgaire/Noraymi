-- The walk-in waitlist (M2-25; spec 04 · waitlist_entries; screens N11). Staff
-- add parties from the drawer; guests join from the door QR and follow their
-- place on a page behind a link token (128 bits, stored hashed, expiring).
set lock_timeout = '5s';

create table waitlist_entries (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues (id),
  guest_id          uuid not null,
  party_size        integer not null check (party_size between 1 and 500),
  size_tier_needed  text not null check (size_tier_needed in ('small', 'medium', 'large', 'vip')),
  joined_at         timestamptz not null,
  quoted_min        integer check (quoted_min is null or quoted_min between 0 and 600),
  status            text not null default 'waiting'
                    check (status in ('waiting', 'offered', 'seated', 'declined', 'expired', 'left')),
  offered_room_id   uuid,
  offer_expires_at  timestamptz,
  offer_message_id  uuid,
  check_id          uuid,
  source            text not null check (source in ('staff', 'door')),
  link_token_hash   text unique,
  link_expires_at   timestamptz,
  ended_at          timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, guest_id) references guests (venue_id, id),
  foreign key (venue_id, offered_room_id) references rooms (venue_id, id),
  foreign key (venue_id, offer_message_id) references messages (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  check ((link_token_hash is null) = (link_expires_at is null))
);
create index waitlist_live_idx on waitlist_entries (venue_id, joined_at) where status in ('waiting', 'offered');
alter table waitlist_entries enable row level security;
alter table waitlist_entries force row level security;
create policy venue_isolation on waitlist_entries to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on waitlist_entries to app_rw;
grant update (quoted_min, status, offered_room_id, offer_expires_at, offer_message_id, check_id, ended_at)
  on waitlist_entries to app_rw;
grant select on waitlist_entries to app_definer;
create policy definer_read on waitlist_entries for select to app_definer using (true);
select audit_table('waitlist_entries');

-- Requests that arrive without a venue (spec 02): the door QR names the venue by its slug, and a
-- guest's waitlist link by its token, live until it expires on the app's clock (the simulated one in demos). Each door
-- returns ids only (app_definer already reads venues, 0002).

create or replace function resolve_venue_slug(p_slug text) returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select id from venues where slug = p_slug
$$;
alter function resolve_venue_slug(text) owner to app_definer;
revoke all on function resolve_venue_slug(text) from public;
grant execute on function resolve_venue_slug(text) to app_rw;

create or replace function resolve_waitlist_token(p_hash text, p_now timestamptz)
returns table (venue_id uuid, entry_id uuid)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select venue_id, id from waitlist_entries where link_token_hash = p_hash and link_expires_at > p_now
$$;
alter function resolve_waitlist_token(text, timestamptz) owner to app_definer;
revoke all on function resolve_waitlist_token(text, timestamptz) from public;
grant execute on function resolve_waitlist_token(text, timestamptz) to app_rw;
