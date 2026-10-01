-- M2-08 · Checks, their lines and the venue's counters (spec 04 · the money
-- core). A check never changes after the fact: corrections add lines. The
-- rest of the money core (revisions, payments, attempts, allocations, payment
-- events) comes in M4. app_rw inserts lines and never updates or deletes one.
set lock_timeout = '5s';

create table checks (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  number          bigint not null,
  kind            text not null check (kind in ('room', 'bar', 'quick', 'fee')),
  business_date   date not null,
  room_session_id uuid,
  booking_id      uuid,
  status          text not null default 'open' check (status in
                    ('open', 'finalized', 'partly_paid', 'paid', 'reopened', 'void')),
  revision        int not null default 0,
  version         int not null default 0,
  training        boolean not null default false,
  opened_by       uuid not null,
  opened_at       timestamptz not null default now(),
  paid_at         timestamptz,
  unique (venue_id, id),
  unique (venue_id, training, number),
  foreign key (venue_id, room_session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, booking_id) references bookings (venue_id, id)
);
alter table checks enable row level security;
alter table checks force row level security;
create policy venue_isolation on checks to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
-- The spec grants select and insert. `version` goes up with every line (If-Match uses it), so it alone is updatable
-- here; status, revision and paid_at join with finalize and payments in M4.
grant select, insert on checks to app_rw;
grant update (version) on checks to app_rw;
select audit_table('checks');

create table check_lines (
  id                 bigint generated always as identity primary key,
  venue_id           uuid not null,
  check_id           uuid not null,
  kind               text not null check (kind in ('room_time', 'item', 'song', 'fee', 'damage',
                       'min_spend', 'comp', 'void', 'discount', 'gratuity', 'tax', 'card_surcharge',
                       'cash_discount', 'transfer_in', 'transfer_out', 'forfeit', 'refund')),
  revision           int,
  description        text not null,
  qty                numeric(10, 2) not null default 1,
  unit_cents         bigint not null,
  amount_cents       bigint not null,
  tax_category       text check (tax_category in ('room_time', 'drink', 'food', 'song', 'damage',
                       'fee', 'surcharge')),
  tax_rate           numeric(7, 6),
  jurisdiction_code  text,
  taxable_base_cents bigint,
  payment_id         uuid,
  file_id            uuid,
  source_id          uuid,
  reverses_id        bigint,
  made               boolean,
  reason             text,
  added_by           uuid,
  approved_by        uuid,
  business_date      date not null,
  adjusts_business_date date,
  rule_pack_version  text,
  added_at           timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, reverses_id) references check_lines (venue_id, id)
);
create index check_lines_check_idx on check_lines (venue_id, check_id);
alter table check_lines enable row level security;
alter table check_lines force row level security;
create policy venue_isolation on check_lines to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on check_lines to app_rw;
select audit_table('check_lines');

create table venue_counters (
  venue_id uuid not null references venues (id),
  name     text not null check (name in ('check', 'check_training', 'z_report')),
  next     bigint not null check (next >= 1),
  primary key (venue_id, name)
);
alter table venue_counters enable row level security;
alter table venue_counters force row level security;
create policy venue_isolation on venue_counters to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on venue_counters to app_rw;
grant update (next) on venue_counters to app_rw;
