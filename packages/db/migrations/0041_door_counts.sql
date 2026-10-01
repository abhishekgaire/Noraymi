-- The door counter (M2-28; spec 04 · door_counts; screens N31): + and − at the
-- front desk, added to the headcount for the business date.
set lock_timeout = '5s';

create table door_counts (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  business_date date not null,
  delta         integer not null check (delta in (-1, 1)),
  counted_by    uuid not null,            -- a user
  device_id     uuid,
  at            timestamptz not null,
  unique (venue_id, id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
create index door_counts_date_idx on door_counts (venue_id, business_date);
alter table door_counts enable row level security;
alter table door_counts force row level security;
create policy venue_isolation on door_counts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on door_counts to app_rw;
select audit_table('door_counts');
