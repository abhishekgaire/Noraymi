-- Kitchen screen (P-17; D131; module kitchen_screen, off by default). A paired kitchen display
-- (devices.kind kitchen_display) or a bar computer's second window shows the night's open kitchen
-- tickets, oldest first; Done bumps one and tells the bar. Each kitchen ticket (a guest's food at
-- Accept, staff-rung food at Send to kitchen, a remake) is a row here while the module is on, with
-- the same content as its printed ticket. The printer keeps printing unless the venue turns it off
-- (kitchenScreen.print), so print_job_id is empty only then. No prices: money never lives here.
set lock_timeout = '5s';

alter table devices drop constraint devices_kind_check;
alter table devices add constraint devices_kind_check
  check (kind in ('bar_computer', 'front_desk', 'room_tablet', 'reader', 'printer', 'nfc_reader', 'router',
                  'staff_phone', 'up_next_display', 'mic_outlet', 'kitchen_display')) not valid;
alter table devices validate constraint devices_kind_check;

create table kitchen_tickets (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  -- A guest's food order (or a remake) names its order; staff-rung food sent from a check names the check.
  order_id       uuid,
  check_id       uuid,
  print_job_id   uuid,
  business_date  date not null,
  -- The ticket as it prints (spec 16 · Kitchen tickets): the room or tab, who and when, the lines with
  -- their options and notes, an allergy flagged. No prices.
  payload        jsonb not null,
  training       boolean not null default false,
  created_at     timestamptz not null,
  done_at        timestamptz,
  -- Who tapped Done: the kitchen display or bar computer, and the person when one was signed in.
  done_device_id uuid,
  done_by        uuid references users (id),
  check ((order_id is null) <> (check_id is null)),
  check (done_at is not null or (done_device_id is null and done_by is null)),
  unique (venue_id, id),
  foreign key (venue_id, order_id) references orders (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, print_job_id) references print_jobs (venue_id, id),
  foreign key (venue_id, done_device_id) references devices (venue_id, id)
);
create index kitchen_tickets_open_idx on kitchen_tickets (venue_id, created_at) where done_at is null;
create index kitchen_tickets_date_idx on kitchen_tickets (venue_id, business_date);
create trigger closed_night_guard before insert or update of business_date on kitchen_tickets
  for each row execute function refuse_closed_night();
alter table kitchen_tickets enable row level security;
alter table kitchen_tickets force row level security;
create policy venue_isolation on kitchen_tickets to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on kitchen_tickets to app_rw;
grant update (done_at, done_device_id, done_by) on kitchen_tickets to app_rw;
create policy restore_wall on kitchen_tickets to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on kitchen_tickets to app_migrator;
select audit_table('kitchen_tickets');
