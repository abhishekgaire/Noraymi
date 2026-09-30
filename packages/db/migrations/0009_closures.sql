-- 0009 · closures (spec 03 · One place for each fact; spec 04 · closures;
-- M1-12): special dates and closed dates in one list, keyed by business date.
set lock_timeout = '5s';

create table closures (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues (id),
  date       date not null,                       -- the business date
  kind       text not null check (kind in ('closed', 'special')),
  opens      time,                                -- special: the wall-clock opening for that date
  closes     time,                                -- special: the wall-clock close (before the cutover = the next calendar day)
  note       text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, date),
  check (kind = 'closed' or opens is not null or closes is not null)
);

alter table closures enable row level security;
alter table closures force row level security;
create policy venue_isolation on closures to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on closures to app_rw;

select audit_table('closures');
