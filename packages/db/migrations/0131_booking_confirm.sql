-- Confirming a booking (M5-10; Payment flows · Deposit when booking online,
-- steps 3 and 4; Security and data retention 9).
--   * booking_links: more manage links to a booking, each a 128-bit token
--     stored hashed. The Booking confirmed text carries one of its own, made
--     when the text is queued, so the link the guest's browser holds
--     (bookings.manage_token_hash) keeps working alongside it.
--     `resolve_booking_link` finds the venue from either.
--   * refunds.automatic: a refund the system makes by a rule, with no one
--     asking or approving: a payment that landed after its hold lapsed, when
--     the room had gone, is refunded in full (and, in M5-12, a cancel before
--     the refund cut-off).
set lock_timeout = '5s';

create table booking_links (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues (id),
  booking_id uuid not null,
  token_hash text not null unique,
  purpose    text not null check (purpose in ('confirmation')),
  created_at timestamptz not null,
  unique (venue_id, id),
  foreign key (venue_id, booking_id) references bookings (venue_id, id)
);
create index booking_links_booking_idx on booking_links (venue_id, booking_id);
alter table booking_links enable row level security;
alter table booking_links force row level security;
create policy venue_isolation on booking_links to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on booking_links to app_rw;
grant select on booking_links to app_definer;
create policy definer_read on booking_links for select to app_definer using (true);
create policy retention_wall on booking_links to app_retention
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, delete on booking_links to app_retention;
select audit_table('booking_links');
-- A one-venue restore (M8-20) copies it like every venue table.
create policy restore_wall on booking_links to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on booking_links to app_migrator;

create or replace function resolve_booking_link(p_token_hash text) returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select venue_id from bookings where manage_token_hash = p_token_hash
  union all
  select venue_id from booking_links where token_hash = p_token_hash
  limit 1
$$;

alter table refunds add column automatic boolean;            -- true when made by a rule; empty otherwise (append-only)
alter table refunds alter column requested_by drop not null;
alter table refunds add constraint refunds_requested_or_automatic
  check (requested_by is not null or automatic is true) not valid;
alter table refunds validate constraint refunds_requested_or_automatic;
