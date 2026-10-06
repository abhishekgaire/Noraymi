-- The songbook (M6-23; Song systems and texts · Songbook; Data model · song_catalog; D63): the songs
-- a venue's singers and its website can search. Loaded from the KJ's songbook CSV (title, artist,
-- code) uploaded in Admin → Bar mode, which replaces the last upload, or later from a song vendor's
-- own file under its written agreement. Never scraped. Search reads one lower-cased text of title and
-- artist through a trigram index, so "brightside" finds "Mr. Brightside". The app never deletes, so a
-- new upload marks the songs it replaces (replaced_at) and search reads only the current ones.
set lock_timeout = '5s';

create extension if not exists pg_trgm;

create table song_catalog (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  vendor          text not null default 'songbook' check (vendor in ('songbook')),
  vendor_code     text check (length(vendor_code) <= 40),
  title           text not null check (length(title) between 1 and 120),
  artist          text check (length(artist) <= 120),
  language        text check (length(language) <= 20),
  source_file_id  uuid not null,
  loaded_at       timestamptz not null,
  replaced_at     timestamptz,
  search          text generated always as (lower(title || ' ' || coalesce(artist, ''))) stored,
  unique (venue_id, id),
  foreign key (venue_id, source_file_id) references files (venue_id, id)
);
create index song_catalog_current on song_catalog (venue_id, vendor) where replaced_at is null;
create index song_catalog_search on song_catalog using gin (search gin_trgm_ops) where replaced_at is null;

alter table song_catalog enable row level security;
alter table song_catalog force row level security;
create policy venue_isolation on song_catalog to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update (replaced_at) on song_catalog to app_rw;
