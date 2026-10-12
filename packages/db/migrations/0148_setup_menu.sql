-- Set up your venue's step 8, the menu (O-10; spec 17 · Step details 8). Three ways in:
--   * typed in Admin → Menu's editor (nothing new here);
--   * a spreadsheet in the importer's menu format (M9-04), run through the importer from the API
--     as the owner, as a dry run first and then for real on "Looks right". The run is an
--     import_runs row with its import_refs like any other, written as app_rw walled to the venue
--     (the venue_isolation policies 0125 already gave both tables), so a second upload of the
--     same file adds only what's new. Only the menu kinds go this way; the rest stay with our team;
--   * a PDF or a photo for our team to type in: a setup_requests row the Console lists. Nothing
--     is read from the file automatically, and nothing reaches the menu until our team types it.
set lock_timeout = '5s';

grant insert, update on import_runs to app_rw;
grant insert on import_refs to app_rw;

alter table files drop constraint files_kind_check;
alter table files add constraint files_kind_check
  check (kind in ('damage_photo', 'slip_photo', 'paid_out_photo', 'lost_item_photo', 'license_copy', 'songbook',
                  'dispute_evidence', 'menu_pdf', 'receipt_pdf', 'site_photo', 'menu_source')) not valid;
alter table files validate constraint files_kind_check;

create table setup_requests (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  kind          text not null check (kind in ('menu')),
  file_id       uuid,
  note          text check (note is null or char_length(note) between 1 and 500),
  state         text not null default 'open' check (state in ('open', 'done')),
  requested_by  uuid not null references users (id),
  requested_at  timestamptz not null default now(),
  -- Our staff member who finished it (console_staff), and when.
  done_by       uuid,
  done_at       timestamptz,
  check ((state = 'done') = (done_at is not null)),
  unique (venue_id, id),
  foreign key (venue_id, file_id) references files (venue_id, id)
);
create index setup_requests_open_idx on setup_requests (venue_id, requested_at) where state = 'open';
alter table setup_requests enable row level security;
alter table setup_requests force row level security;
create policy venue_isolation on setup_requests to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on setup_requests to app_rw;
grant update (state, done_by, done_at) on setup_requests to app_rw;
select audit_table('setup_requests');
-- A one-venue restore (M8-20) copies it like every venue table.
create policy restore_wall on setup_requests to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on setup_requests to app_migrator;
-- 0143 and 0147 left three venue tables without their restore wall, so a one-venue restore
-- (M8-20) refused to start; each gets the wall and the grants every venue table has.
create policy restore_wall on venue_onboarding to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on venue_onboarding to app_migrator;
create policy restore_wall on venue_setup_skips to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on venue_setup_skips to app_migrator;
create policy restore_wall on check_held_cards to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on check_held_cards to app_migrator;
