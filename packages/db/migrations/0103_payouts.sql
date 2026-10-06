-- Payout matching (M7-14; Stripe setup 8 and 11; Data model · payouts,
-- payout_lines). When Stripe says a payout's reconciliation is complete, its
-- balance transactions are matched to our payments by PaymentIntent (never by
-- metadata). Each venue keeps its own `payouts` row for the payout and the
-- lines that are its own; Stripe's fees post as fees; anything with no row of
-- ours lands in Unmatched payments. A venue sees only its own lines; an
-- owner's report reads every venue of theirs through the org scope.
set lock_timeout = '5s';

create table payouts (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues (id),
  stripe_payout_id text not null,
  account          text not null,
  amount_cents     bigint not null,
  arrival_date     date,
  reconciled       boolean not null,
  created_at       timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, stripe_payout_id)
);
alter table payouts enable row level security;
alter table payouts force row level security;
create policy venue_isolation on payouts to app_rw
  using (case when app_org_scope() then false else venue_id = app_venue_id() end)
  with check (venue_id = app_venue_id());
create policy org_read on payouts for select to app_rw
  using (app_org_scope() and venue_id = any (owner_venues()));
grant select, insert on payouts to app_rw;
select audit_table('payouts');

create table payout_lines (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  payout_id      uuid not null,
  balance_txn_id text not null,
  type           text not null check (type in ('charge', 'refund', 'fee', 'unmatched', 'other')),
  payment_id     uuid,
  gross_cents    bigint not null,
  fee_cents      bigint not null,
  net_cents      bigint not null,
  unique (venue_id, id),
  unique (venue_id, balance_txn_id),
  foreign key (venue_id, payout_id) references payouts (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  check (net_cents = gross_cents - fee_cents)
);
create index payout_lines_by_payout on payout_lines (venue_id, payout_id);
alter table payout_lines enable row level security;
alter table payout_lines force row level security;
create policy venue_isolation on payout_lines to app_rw
  using (case when app_org_scope() then false else venue_id = app_venue_id() end)
  with check (venue_id = app_venue_id());
create policy org_read on payout_lines for select to app_rw
  using (app_org_scope() and venue_id = any (owner_venues()));
grant select, insert on payout_lines to app_rw;
select audit_table('payout_lines');

-- The venue and payment of a PaymentIntent, among the venues of the
-- organization that owns the account (live or sandbox): payout matching runs
-- with no user and finds each line's venue here, never across organizations.
create policy definer_read on payments for select to app_definer using (true);
grant select on payments to app_definer;
create or replace function resolve_payment_intent(p_account text, p_pi text)
returns table (venue_id uuid, payment_id uuid)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select p.venue_id, p.id from payments p
    join venues v on v.id = p.venue_id
    join organizations o on o.id = v.org_id
   where p_account is not null and p.stripe_pi_id = p_pi
     and p_account in (o.stripe_account_id, o.stripe_training_account_id)
$$;
alter function resolve_payment_intent(text, text) owner to app_definer;
revoke all on function resolve_payment_intent(text, text) from public;
grant execute on function resolve_payment_intent(text, text) to app_rw;
