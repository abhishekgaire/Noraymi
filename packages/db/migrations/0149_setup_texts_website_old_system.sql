-- Set up your venue's steps 10 and 11 (O-12; spec 17 · Step details 10 and 11).
--   * text_registrations: Register for texts. The 10DLC brand details the owner typed (legal name,
--     address, business type, the authorized representative, the sample messages) and the Twilio
--     ids it got back, so our team can follow the brand and make the campaign. The EIN is sent to
--     Twilio once and is never stored: there is no column for it, here or anywhere. One live
--     registration per venue (the partial unique index); a failed one can be sent again.
--   * setup_requests grows two kinds: 'website' (the answer to "Do you have a website and domain
--     to move?"; a yes starts M9-09's move with our team) and 'old_system' (an export file from the
--     old system, kind import_export, that our team runs through the importer as a dry run the
--     owner signs; nothing is imported from the upload itself).
set lock_timeout = '5s';

alter table files drop constraint files_kind_check;
alter table files add constraint files_kind_check
  check (kind in ('damage_photo', 'slip_photo', 'paid_out_photo', 'lost_item_photo', 'license_copy', 'songbook',
                  'dispute_evidence', 'menu_pdf', 'receipt_pdf', 'site_photo', 'menu_source', 'import_export')) not valid;
alter table files validate constraint files_kind_check;

alter table setup_requests drop constraint setup_requests_kind_check;
alter table setup_requests add constraint setup_requests_kind_check
  check (kind in ('menu', 'website', 'old_system')) not valid;
alter table setup_requests validate constraint setup_requests_kind_check;
-- The website question's answer: yes (a site and domain to move) or no.
alter table setup_requests add column answer text check (answer is null or answer in ('yes', 'no'));
alter table setup_requests add constraint setup_requests_answer_kind
  check ((kind = 'website') = (answer is not null)) not valid;
alter table setup_requests validate constraint setup_requests_answer_kind;

create table text_registrations (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid not null references venues (id),
  state                text not null default 'sending' check (state in ('sending', 'submitted', 'failed')),
  legal_name           text not null check (char_length(legal_name) between 1 and 200),
  business_type        text not null check (business_type in (
                         'Sole Proprietorship', 'Partnership', 'Limited Liability Corporation',
                         'Co-operative', 'Non-profit Corporation', 'Corporation')),
  website_url          text not null check (char_length(website_url) between 8 and 300),
  street               text not null check (char_length(street) between 1 and 200),
  city                 text not null check (char_length(city) between 1 and 100),
  region               text not null check (region ~ '^[A-Z]{2}$'),
  postal_code          text not null check (postal_code ~ '^[0-9]{5}$'),
  rep_first_name       text not null check (char_length(rep_first_name) between 1 and 80),
  rep_last_name        text not null check (char_length(rep_last_name) between 1 and 80),
  rep_email            text not null check (char_length(rep_email) between 3 and 254),
  rep_phone            text not null check (rep_phone ~ '^\+1[2-9][0-9]{9}$'),
  rep_title            text not null check (char_length(rep_title) between 1 and 80),
  rep_position         text not null check (rep_position in (
                         'Director', 'GM', 'VP', 'CEO', 'CFO', 'General Counsel', 'Other')),
  sample_1             text not null check (char_length(sample_1) between 20 and 1024),
  sample_2             text not null check (char_length(sample_2) between 20 and 1024),
  customer_profile_sid text,
  trust_product_sid    text,
  brand_sid            text,
  -- What went wrong, in our words (never Twilio's response body, which could echo what was sent).
  failure              text check (failure is null or char_length(failure) <= 200),
  submitted_by         uuid not null references users (id),
  created_at           timestamptz not null default now(),
  submitted_at         timestamptz,
  check ((state = 'submitted') = (brand_sid is not null)),
  unique (venue_id, id)
);
create unique index text_registrations_live_idx on text_registrations (venue_id)
  where state in ('sending', 'submitted');
alter table text_registrations enable row level security;
alter table text_registrations force row level security;
create policy venue_isolation on text_registrations to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on text_registrations to app_rw;
grant update (state, customer_profile_sid, trust_product_sid, brand_sid, failure, submitted_at)
  on text_registrations to app_rw;
-- A one-venue restore (M8-20) copies it like every venue table.
create policy restore_wall on text_registrations to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on text_registrations to app_migrator;
select audit_table('text_registrations');
