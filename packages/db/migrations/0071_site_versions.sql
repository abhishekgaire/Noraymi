-- The guest site's words, photos and sections (M5-01; Settings · one place for
-- each fact; Data model · site_versions). The builder saves into one draft;
-- Publish makes it live; every published version is kept. The site renders the
-- newest published version. Live facts (hours, prices, menu, phone) never live
-- here; they come from their own place.
set lock_timeout = '5s';

create table site_versions (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  version       int not null check (version >= 1),
  status        text not null check (status in ('draft', 'published')),
  content       jsonb not null,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  published_at  timestamptz,
  published_by  uuid,
  unique (venue_id, id),
  unique (venue_id, version),
  check ((status = 'published') = (published_at is not null))
);
create unique index site_versions_one_draft on site_versions (venue_id) where status = 'draft';
alter table site_versions enable row level security;
alter table site_versions force row level security;
create policy venue_isolation on site_versions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on site_versions to app_rw;
grant update (status, content, published_at, published_by) on site_versions to app_rw;
select audit_table('site_versions');
