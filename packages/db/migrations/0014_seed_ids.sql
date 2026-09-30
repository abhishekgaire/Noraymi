-- 0014 · seed_ids (docs/demo-seed.md · Loading the seed; M1-17): the demo
-- seed's slugs (west4, maya, dev_tablet_room_4, later room_9) beside the UUIDs
-- the loader gave them, so a test can find a row by the name the seed uses.
-- Only the loader writes it, in staging and local dev; production never has
-- the seed. Not audited: it is not something a person changes.
set lock_timeout = '5s';

create table seed_ids (
  venue_id  uuid not null references venues (id),
  slug      text not null,               -- the seed's id, e.g. "maya" or "dev_router"
  entity    text not null,               -- the table the id points into, e.g. "users"
  row_id    uuid not null,               -- the UUID the loader gave the row
  loaded_at timestamptz not null default now(),
  primary key (venue_id, slug)
);

alter table seed_ids enable row level security;
alter table seed_ids force row level security;
create policy venue_isolation on seed_ids to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on seed_ids to app_rw;
