-- The public forms' daily limits (M2-27, D109; Security and data retention 8).
-- Every accepted use of a public form writes one row: a waitlist join from the
-- door QR, a phone code sent (a staff invite or a singer), and with M5-05 a
-- booking hold and a private-party enquiry. The limits count a business
-- date's rows per phone number, IP address and device, so a new business date
-- starts from nothing. The phone number, the IP address and the device are
-- kept only as keyed hashes (HMAC with the server's secret), never as they
-- came, and a row is deleted by the nightly retention job (M8-12) after a week.
set lock_timeout = '5s';

create table public_form_uses (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  form           text not null check (form in ('waitlist', 'phone_code', 'booking', 'enquiry')),
  -- The business date a use counts on. Not named business_date: it records no sale, so a closed
  -- night's guard (M7-12) doesn't apply, and the door QR keeps working between a close and the cutover.
  counted_on     date not null,
  phone_hash     text check (char_length(phone_hash) = 64),
  ip_hash        text check (char_length(ip_hash) = 64),
  device_hash    text check (char_length(device_hash) = 64),
  -- What the use made, where one form fills in over two steps (a booking's hold, then its details).
  subject_id     uuid,
  created_at     timestamptz not null default now(),
  unique (venue_id, id)
);
create index public_form_uses_day on public_form_uses (venue_id, form, counted_on);
alter table public_form_uses enable row level security;
alter table public_form_uses force row level security;
create policy venue_isolation on public_form_uses to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on public_form_uses to app_rw;
grant update (phone_hash) on public_form_uses to app_rw;
-- No audit_table('public_form_uses'): a counter of hashes, like the telemetry tables.
create policy retention_wall on public_form_uses to app_retention
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, delete on public_form_uses to app_retention;
-- A one-venue restore (M8-20) copies it like every venue table.
create policy restore_wall on public_form_uses to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on public_form_uses to app_migrator;
