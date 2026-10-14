-- A % or $ discount on a whole check (P-02; Money rules 7; module check_discount). One discount
-- stands on a check at a time: a percent (pct) or an amount (amount_cents), with a reason. Each
-- finalize works its `discount` lines out again from it (off room time, items and songs before tax,
-- split by category), so a percent follows the check as it grows. `counted_cents` is what it came to
-- when given, which the person's reason-only limit counts unless a manager approved it
-- (approved_by). Removing it (removed_by, removed_at) is allowed while the check is open, before
-- payment; the row stays for the audit log, the exceptions and the money audit.
set lock_timeout = '5s';

create table check_discounts (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  check_id      uuid not null,
  business_date date not null,
  mode          text not null check (mode in ('pct', 'amount')),
  pct           numeric(5, 2) check (pct is null or (pct > 0 and pct <= 100)),
  amount_cents  bigint check (amount_cents is null or amount_cents > 0),
  reason        text not null check (char_length(reason) between 1 and 300),
  counted_cents bigint not null check (counted_cents >= 0),
  added_by      uuid not null references users (id),
  added_at      timestamptz not null,
  approved_by   uuid references users (id),
  removed_by    uuid references users (id),
  removed_at    timestamptz,
  check ((mode = 'pct') = (pct is not null)),
  check ((mode = 'amount') = (amount_cents is not null)),
  check ((removed_by is null) = (removed_at is null)),
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
-- One discount stands on a check at a time.
create unique index check_discounts_one_standing on check_discounts (venue_id, check_id)
  where removed_at is null;
-- A closed night takes no new discount (M7's guard, as on every table with a business date).
create trigger closed_night_guard before insert or update of business_date on check_discounts
  for each row execute function refuse_closed_night();
alter table check_discounts enable row level security;
alter table check_discounts force row level security;
create policy venue_isolation on check_discounts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on check_discounts to app_rw;
grant update (removed_by, removed_at) on check_discounts to app_rw;
-- A one-venue restore (M8-20) needs the wall and the grants every venue table has.
create policy restore_wall on check_discounts to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on check_discounts to app_migrator;
select audit_table('check_discounts');

-- A discount over the reason-only limit waits for approval like a comp.
alter table approvals drop constraint approvals_kind_check;
alter table approvals add constraint approvals_kind_check
  check (kind in ('comp', 'void', 'refund', 'clock_pause', 'tip_review', 'paid_out', 'party_size_down',
                  'card_on_file', 'over_hold', 'drawer_handover', 'discount')) not valid;
alter table approvals validate constraint approvals_kind_check;
