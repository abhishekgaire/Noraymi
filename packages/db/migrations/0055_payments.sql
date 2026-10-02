-- The payment tables (M4-04; Data model · the money core; Money rules 11
-- and 12): payments, their attempts, how each payment is allocated to
-- checks, and every status change. Append-only for the app: it may insert
-- and select, and update only the columns the state machine moves. The
-- amounts (amount_cents, authorized_cents, surcharge_cents, tip_cents) change
-- only through record_authorization(), record_capture() and set_tip(),
-- definer functions that write an audit row with old and new values; a cash
-- payment never changes after insert. amount_due() is the one way to read
-- what a check still owes, with the check row locked.
set lock_timeout = '5s';

create table payments (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references venues (id),
  booking_id            uuid,
  method                text not null check (method in
                          ('card_present', 'card_online', 'card_on_file', 'cash', 'external', 'prepaid')),
  stripe_pi_id          text unique,
  status                text not null check (status in ('pending', 'requires_action', 'authorized',
                          'captured', 'capture_failed', 'partly_refunded', 'refunded', 'canceled', 'failed')),
  authorized_cents      bigint,
  amount_cents          bigint not null default 0 check (amount_cents >= 0),
  tip_cents             bigint not null default 0 check (tip_cents >= 0),
  surcharge_cents       bigint not null default 0 check (surcharge_cents >= 0),
  tendered_cents        bigint,
  change_cents          bigint,
  drawer_session_id     uuid,                          -- drawer tables come with M4-13
  staff_bank_id         uuid,
  incremental_supported boolean,
  overcapture_supported boolean,
  increments_used       int not null default 0,
  generated_card_pm     text,
  card_brand            text,
  card_last4            text,
  card_funding          text,
  capture_before        timestamptz,
  mit_reason            text,
  training              boolean not null default false,
  business_date         date not null,
  adjusts_business_date date,
  created_at            timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, booking_id) references bookings (venue_id, id)
);
alter table payments enable row level security;
alter table payments force row level security;
create policy venue_isolation on payments to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on payments to app_rw;
grant update (status, capture_before, increments_used, incremental_supported, overcapture_supported,
  generated_card_pm, card_brand, card_last4, card_funding) on payments to app_rw;
select audit_table('payments');

create table payment_attempts (
  venue_id     uuid not null,
  payment_id   uuid not null,
  attempt_no   int not null,
  check_id     uuid,
  booking_id   uuid,
  portion_key  text not null,                        -- 'full', 'share:<split_share_id>', 'tab', 'deposit'
  action       text not null,                        -- process, collect, confirm, increment, capture, off_session
  reader_id    text,
  idem_key     text not null,                        -- '<payment_id>:<action>:<attempt_no>'
  amount_cents bigint not null,
  state        text not null check (state in ('started', 'unknown', 'succeeded', 'failed', 'canceled')),
  decline_code text,
  started_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  primary key (venue_id, payment_id, attempt_no),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, booking_id) references bookings (venue_id, id)
);
-- one unfinished attempt per check or booking portion, so a second payment for the same amount can't start
create unique index one_open_attempt on payment_attempts
  (venue_id, (coalesce(check_id, booking_id)), portion_key)
  where state in ('started', 'unknown');
alter table payment_attempts enable row level security;
alter table payment_attempts force row level security;
create policy venue_isolation on payment_attempts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on payment_attempts to app_rw;
grant update (state, decline_code, resolved_at) on payment_attempts to app_rw;
select audit_table('payment_attempts');

create table payment_allocations (
  id            uuid primary key default gen_random_uuid(),   -- so one allocation's state can move
  venue_id      uuid not null,
  payment_id    uuid not null,
  check_id      uuid not null,
  amount_cents  bigint not null,
  kind          text not null default 'payment' check (kind in ('payment', 'refund')),  -- a refund's row is negative
  state         text not null check (state in ('in_progress', 'captured', 'released')),
  -- A deposit's allocation, and a tab hold's while in progress, follow the check's lines up to their amount
  -- (Money rules 11 and 12), so a check never shows a negative amount due.
  follows_lines boolean not null default false,
  share_id      uuid,
  room_guest_id uuid,
  created_at    timestamptz not null default now(),
  unique (venue_id, id),
  check ((kind = 'refund') = (amount_cents < 0) or amount_cents = 0),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
create index payment_allocations_check_idx on payment_allocations (venue_id, check_id);
alter table payment_allocations enable row level security;
alter table payment_allocations force row level security;
create policy venue_isolation on payment_allocations to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on payment_allocations to app_rw;
grant update (state) on payment_allocations to app_rw;
select audit_table('payment_allocations');

create table payment_events (
  id              bigint generated always as identity primary key,
  venue_id        uuid not null,
  payment_id      uuid not null,
  from_status     text,
  to_status       text not null,
  source          text not null check (source in ('api', 'webhook', 'reconciler')),
  stripe_event_id text,
  at              timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id)
);
create index payment_events_payment_idx on payment_events (venue_id, payment_id);
alter table payment_events enable row level security;
alter table payment_events force row level security;
create policy venue_isolation on payment_events to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on payment_events to app_rw;

