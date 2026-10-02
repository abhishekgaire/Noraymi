-- Cash drawers (M4-10; Data model · cash_drawers, drawer_sessions; Devices,
-- printing and offline · Cash drawers at West 4): a drawer on a receipt
-- printer's kick port, and its sessions. West 4 runs two house drawers (the
-- bar's and the front desk's), each with one open session that the manager on
-- duty answers for. Drawer moves, counts and the per-person model come with
-- M4-13 and M7.
set lock_timeout = '5s';

create table cash_drawers (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues (id),
  name              text not null,
  station           text check (station in ('bar', 'front_desk')),
  printer_device_id uuid,
  unique (venue_id, id),
  foreign key (venue_id, printer_device_id) references devices (venue_id, id)
);
alter table cash_drawers enable row level security;
alter table cash_drawers force row level security;
create policy venue_isolation on cash_drawers to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on cash_drawers to app_rw;
select audit_table('cash_drawers');

create table drawer_sessions (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues (id),
  drawer_id        uuid not null,
  model            text not null check (model in ('house', 'per_person')),
  owner_id         uuid,
  responsible_id   uuid,
  tray_label       text,
  state            text not null default 'open' check (state in ('open', 'pulled', 'counted', 'closed')),
  business_date    date not null,
  opened_at        timestamptz not null,
  opening_cents    bigint not null check (opening_cents >= 0),
  pulled_at        timestamptz,
  counted_at       timestamptz,
  counted_by       uuid,
  witness_id       uuid,
  counted_cents    bigint,
  expected_cents   bigint,
  over_short_cents bigint,
  note             text,
  approved_by      uuid,
  closed_at        timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, drawer_id) references cash_drawers (venue_id, id)
);
-- one open session per drawer
create unique index drawer_sessions_one_open on drawer_sessions (venue_id, drawer_id) where state = 'open';
alter table drawer_sessions enable row level security;
alter table drawer_sessions force row level security;
create policy venue_isolation on drawer_sessions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on drawer_sessions to app_rw;
grant update (state, pulled_at, counted_at, counted_by, witness_id, counted_cents, expected_cents, over_short_cents,
  note, approved_by, closed_at, responsible_id) on drawer_sessions to app_rw;
select audit_table('drawer_sessions');

alter table devices add constraint devices_cash_drawer_fk
  foreign key (venue_id, cash_drawer_id) references cash_drawers (venue_id, id) not valid;
alter table devices validate constraint devices_cash_drawer_fk;
