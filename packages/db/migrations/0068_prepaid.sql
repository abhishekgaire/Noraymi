-- The prepaid-value ledger (M4-28; Money rules 11, 12 and 16; Data model ·
-- prepaid_accounts, prepaid_ledger; D83). Reserved now, with no route and no
-- screen: gift cards are phase 2, stored value phase 3, and M6 uses it for
-- song credit. An account's balance is the sum of its ledger rows, never a
-- stored number; issued is money in (+), redeemed, expired and refunded take
-- it out (-), and each kind posts to the prepaid-value account in M7's journal.
set lock_timeout = '5s';

create table prepaid_accounts (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues (id),
  kind        text not null check (kind in ('gift_card', 'stored_value', 'prepaid_hours', 'song_credit')),
  code_hash   text unique,
  guest_id    uuid,
  singer_id   uuid,
  issued_at   timestamptz not null,
  expires_on  date,
  status      text not null default 'active' check (status in ('active', 'closed')),
  unique (venue_id, id)
);
alter table prepaid_accounts enable row level security;
alter table prepaid_accounts force row level security;
create policy venue_isolation on prepaid_accounts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on prepaid_accounts to app_rw;
grant update (status) on prepaid_accounts to app_rw;
select audit_table('prepaid_accounts');

create table prepaid_ledger (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  account_id     uuid not null,
  kind           text not null check (kind in ('issued', 'redeemed', 'expired', 'refunded')),
  amount_cents   bigint not null,
  payment_id     uuid,
  check_id       uuid,
  by_user        uuid,
  at             timestamptz not null,
  business_date  date not null,
  unique (venue_id, id),
  foreign key (venue_id, account_id) references prepaid_accounts (venue_id, id),
  check ((kind = 'issued') = (amount_cents > 0)),
  check (amount_cents <> 0)
);
create index prepaid_ledger_account_idx on prepaid_ledger (venue_id, account_id);
alter table prepaid_ledger enable row level security;
alter table prepaid_ledger force row level security;
create policy venue_isolation on prepaid_ledger to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on prepaid_ledger to app_rw;
select audit_table('prepaid_ledger');
