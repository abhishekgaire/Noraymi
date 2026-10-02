-- Refunds (M4-21; Money rules 14 and 16; Payment flows · Refunds; Data model
-- · refunds). A refund is asked for on a paid check (or a deposit on a
-- booking not yet checked in), approved by someone else on their own phone,
-- then sent to Stripe keyed <payment_id>:refund:<n>. Its status follows
-- refund.updated and refund.failed: pending until Stripe says succeeded, then
-- a negative payment_allocations row keeps the check's amount due at zero.
-- A failed one keeps Stripe's reason and leaves the amount owed to the guest.
set lock_timeout = '5s';

create table refunds (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references venues (id),
  payment_id            uuid not null,
  check_id              uuid,
  booking_id            uuid,
  amount_cents          bigint not null check (amount_cents > 0),
  reason                text not null check (length(reason) between 1 and 500),
  status                text not null default 'pending'
                          check (status in ('pending', 'succeeded', 'failed', 'canceled')),
  n                     int not null check (n >= 1),
  stripe_refund_id      text,
  failure_reason        text,
  requested_by          uuid not null,
  approval_id           uuid,
  approved_by           uuid,
  business_date         date not null,
  adjusts_business_date date,
  requested_at          timestamptz not null,
  resolved_at           timestamptz,
  unique (venue_id, id),
  unique (venue_id, payment_id, n),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  check ((check_id is null) <> (booking_id is null))
);
create index refunds_check_idx on refunds (venue_id, check_id);
create index refunds_payment_idx on refunds (venue_id, payment_id);
create unique index refunds_stripe_idx on refunds (stripe_refund_id) where stripe_refund_id is not null;
alter table refunds enable row level security;
alter table refunds force row level security;
create policy venue_isolation on refunds to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on refunds to app_rw;
grant update (status, stripe_refund_id, failure_reason, approved_by, resolved_at) on refunds to app_rw;
select audit_table('refunds');

-- A refund's negative allocation names its refund.
alter table payment_allocations add column refund_id uuid;
