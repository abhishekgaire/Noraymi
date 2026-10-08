-- M8-19 · Closing the security baseline (spec 12 · 12; spec 02 · Approvals, On the record).
--
-- Unusual activity is watched in two places:
--  * Alerts to the venue's owner: a void on a check after part of it was paid
--    in cash, and refunds over the venue's set amount (every refund until one
--    is set). owner_alerts is the venue's own record of each one sent, so the
--    sweep tells the owner once per line or refund. It is venue data, behind
--    the venue wall like every venue table.
--  * Alerts to us (pages): a sign-in from a country the person hasn't signed
--    in from before. auth_sessions keeps the country CloudFront saw (two
--    letters, null where no CDN header came, as locally and in tests); it is
--    a platform table, like the rest of sign-in.
set lock_timeout = '5s';

alter table auth_sessions add column country text check (country ~ '^[A-Z]{2}$');

create table owner_alerts (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  kind          text not null check (kind in ('void_after_cash', 'refund')),
  source_key    text not null check (length(source_key) between 1 and 200),
  check_id      uuid,
  amount_cents  bigint not null check (amount_cents >= 0),
  business_date date not null,
  created_at    timestamptz not null,
  unique (venue_id, id),
  unique (venue_id, source_key),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
create index owner_alerts_date_idx on owner_alerts (venue_id, business_date);
alter table owner_alerts enable row level security;
alter table owner_alerts force row level security;
create policy venue_isolation on owner_alerts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on owner_alerts to app_rw;
-- Dated with the void's or refund's own (open) business date, so a closed night takes none.
create trigger closed_night_guard before insert or update of business_date on owner_alerts
  for each row execute function refuse_closed_night();
