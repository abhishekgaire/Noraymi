set lock_timeout = '5s';
-- enabled but not forced, and no unique (venue_id, id)
create table checks (
  id       uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues (id)
);
alter table checks enable row level security;
create policy venue_isolation on checks using (venue_id = current_setting('app.venue_id')::uuid);
