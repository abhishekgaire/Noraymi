set lock_timeout = '5s';
create table check_lines (
  id       bigint generated always as identity primary key,
  venue_id uuid not null,
  check_id uuid not null references checks (id),
  unique (venue_id, id)
);
alter table check_lines enable row level security, force row level security;
create policy venue_isolation on check_lines using (venue_id = current_setting('app.venue_id')::uuid);
