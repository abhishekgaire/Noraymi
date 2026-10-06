-- Vendor health (M8-01; spec 09 · Outages, spec 01 · When our cloud is down):
-- our own calls to Stripe and Twilio, counted per venue and per minute, and
-- the state the vendor-health job sets from them and from the vendors'
-- published status feeds. The staff screens show "Stripe is having trouble ·
-- card payments may fail" and "Texts are delayed" while a vendor is in trouble.
set lock_timeout = '5s';

create table vendor_calls (
  venue_id  uuid not null references venues (id),
  vendor    text not null check (vendor in ('stripe', 'twilio')),
  minute    timestamptz not null,           -- the venue's clock, truncated to the minute
  calls     integer not null default 0 check (calls >= 0),
  errors    integer not null default 0 check (errors >= 0 and errors <= calls),
  primary key (venue_id, vendor, minute)
);
alter table vendor_calls enable row level security;
alter table vendor_calls force row level security;
create policy venue_isolation on vendor_calls to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_read on vendor_calls for select to app_definer using (true);
grant select on vendor_calls to app_definer;
grant select, insert, update on vendor_calls to app_rw;
-- No audit_table('vendor_calls'): counters, like heartbeats, never reach the audit log.

create table vendor_health (
  venue_id   uuid not null references venues (id),
  vendor     text not null check (vendor in ('stripe', 'twilio')),
  trouble    boolean not null default false,
  source     text check (source in ('status_feed', 'venue_errors', 'overall_errors')),
  since      timestamptz,
  checked_at timestamptz not null,
  primary key (venue_id, vendor)
);
alter table vendor_health enable row level security;
alter table vendor_health force row level security;
create policy venue_isolation on vendor_health to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on vendor_health to app_rw;
select audit_table('vendor_health');

-- Our error rate on every venue's calls together ("overall"): counts only, no venue named.
create or replace function vendor_call_totals(p_since timestamptz)
returns table (vendor text, calls bigint, errors bigint)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select vendor, sum(calls)::bigint, sum(errors)::bigint
    from vendor_calls where minute >= p_since group by vendor
$$;
alter function vendor_call_totals(timestamptz) owner to app_definer;
revoke all on function vendor_call_totals(timestamptz) from public;
grant execute on function vendor_call_totals(timestamptz) to app_rw;
