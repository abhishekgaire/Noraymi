-- Shifts (M7-01; Data model · shifts): one row per clock-in to clock-out,
-- rebuilt from time_punches (0078) in the same transaction as each punch.
-- A person has one open shift. The manager on duty becomes the open
-- Manager-duty shift, so the duty_managers stand-in (0035) goes.
set lock_timeout = '5s';

-- A clock-in always carries its duty (the tip pool uses it).
alter table time_punches
  add constraint time_punches_clock_in_duty check (kind <> 'clock_in' or duty is not null) not valid;
alter table time_punches validate constraint time_punches_clock_in_duty;

create table shifts (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues (id),
  membership_id     uuid not null,
  clock_in_punch_id uuid not null,
  business_date     date not null,
  duty              text not null check (duty in ('bar', 'front_desk', 'runner', 'manager')),
  started_at        timestamptz not null,
  ended_at          timestamptz,
  break_minutes     integer not null default 0 check (break_minutes >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, clock_in_punch_id),
  foreign key (venue_id, membership_id) references memberships (venue_id, id),
  foreign key (venue_id, clock_in_punch_id) references time_punches (venue_id, id),
  check (ended_at is null or ended_at >= started_at)
);
create unique index shifts_one_open on shifts (venue_id, membership_id) where ended_at is null;
create index shifts_by_date on shifts (venue_id, business_date);
alter table shifts enable row level security;
alter table shifts force row level security;
create policy venue_isolation on shifts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update (business_date, duty, started_at, ended_at, break_minutes, updated_at)
  on shifts to app_rw;
select audit_table('shifts');

drop table duty_managers;
