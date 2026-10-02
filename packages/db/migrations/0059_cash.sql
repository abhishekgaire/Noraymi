-- Cash (M4-13; Money rules 15; Data model · drawer_moves, staff_banks):
-- every move in a drawer session with who took it and at which screen (sale
-- and refund now; paid-out, drop, no-sale and tip-out come in M7); cash a
-- person holds outside a drawer (taken on a staff phone) until they drop it;
-- a `drawer` print job, the kick through the receipt printer's port; and a
-- `detail` on payment_events for "Wrong amount? Fix the change", since a cash
-- payment never changes after insert (expand-only, the ticket's default).
set lock_timeout = '5s';

create table staff_banks (
  id                      uuid primary key default gen_random_uuid(),
  venue_id                uuid not null references venues (id),
  user_id                 uuid not null,
  business_date           date not null,
  cash_cents              bigint not null default 0,
  dropped_at              timestamptz,
  dropped_into_session_id uuid,
  unique (venue_id, id),
  unique (venue_id, user_id, business_date),
  foreign key (venue_id, dropped_into_session_id) references drawer_sessions (venue_id, id)
);
alter table staff_banks enable row level security;
alter table staff_banks force row level security;
create policy venue_isolation on staff_banks to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on staff_banks to app_rw;
grant update (cash_cents, dropped_at, dropped_into_session_id) on staff_banks to app_rw;
select audit_table('staff_banks');

create table drawer_moves (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues (id),
  drawer_session_id uuid,
  staff_bank_id     uuid,
  kind              text not null check (kind in ('sale', 'refund', 'paid_out', 'drop', 'no_sale', 'tip_out')),
  amount_cents      bigint not null,
  payment_id        uuid,
  taken_by          uuid not null,
  device_id         uuid,
  reason            text,
  approved_by       uuid,
  photo_file_id     uuid,
  at                timestamptz not null,
  unique (venue_id, id),
  check ((drawer_session_id is null) <> (staff_bank_id is null)),
  foreign key (venue_id, drawer_session_id) references drawer_sessions (venue_id, id),
  foreign key (venue_id, staff_bank_id) references staff_banks (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id)
);
create index drawer_moves_session_idx on drawer_moves (venue_id, drawer_session_id);
alter table drawer_moves enable row level security;
alter table drawer_moves force row level security;
create policy venue_isolation on drawer_moves to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on drawer_moves to app_rw;
select audit_table('drawer_moves');

alter table payment_events add column detail jsonb;

alter table print_jobs drop constraint print_jobs_kind_check;
alter table print_jobs add constraint print_jobs_kind_check
  check (kind in ('ticket', 'receipt', 'check', 'drawer')) not valid;
alter table print_jobs validate constraint print_jobs_kind_check;
