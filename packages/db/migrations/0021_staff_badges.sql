-- M1-25 · NTAG 424 DNA badges.
-- staff_badges (spec 04): one row per tag paired to a membership. The tag's
-- UID is kept hashed with the venue; the keys are never stored, they're
-- worked out from the venue's master key in the key service and key_version.
-- A tap counts only with a valid SUN message and a counter above last_counter.
set lock_timeout = '5s';

create table staff_badges (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  membership_id uuid not null,
  uid_hash      text not null,
  key_version   int not null default 1,
  last_counter  int not null default 0,
  label         text not null default '',
  paired_by     uuid,
  paired_at     timestamptz not null default now(),
  last_tap_at   timestamptz,
  disabled_at   timestamptz,
  unique (venue_id, id),
  unique (venue_id, uid_hash),
  foreign key (venue_id, membership_id) references memberships (venue_id, id)
);
create index staff_badges_membership_idx on staff_badges (venue_id, membership_id) where disabled_at is null;

alter table staff_badges enable row level security;
alter table staff_badges force row level security;
create policy venue_isolation on staff_badges to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on staff_badges to app_rw;
