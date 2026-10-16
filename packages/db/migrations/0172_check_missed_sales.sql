-- A missed sale on tonight's date (P-19; Money rules 16; module missed_sale). A sale nobody rang up
-- on an earlier night is rung up tonight on a bar tab marked "From the night of <date>" with a
-- reason; it counts on tonight's business date (closed nights never reopen, D88), and the Z report
-- lists it with the night it came from. It's written once approved per the venue's approval setting
-- (phone, PIN or none). One stands on a check at a time; it can be taken off while the check is open,
-- before payment; the row stays for the audit log and the Z report. Replaces the old register's
-- past-dated manual ticket.
set lock_timeout = '5s';

create table check_missed_sales (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  check_id       uuid not null,
  business_date  date not null,
  from_date      date not null,
  reason         text not null check (char_length(btrim(reason)) between 1 and 200),
  added_by       uuid not null references users (id),
  added_at       timestamptz not null,
  approved_by    uuid references users (id),
  removed_by     uuid references users (id),
  removed_at     timestamptz,
  check (from_date < business_date),
  check ((removed_by is null) = (removed_at is null)),
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
-- One missed sale stands on a check at a time.
create unique index check_missed_sales_one_standing on check_missed_sales (venue_id, check_id)
  where removed_at is null;
-- It's dated tonight: a closed night takes no new row (M7's guard, as on every table with a business date).
create trigger closed_night_guard before insert or update of business_date on check_missed_sales
  for each row execute function refuse_closed_night();
alter table check_missed_sales enable row level security;
alter table check_missed_sales force row level security;
create policy venue_isolation on check_missed_sales to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on check_missed_sales to app_rw;
grant update (removed_by, removed_at) on check_missed_sales to app_rw;
-- A one-venue restore (M8-20) needs the wall and the grants every venue table has.
create policy restore_wall on check_missed_sales to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on check_missed_sales to app_migrator;
select audit_table('check_missed_sales');

-- Marking a missed sale waits for a manager's approval, per the venue's setting.
alter table approvals drop constraint approvals_kind_check;
alter table approvals add constraint approvals_kind_check
  check (kind in ('comp', 'void', 'refund', 'clock_pause', 'tip_review', 'paid_out', 'party_size_down',
                  'card_on_file', 'over_hold', 'drawer_handover', 'discount', 'tip_change',
                  'tax_exempt', 'missed_sale')) not valid;
alter table approvals validate constraint approvals_kind_check;
