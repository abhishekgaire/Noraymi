-- The go-live checklist (M4-29; milestones · M4; Stripe setup steps 3 and 11;
-- screens Setup notes 8 and 10). The ticket's cautious default: one small table
-- of checks that Admin → Payments, the module guard and the Console all read
-- (the Console inside each venue's wall, as its venue list already does).
-- Keys: merchant_category (the category we expect, and what Stripe's account
-- has), and per person dashboard_login:<user_id> and tap_to_pay:<user_id>,
-- which the owner confirms, with who and when, since Stripe can't list them.
set lock_timeout = '5s';

create table setup_checks (
  venue_id      uuid not null references venues (id),
  key           text not null check (key ~ '^(merchant_category|dashboard_login:[0-9a-f-]{36}|tap_to_pay:[0-9a-f-]{36})$'),
  status        text not null default 'pending' check (status in ('pending', 'passed', 'failed')),
  expected      text,
  found         text,
  confirmed_by  uuid,
  confirmed_at  timestamptz,
  primary key (venue_id, key)
);
alter table setup_checks enable row level security;
alter table setup_checks force row level security;
create policy venue_isolation on setup_checks to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on setup_checks to app_rw;
select audit_table('setup_checks');
