-- The terms a guest accepts (M5-06; Data model · policy_versions; Payment
-- flows · Deposit when booking online): each save of Admin → Deposits &
-- cancelling writes the words guests read as a new version with its hash.
-- A booking keeps the version it accepted.
set lock_timeout = '5s';

create table policy_versions (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  kind          text not null check (kind in ('deposit')),
  version       int not null check (version >= 1),
  text          text not null check (length(text) between 1 and 5000),
  hash          text not null check (hash ~ '^[0-9a-f]{64}$'),
  published_at  timestamptz not null,
  published_by  uuid,
  unique (venue_id, id),
  unique (venue_id, kind, version)
);
alter table policy_versions enable row level security;
alter table policy_versions force row level security;
create policy venue_isolation on policy_versions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
-- Published terms never change: a new version is a new row.
grant select, insert on policy_versions to app_rw;
select audit_table('policy_versions');

-- bookings.policy_version_id has waited for this table since 0029.
alter table bookings add constraint bookings_policy_version_fk
  foreign key (venue_id, policy_version_id) references policy_versions (venue_id, id) not valid;
alter table bookings validate constraint bookings_policy_version_fk;
