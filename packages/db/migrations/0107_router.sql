-- The router as a device (M8-02; spec 09 · Router, spec 01 · When the
-- venue's internet drops): how the server reads the venue's dual-WAN router,
-- and the monthly failover test's results. The reading itself is the
-- router's heartbeat row (network: cellular_backup, on_backup_now, source),
-- never audited, like every heartbeat.
set lock_timeout = '5s';

-- One row per router device: the maker's cloud API it's read through (only a
-- documented one), and the network owners the fallback tells apart. Ids, not
-- secrets: the API credentials come from the environment.
create table router_links (
  device_id        uuid primary key,
  venue_id         uuid not null references venues (id),
  maker            text check (maker in ('peplink')),
  maker_org_id     text check (char_length(maker_org_id) <= 100),
  maker_device_id  text check (char_length(maker_device_id) <= 100),
  api_on           boolean not null default true,
  -- The fallback: the owner of the bar computer's public IP names the line or the LTE carrier.
  wired_owner      text check (char_length(wired_owner) <= 100),
  lte_owner        text check (char_length(lte_owner) <= 100),
  updated_at       timestamptz not null default now(),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
alter table router_links enable row level security;
alter table router_links force row level security;
create policy venue_isolation on router_links to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on router_links to app_rw;
select audit_table('router_links');

-- The monthly failover test: unplug the wired line, see the venue move to LTE, plug it back.
create table router_failover_tests (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  device_id       uuid not null,
  tested_at       timestamptz not null,       -- the venue's clock
  tested_on       date not null,             -- the business date it ran on (not money: no closed-night guard)
  passed          boolean not null,
  switch_seconds  integer check (switch_seconds >= 0 and switch_seconds <= 86400),
  recorded_by     uuid references users (id),
  created_at      timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
create index router_failover_tests_device on router_failover_tests (venue_id, device_id, tested_at desc);
alter table router_failover_tests enable row level security;
alter table router_failover_tests force row level security;
create policy venue_isolation on router_failover_tests to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on router_failover_tests to app_rw;
select audit_table('router_failover_tests');
