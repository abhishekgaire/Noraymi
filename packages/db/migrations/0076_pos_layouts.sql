-- Bar POS layouts (M6-01; Data model · pos_layouts; Staff screens and the bar
-- POS · rule 2): fixed button positions per station. Admin saves one draft per
-- station; publishing makes it the next version, which starts at the next
-- business date (pos.layouts names the version in force), so nothing moves
-- mid-shift.
set lock_timeout = '5s';

create table pos_layouts (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  station       text not null check (station ~ '^[a-z][a-z0-9_]{0,31}$'),
  version       int check (version >= 1),
  status        text not null check (status in ('draft', 'published')),
  sections      jsonb not null,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  published_by  uuid,
  published_at  timestamptz,
  starts_on     date,
  unique (venue_id, id),
  unique (venue_id, station, version),
  check ((status = 'published') = (version is not null and published_at is not null and starts_on is not null))
);
create unique index pos_layouts_one_draft on pos_layouts (venue_id, station) where status = 'draft';
alter table pos_layouts enable row level security;
alter table pos_layouts force row level security;
create policy venue_isolation on pos_layouts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on pos_layouts to app_rw;
grant update (status, sections, version, published_by, published_at, starts_on) on pos_layouts to app_rw;
select audit_table('pos_layouts');
