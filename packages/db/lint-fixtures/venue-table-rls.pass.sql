set lock_timeout = '5s';
create table checks (
  id       uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues (id),
  number   bigint not null,
  unique (venue_id, id)
);
alter table checks enable row level security;
alter table checks force row level security;
create policy venue_isolation on checks
  using (venue_id = current_setting('app.venue_id')::uuid)
  with check (venue_id = current_setting('app.venue_id')::uuid);

-- no id column, so no unique (venue_id, id) is expected
create table room_blocks (
  venue_id uuid not null,
  room_id  uuid not null,
  period   tstzrange not null,
  exclude using gist (venue_id with =, room_id with =, period with &&)
);
alter table room_blocks enable row level security, force row level security;
create policy venue_isolation on room_blocks using (venue_id = current_setting('app.venue_id')::uuid);
