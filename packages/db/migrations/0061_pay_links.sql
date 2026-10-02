-- Pay links (M4-15; Security 9; API · POST /v1/public/pay/{token}): a
-- 128-bit token, stored hashed, that names one payment on our payment page
-- (in M4, a check's balance after a declined card on file; deposits and
-- staff payment links in M5). The payment and its one PaymentIntent are made
-- on the first visit and reused on every retry. `resolve_pay_link` finds the
-- venue from the token's hash, as the other token routes do.
set lock_timeout = '5s';

create table pay_links (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues (id),
  token_hash   text not null unique,
  check_id     uuid,
  booking_id   uuid,
  amount_cents bigint not null check (amount_cents > 0),
  payment_id   uuid,
  purpose      text not null default 'balance' check (purpose in ('balance', 'deposit', 'link')),
  expires_at   timestamptz not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  used_at      timestamptz,
  unique (venue_id, id),
  check ((check_id is null) <> (booking_id is null)),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, booking_id) references bookings (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id)
);
alter table pay_links enable row level security;
alter table pay_links force row level security;
create policy venue_isolation on pay_links to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on pay_links to app_rw;
grant update (payment_id, used_at) on pay_links to app_rw;
grant select on pay_links to app_definer;
create policy definer_read on pay_links for select to app_definer using (true);
select audit_table('pay_links');

create or replace function resolve_pay_link(p_token_hash text) returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select venue_id from pay_links where token_hash = p_token_hash
$$;
alter function resolve_pay_link(text) owner to app_definer;
revoke all on function resolve_pay_link(text) from public;
grant execute on function resolve_pay_link(text) to app_rw;