-- The amounts move only here. Each runs as app_definer inside the caller's venue (app_venue_id()), so it can
-- never reach another venue's payment; the audit trigger records old and new values.
grant select, update (amount_cents, authorized_cents, surcharge_cents, tip_cents) on payments to app_definer;
create policy definer_amounts on payments for select to app_definer using (venue_id = app_venue_id());
create policy definer_amounts_update on payments for update to app_definer
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());

create or replace function record_authorization(p_payment uuid, p_authorized_cents bigint) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_authorized_cents is null or p_authorized_cents < 0 then
    raise exception 'an authorization is a positive amount';
  end if;
  update payments set authorized_cents = p_authorized_cents
   where venue_id = app_venue_id() and id = p_payment and method <> 'cash';
  if not found then raise exception 'no card payment % here', p_payment; end if;
end
$$;

create or replace function record_capture(
  p_payment uuid, p_amount_cents bigint, p_tip_cents bigint, p_surcharge_cents bigint
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_amount_cents < 0 or p_tip_cents < 0 or p_surcharge_cents < 0 then
    raise exception 'a capture is never negative';
  end if;
  update payments set amount_cents = p_amount_cents, tip_cents = p_tip_cents, surcharge_cents = p_surcharge_cents
   where venue_id = app_venue_id() and id = p_payment and method <> 'cash';
  if not found then raise exception 'no card payment % here', p_payment; end if;
end
$$;

create or replace function set_tip(p_payment uuid, p_tip_cents bigint) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_tip_cents < 0 then raise exception 'a tip is never negative'; end if;
  update payments set tip_cents = p_tip_cents
   where venue_id = app_venue_id() and id = p_payment and method <> 'cash';
  if not found then raise exception 'no card payment % here', p_payment; end if;
end
$$;

alter function record_authorization(uuid, bigint) owner to app_definer;
alter function record_capture(uuid, bigint, bigint, bigint) owner to app_definer;
alter function set_tip(uuid, bigint) owner to app_definer;
revoke all on function record_authorization(uuid, bigint) from public;
revoke all on function record_capture(uuid, bigint, bigint, bigint) from public;
revoke all on function set_tip(uuid, bigint) from public;
grant execute on function record_authorization(uuid, bigint) to app_rw;
grant execute on function record_capture(uuid, bigint, bigint, bigint) to app_rw;
grant execute on function set_tip(uuid, bigint) to app_rw;

-- What a check still owes (Money rules 12), with the check row locked so two payments can't both fit:
-- its lines minus its captured and in-progress allocations (a refund's negative). Allocations that follow the
-- lines (a deposit, a tab hold in progress) count only up to what the lines leave after the others, so the
-- answer is never negative. p_leave_out leaves one payment out: a tab's balance leaves out its own hold.
-- Runs as the caller (app_rw), inside the venue.
create or replace function amount_due(p_check uuid, p_leave_out uuid default null) returns bigint
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_lines bigint;
  v_fixed bigint;
  v_left bigint;
  v_follow record;
begin
  perform 1 from checks where venue_id = app_venue_id() and id = p_check for update;
  if not found then raise exception 'no check % here', p_check; end if;
  select coalesce(sum(amount_cents), 0) into v_lines
    from check_lines where venue_id = app_venue_id() and check_id = p_check;
  select coalesce(sum(amount_cents), 0) into v_fixed
    from payment_allocations
   where venue_id = app_venue_id() and check_id = p_check and state in ('captured', 'in_progress')
     and not follows_lines and payment_id is distinct from p_leave_out;
  v_left := v_lines - v_fixed;
  for v_follow in
    select amount_cents from payment_allocations
     where venue_id = app_venue_id() and check_id = p_check and state in ('captured', 'in_progress')
       and follows_lines and payment_id is distinct from p_leave_out
     order by created_at, id
  loop
    v_left := v_left - least(v_follow.amount_cents, greatest(v_left, 0));
  end loop;
  return greatest(v_left, 0);
end
$$;
grant execute on function amount_due(uuid, uuid) to app_rw;
