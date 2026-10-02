-- Alcohol refusals (M3-18, M3-20; spec 04 · alcohol_refusals): a drink that
-- wasn't served or sold, and why: after the alcohol window, cut off, no ID or
-- too drunk. A runner's return for no ID or too drunk is one; so is an order
-- refused by the window or a cut-off (M3-20).
set lock_timeout = '5s';

create table alcohol_refusals (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  session_id     uuid,
  check_id       uuid,
  room_guest_id  uuid,
  order_id       uuid,
  reason         text not null check (reason in ('window_closed', 'cut_off', 'no_id', 'too_drunk')),
  item           text,
  refused_by     uuid,
  at             timestamptz not null,
  business_date  date not null,
  unique (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, room_guest_id) references room_guests (venue_id, id),
  foreign key (venue_id, order_id) references orders (venue_id, id)
);
create index alcohol_refusals_night_idx on alcohol_refusals (venue_id, business_date);
alter table alcohol_refusals enable row level security;
alter table alcohol_refusals force row level security;
create policy venue_isolation on alcohol_refusals to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on alcohol_refusals to app_rw;
select audit_table('alcohol_refusals');
