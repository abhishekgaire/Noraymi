-- Importing a venue's records from the files its old system exports (M9-01;
-- milestones · M9 Ships, Imports; spec 13 · Releases). The import tool reads
-- the files West 4 hands us through a versioned mapping, and loads them as
-- the audited migration role (app_migrator), walled to one venue by the
-- restore_wall policies 0122 put on every venue table:
--   * import_runs: one row per run (dry run or live), with the files' hashes,
--     the mapping's version and the reconciliation report;
--   * import_refs: which of our rows each legacy record became, so a second
--     run of the same file (the cutover delta) adds only what is new;
--   * every row a run loads is audited with app.request_id = 'import:<run id>'.
-- No PIN and no card number is ever imported: the tool refuses such a file
-- before anything loads, and no column here can hold one.
set lock_timeout = '5s';

create table import_runs (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues (id),
  mode             text not null check (mode in ('dry_run', 'live')),
  state            text not null default 'running' check (state in ('running', 'done', 'failed')),
  mapping_source   text not null,
  mapping_version  integer not null check (mapping_version >= 1),
  files            jsonb not null default '[]'::jsonb,
  report           jsonb,
  failure          text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  unique (venue_id, id)
);
alter table import_runs enable row level security;
alter table import_runs force row level security;
create policy venue_isolation on import_runs to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy restore_wall on import_runs to app_migrator
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on import_runs to app_rw;
grant select, insert, update on import_runs to app_migrator;
select audit_table('import_runs');

create table import_refs (
  venue_id      uuid not null references venues (id),
  kind          text not null check (kind in (
                  'guest', 'booking', 'consent', 'menu_category', 'menu_item', 'person', 'nightly_total')),
  legacy_ref    text not null check (length(legacy_ref) between 1 and 200),
  target_table  text not null,
  target_id     text not null,
  row_hash      text not null,
  run_id        uuid not null,
  created_at    timestamptz not null default now(),
  primary key (venue_id, kind, legacy_ref),
  foreign key (venue_id, run_id) references import_runs (venue_id, id)
);
alter table import_refs enable row level security;
alter table import_refs force row level security;
create policy venue_isolation on import_refs to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy restore_wall on import_refs to app_migrator
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on import_refs to app_rw;
grant select, insert on import_refs to app_migrator;
select audit_table('import_refs');

-- Imported people become users with an invited membership (never a PIN);
-- 0015 gave app_migrator select and update on users, the import adds insert.
grant insert on users to app_migrator;
