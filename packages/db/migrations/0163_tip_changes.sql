-- Change a tip after paying (P-06; spec 07 · Outside card machine · Changing a tip after paying).
-- A payment on the outside card machine keeps its tip in `payments.tip_cents`; when the tip is
-- adjusted on the machine, staff fix the record to match. Each change is a row here: from what, to
-- what, who changed it, the approval it went through (tip checks per the approval setting), the
-- business date it posts to and, when that's later than the payment's own night (the night closed,
-- or its date has passed), the night it points back at (Money rules 16; closed nights never
-- reopen, D88). The person the tip was credited to keeps it (`credited_to`). Insert-only.
--
-- The tip ledger follows: the payment's trigger writes the difference, and for a change with a
-- row here it writes it on the change's date, pointing back, credited to `credited_to`.
set lock_timeout = '5s';

create table tip_changes (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references venues (id),
  payment_id            uuid not null,
  from_cents            bigint not null check (from_cents >= 0),
  to_cents              bigint not null check (to_cents >= 0),
  business_date         date not null,
  adjusts_business_date date,
  credited_to           uuid references users (id),
  changed_by            uuid not null references users (id),
  changed_at            timestamptz not null,
  approval_id           uuid,
  created_at            timestamptz not null default now(),
  check (from_cents <> to_cents),
  check (adjusts_business_date is null or adjusts_business_date < business_date),
  unique (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, approval_id) references approvals (venue_id, id)
);
create index tip_changes_by_payment on tip_changes (venue_id, payment_id, created_at);
create index tip_changes_by_date on tip_changes (venue_id, business_date);
-- A closed night takes nothing new (M7's guard, as on every table with a business date).
create trigger closed_night_guard before insert or update of business_date on tip_changes
  for each row execute function refuse_closed_night();
alter table tip_changes enable row level security;
alter table tip_changes force row level security;
create policy venue_isolation on tip_changes to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on tip_changes to app_rw;
-- A one-venue restore (M8-20) needs the wall and the grants every venue table has.
create policy restore_wall on tip_changes to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on tip_changes to app_migrator;
select audit_table('tip_changes');

-- A tip change over the venue's limits waits for approval like a slip's tip.
alter table approvals drop constraint approvals_kind_check;
alter table approvals add constraint approvals_kind_check
  check (kind in ('comp', 'void', 'refund', 'clock_pause', 'tip_review', 'paid_out', 'party_size_down',
                  'card_on_file', 'over_hold', 'drawer_handover', 'discount', 'tip_change')) not valid;
alter table approvals validate constraint approvals_kind_check;

-- A payment's tip: what's newly captured, or the change to a captured tip. A change recorded in
-- tip_changes (P-06) posts on its own date, pointing back, credited to whoever the tip was.
create or replace function tip_ledger_from_payment() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_in constant text[] := array['captured', 'partly_refunded', 'refunded'];
  v_before bigint := 0;
  v_now bigint := 0;
  v_check uuid;
  v_change record;
begin
  if restoring() then return new; end if;
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
  if tg_op = 'UPDATE' and old.status = any (v_in) and new.status = any (v_in) then
    select business_date, adjusts_business_date, credited_to into v_change from tip_changes
     where venue_id = new.venue_id and payment_id = new.id
       and from_cents = old.tip_cents and to_cents = new.tip_cents
     order by created_at desc limit 1;
    if found then
      perform tip_ledger_write(new.venue_id, case when new.method = 'cash' then 'cash_tip' else 'card_tip' end,
                               v_now - v_before, v_change.business_date, v_check, new.id, null,
                               v_change.credited_to, v_change.adjusts_business_date);
      return null;
    end if;
  end if;
  -- A bar tab's tip is credited to whoever closed the tab, even when the capture runs in a job.
  perform tip_ledger_write(new.venue_id, case when new.method = 'cash' then 'cash_tip' else 'card_tip' end,
                           v_now - v_before, new.business_date, v_check, new.id, null,
                           (select closed_by from tabs where venue_id = new.venue_id and payment_id = new.id
                             order by closed_by is null limit 1),
                           new.adjusts_business_date);
  return null;
end;
$$;
