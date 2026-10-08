-- Imported future bookings with their deposits (M9-02; spec 04 · bookings,
-- Room assignment, policy_versions, the money core; Money rules 11 and 16).
--   * The terms a guest accepted on the old site are kept as policy_versions
--     of kind 'imported_terms' (text and hash), never as the venue's own
--     deposit policy.
--   * Each deposit paid through the old system is an `external` payment of
--     the booking, captured, recorded with source 'import'; check-in applies
--     it like any deposit. It enters customer deposits through the run's
--     opening journal (import_runs.opening_journal), not a night's.
--   * A booking that fits no room is kept on the manager's list
--     (import_unplaced), never dropped.
set lock_timeout = '5s';

alter table policy_versions drop constraint policy_versions_kind_check;
alter table policy_versions add constraint policy_versions_kind_check
  check (kind in ('deposit', 'tab_consent', 'room_card_consent', 'imported_terms')) not valid;
alter table policy_versions validate constraint policy_versions_kind_check;

alter table payment_events drop constraint payment_events_source_check;
alter table payment_events add constraint payment_events_source_check
  check (source in ('api', 'webhook', 'reconciler', 'import')) not valid;
alter table payment_events validate constraint payment_events_source_check;

alter table import_refs drop constraint import_refs_kind_check;
alter table import_refs add constraint import_refs_kind_check
  check (kind in ('guest', 'booking', 'consent', 'menu_category', 'menu_item', 'person', 'nightly_total',
                  'policy')) not valid;
alter table import_refs validate constraint import_refs_kind_check;

alter table import_runs add column cutover_date date;
alter table import_runs add column opening_journal jsonb;

create table import_unplaced (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid not null references venues (id),
  run_id               uuid not null,
  legacy_ref           text not null,
  guest_id             uuid not null,
  room_named           text not null,
  party_size           integer not null check (party_size >= 1),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  business_date        date not null,
  deposit_legacy_cents integer not null default 0 check (deposit_legacy_cents >= 0),
  reason               text not null check (reason in ('no_room')),
  created_at           timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, legacy_ref),
  foreign key (venue_id, run_id) references import_runs (venue_id, id),
  foreign key (venue_id, guest_id) references guests (venue_id, id),
  check (ends_at > starts_at)
);
alter table import_unplaced enable row level security;
alter table import_unplaced force row level security;
create policy venue_isolation on import_unplaced to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy restore_wall on import_unplaced to app_migrator
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on import_unplaced to app_rw;
grant select, insert on import_unplaced to app_migrator;
select audit_table('import_unplaced');
create trigger closed_night_guard before insert or update of business_date on import_unplaced
  for each row execute function refuse_closed_night();
