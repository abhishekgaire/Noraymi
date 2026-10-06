-- The tip ledger (M7-08; Data model · tip_ledger; Money rules 9, 14 and 16;
-- GA-M2): every gratuity, card tip and cash tip, credited to the staff member
-- who collected it and their open shift, kept 6 years. Insert-only.
--
-- Rows are written in the same transaction as the money they record, by
-- triggers that run at commit (so a payment's allocation to its check is
-- there to read): a payment's tip once it's captured (a later change, such as
-- a slip tip entered or approved, writes the difference), and a check's
-- gratuity once it's paid (the net of its gratuity lines, less what's already
-- in the ledger for it). A refund's share of gratuity or a refunded tip is a
-- negative row, written by the refund itself. Who collected it is the person
-- the transaction runs for (`app.user_id`), or for a bar tab whoever closed
-- it (the capture may run in a job); a guest paying their share, the
-- tab cut-off or the sweeper leaves it empty, and the row still counts in its
-- night's pool. Practice money writes nothing. The date is the money's own
-- business date, moved past any closed night, pointing back when it moved.
set lock_timeout = '5s';

create table tip_ledger (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references venues (id),
  user_id               uuid,
  shift_id              uuid,
  business_date         date not null,
  adjusts_business_date date,
  source                text not null check (source in ('gratuity', 'card_tip', 'cash_tip')),
  amount_cents          bigint not null check (amount_cents <> 0),
  check_id              uuid,
  payment_id            uuid,
  refund_id             uuid,
  created_at            timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, shift_id) references shifts (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, refund_id) references refunds (venue_id, id)
);
create index tip_ledger_by_date on tip_ledger (venue_id, business_date);
create index tip_ledger_by_user on tip_ledger (venue_id, user_id, business_date);
alter table tip_ledger enable row level security;
alter table tip_ledger force row level security;
create policy venue_isolation on tip_ledger to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on tip_ledger to app_rw;
select audit_table('tip_ledger');
create trigger closed_night_guard before insert or update of business_date on tip_ledger
  for each row execute function refuse_closed_night();

-- One ledger row, credited to whoever the transaction runs for and their open shift.
create or replace function tip_ledger_write(
  p_venue uuid, p_source text, p_amount bigint, p_date date, p_check uuid, p_payment uuid, p_refund uuid,
  p_user uuid default null, p_adjusts date default null
) returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := coalesce(p_user, nullif(current_setting('app.user_id', true), '')::uuid);
  v_shift uuid;
  v_date date := open_business_date(p_venue, p_date);
begin
  if p_amount = 0 then
    return;
  end if;
  if v_user is not null then
    select s.id into v_shift
      from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
     where s.venue_id = p_venue and m.user_id = v_user
       and (s.ended_at is null or s.business_date = p_date)
     order by s.ended_at is null desc, s.started_at desc limit 1;
    if not exists (select 1 from memberships where venue_id = p_venue and user_id = v_user) then
      v_user := null;
    end if;
  end if;
  insert into tip_ledger (venue_id, user_id, shift_id, business_date, adjusts_business_date, source,
                          amount_cents, check_id, payment_id, refund_id)
  values (p_venue, v_user, v_shift, v_date, coalesce(p_adjusts, case when v_date <> p_date then p_date end),
          p_source, p_amount, p_check, p_payment, p_refund);
end;
$$;

-- A payment's tip: what's newly captured, or the change to a captured tip.
create or replace function tip_ledger_from_payment() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_in constant text[] := array['captured', 'partly_refunded', 'refunded'];
  v_before bigint := 0;
  v_now bigint := 0;
  v_check uuid;
begin
  if new.training then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = any (v_in) then
    v_before := old.tip_cents;
  end if;
  if new.status = any (v_in) then
    v_now := new.tip_cents;
  end if;
  if v_now = v_before then
    return null;
  end if;
  select check_id into v_check from payment_allocations
   where venue_id = new.venue_id and payment_id = new.id and check_id is not null
   order by created_at limit 1;
  -- A bar tab's tip is credited to whoever closed the tab, even when the capture runs in a job.
  perform tip_ledger_write(new.venue_id, case when new.method = 'cash' then 'cash_tip' else 'card_tip' end,
                           v_now - v_before, new.business_date, v_check, new.id, null,
                           (select closed_by from tabs where venue_id = new.venue_id and payment_id = new.id
                             order by closed_by is null limit 1),
                           new.adjusts_business_date);
  return null;
end;
$$;

create constraint trigger tip_ledger_payment after insert or update of status, tip_cents on payments
  deferrable initially deferred
  for each row execute function tip_ledger_from_payment();

-- A check's gratuity once it's paid: its gratuity lines, net of what the ledger already has for it.
create or replace function tip_ledger_from_check() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_lines bigint;
  v_kept bigint;
begin
  if new.training or new.status <> 'paid' or (tg_op = 'UPDATE' and old.status = 'paid') then
    return null;
  end if;
  select coalesce(sum(amount_cents), 0) into v_lines from check_lines
   where venue_id = new.venue_id and check_id = new.id and kind = 'gratuity';
  select coalesce(sum(amount_cents), 0) into v_kept from tip_ledger
   where venue_id = new.venue_id and check_id = new.id and source = 'gratuity' and refund_id is null;
  perform tip_ledger_write(new.venue_id, 'gratuity', v_lines - v_kept, new.business_date, new.id, null, null);
  return null;
end;
$$;

create constraint trigger tip_ledger_check after insert or update of status on checks
  deferrable initially deferred
  for each row execute function tip_ledger_from_check();

-- A refund's share of gratuity, or a refunded tip: a negative row on the refund's business date,
-- credited to whoever the original row was credited to.
create or replace function tip_ledger_reverse(
  p_venue uuid, p_source text, p_amount bigint, p_date date, p_check uuid, p_payment uuid, p_refund uuid
) returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_from record;
  v_date date := open_business_date(p_venue, p_date);
begin
  if p_amount = 0 then
    return;
  end if;
  select user_id, shift_id into v_from from tip_ledger
   where venue_id = p_venue and source = p_source and amount_cents > 0
     and (case when p_source = 'gratuity' then check_id = p_check else payment_id = p_payment end)
   order by created_at desc limit 1;
  insert into tip_ledger (venue_id, user_id, shift_id, business_date, adjusts_business_date, source,
                          amount_cents, check_id, payment_id, refund_id)
  values (p_venue, v_from.user_id, v_from.shift_id, v_date, case when v_date <> p_date then p_date end,
          p_source, -abs(p_amount), p_check, p_payment, p_refund);
end;
$$;
