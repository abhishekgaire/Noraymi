-- Room notes and lost and found (M2-19; spec 04 · room_notes, lost_items;
-- screens N15). Notes stay with the room; the lost-and-found log reads "Found
-- in Room 9 · kept at the bar · claimed by …", with a photo where staff take one.
set lock_timeout = '5s';

create table room_notes (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues (id),
  room_id     uuid not null,
  text        text not null check (length(text) between 1 and 500),
  added_by    uuid,                       -- a user; empty for notes carried over from before (the seed's)
  added_at    timestamptz not null,
  cleared_at  timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id)
);
create index room_notes_room_idx on room_notes (venue_id, room_id) where cleared_at is null;
alter table room_notes enable row level security;
alter table room_notes force row level security;
create policy venue_isolation on room_notes to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on room_notes to app_rw;
grant update (cleared_at) on room_notes to app_rw;
select audit_table('room_notes');

create table lost_items (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues (id),
  room_id          uuid,                    -- empty for something found at the bar
  session_id       uuid,
  description      text not null check (length(description) between 1 and 300),
  photo_file_id    uuid,
  found_by         uuid not null,           -- a user
  found_at         timestamptz not null,
  kept_at          text not null check (length(kept_at) between 1 and 100),
  claimed_by_name  text check (claimed_by_name is null or length(claimed_by_name) between 1 and 100),
  claimed_at       timestamptz,
  handed_over_by   uuid,
  disposed_at      timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, photo_file_id) references files (venue_id, id),
  check ((claimed_at is null) = (claimed_by_name is null)),
  check (claimed_at is null or handed_over_by is not null)
);
create index lost_items_open_idx on lost_items (venue_id, found_at) where claimed_at is null and disposed_at is null;
alter table lost_items enable row level security;
alter table lost_items force row level security;
create policy venue_isolation on lost_items to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on lost_items to app_rw;
grant update (kept_at, claimed_by_name, claimed_at, handed_over_by, disposed_at) on lost_items to app_rw;
select audit_table('lost_items');
