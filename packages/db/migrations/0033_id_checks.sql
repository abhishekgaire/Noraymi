-- M2-12 · ID checks (spec 04 · id_checks; spec 12 · 6). One row per person
-- checked: visual (who checked and when) or a scan, whose four fields are
-- encrypted with a key for the venue and the business date. Neither table is
-- ever in the org-wide read scope or any export.
set lock_timeout = '5s';

create table id_scan_keys (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  business_date date not null,
  wrapped_key   text,                -- the night's data key, wrapped by the key service; null once destroyed (M8)
  destroyed_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, business_date)
);
alter table id_scan_keys enable row level security;
alter table id_scan_keys force row level security;
create policy venue_isolation on id_scan_keys to app_rw
  using (case when app_org_scope() then false else venue_id = app_venue_id() end)
  with check (venue_id = app_venue_id());
grant select, insert on id_scan_keys to app_rw;

create table id_checks (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  session_id     uuid,
  check_id       uuid,
  order_id       uuid,                 -- M3: the runner's check at the room
  checked_by     uuid not null,
  checked_at     timestamptz not null,
  method         text not null check (method in ('visual', 'scan')),
  scanned_fields text,                 -- a scan's four fields, sealed with the night's key
  key_id         uuid,
  delete_after   date,
  unique (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, key_id) references id_scan_keys (venue_id, id),
  check (session_id is not null or check_id is not null),
  check (method = 'visual' and scanned_fields is null and key_id is null
      or method = 'scan' and scanned_fields is not null and key_id is not null and delete_after is not null)
);
create index id_checks_session_idx on id_checks (venue_id, session_id);
alter table id_checks enable row level security;
alter table id_checks force row level security;
create policy venue_isolation on id_checks to app_rw
  using (case when app_org_scope() then false else venue_id = app_venue_id() end)
  with check (venue_id = app_venue_id());
grant select, insert on id_checks to app_rw;
