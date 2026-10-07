-- The license register (M8-09; spec 04 · licenses; spec 08 · Safety; screens N35).
-- Liquor, music (ASCAP, BMI, SESAC, GMR), local and health licenses, each with
-- its number, holder, the agency that issued it, its dates, fee, conditions and
-- a copy (a license_copy file). Every field but the kind may stay empty: the
-- owner enters them from the paper license, and nothing is made up for a venue.
-- A daily job reminds the owner and managers 60, 30 and 7 days before
-- expires_on; reminded_days is the smallest of those windows already sent, so
-- each reminder goes once, and a new expiry starts them over.
set lock_timeout = '5s';

create table licenses (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  kind           text not null check (kind in ('liquor', 'ascap', 'bmi', 'sesac', 'gmr', 'local', 'health', 'other')),
  number         text check (length(number) <= 100),
  holder         text check (length(holder) <= 200),
  authority      text check (length(authority) <= 200),
  starts_on      date,
  expires_on     date,
  fee_cents      integer check (fee_cents >= 0),
  conditions     text check (length(conditions) <= 2000),
  file_id        uuid,
  reminded_at    timestamptz,
  reminded_days  smallint check (reminded_days in (60, 30, 7)),
  created_by     uuid,
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  unique (venue_id, id),
  foreign key (venue_id, file_id) references files (venue_id, id),
  check (starts_on is null or expires_on is null or starts_on <= expires_on),
  check ((reminded_at is null) = (reminded_days is null))
);
create index licenses_expires_idx on licenses (venue_id, expires_on);
alter table licenses enable row level security;
alter table licenses force row level security;
create policy venue_isolation on licenses to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on licenses to app_rw;
grant update (number, holder, authority, starts_on, expires_on, fee_cents, conditions, file_id,
              reminded_at, reminded_days, updated_at) on licenses to app_rw;
select audit_table('licenses');
