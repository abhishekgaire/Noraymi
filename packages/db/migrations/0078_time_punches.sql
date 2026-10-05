-- Time punches (Data model · time_punches): clock in, clock out and breaks.
-- The time clock that writes them ships in M7; the bar POS reads an open
-- break from M6-04 ("Maya · on break"), so the table lands now.
set lock_timeout = '5s';

create table time_punches (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  membership_id uuid not null,
  kind          text not null check (kind in ('clock_in', 'clock_out', 'break_start', 'break_end')),
  duty          text check (duty in ('bar', 'front_desk', 'runner', 'manager')),
  at            timestamptz not null,
  device_id     uuid,
  edited_by     uuid,
  reason        text check (reason is null or length(reason) between 1 and 300),
  created_at    timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, membership_id) references memberships (venue_id, id),
  check (edited_by is null or reason is not null)
);
create index time_punches_by_person on time_punches (venue_id, membership_id, at desc);
alter table time_punches enable row level security;
alter table time_punches force row level security;
create policy venue_isolation on time_punches to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update (at, kind, duty, edited_by, reason) on time_punches to app_rw;
select audit_table('time_punches');
