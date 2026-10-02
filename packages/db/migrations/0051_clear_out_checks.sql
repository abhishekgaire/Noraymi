-- The clear-out check (M3-23; screens N17; Money rules 5): one per business
-- date, raised at the alcohol window's close plus drinking-up time (4:30 AM
-- at West 4), and done when someone has walked every room and the bar.
set lock_timeout = '5s';

create table clear_out_checks (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  business_date  date not null,
  due_at         timestamptz not null,
  done_by        uuid,
  done_at        timestamptz,
  note           text check (note is null or length(note) <= 300),
  unique (venue_id, id),
  unique (venue_id, business_date)
);
alter table clear_out_checks enable row level security;
alter table clear_out_checks force row level security;
create policy venue_isolation on clear_out_checks to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on clear_out_checks to app_rw;
grant update (done_by, done_at, note) on clear_out_checks to app_rw;
select audit_table('clear_out_checks');
