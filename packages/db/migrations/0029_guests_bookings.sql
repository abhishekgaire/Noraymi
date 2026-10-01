-- M2-06 · Guests and bookings (spec 04). Guests are per venue and never
-- shared; their contact fields are redacted in the audit log. Every booking
-- has a real room; its block lives in room_blocks (M2-05), kind 'hold' while
-- it waits for a deposit and 'booking' once confirmed.
set lock_timeout = '5s';

create table guests (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues (id),
  name         text not null,
  phone_e164   text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email        text,
  locale       text not null default 'en' check (locale in ('en', 'es')),
  last_seen_at timestamptz,
  erased_at    timestamptz,
  created_at   timestamptz not null default now(),
  unique (venue_id, id)
);
create index guests_phone_idx on guests (venue_id, phone_e164);
alter table guests enable row level security;
alter table guests force row level security;
create policy venue_isolation on guests to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on guests to app_rw;
select audit_table('guests');
-- The redaction list is configuration the audited migration role writes (as in 0015).
grant insert on audit_redactions to app_migrator;
set role app_migrator;
insert into audit_redactions values ('guests', 'phone_e164'), ('guests', 'email');
reset role;

create table bookings (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid not null references venues (id),
  guest_id             uuid not null,
  room_id              uuid not null,
  size_tier            text not null,
  party_size           integer not null check (party_size >= 1),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  business_date        date not null,
  status               text not null check (status in ('pending', 'confirmed', 'checked_in', 'no_show', 'cancelled', 'completed')),
  source               text not null check (source in ('web', 'staff', 'import')),
  booked_by            uuid,                 -- K9: the staff host or sales manager credited; empty at West 4
  policy_version_id    uuid,                 -- M5: the policy the guest accepted
  deposit_cents        integer not null default 0 check (deposit_cents >= 0),
  accepted_at          timestamptz,
  accepted_ip          inet,
  accepted_ua          text,
  payment_method_id    text,                 -- M4/M5: the saved card, a Stripe id
  refund_cutoff_at     timestamptz,
  cancelled_by         uuid,
  running_late_until   timestamptz,
  private_function     boolean not null default false,
  legacy_ref           text,                 -- M9: the old system's reference
  deposit_legacy_cents integer,
  pending_until        timestamptz,          -- an unpaid booking lapses here; set when M5 sends the link
  manage_token_hash    text unique,          -- M5: the guest's manage link
  created_at           timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, guest_id) references guests (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id),
  check (ends_at > starts_at)
);
create index bookings_date_idx on bookings (venue_id, business_date);
alter table bookings enable row level security;
alter table bookings force row level security;
create policy venue_isolation on bookings to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on bookings to app_rw;
select audit_table('bookings');
