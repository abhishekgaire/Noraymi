-- Tip pools (M7-09; Money rules 1 and 9; Data model · tip_pools,
-- tip_pool_occupations, tip_shares; D8, D22). Each business date has one
-- pool, opened with the method in force at its start: `open` while the night
-- runs (its shares are worked out live from the ledger and the shifts, and
-- written here once, insert-only, as it closes), `closed` and final at the
-- close (M7-12), `exported` and locked once a
-- payroll export includes it (M7-16). Shares are kept per person and duty,
-- per source; `for_business_date` marks late tips earned on an earlier night
-- (split by that night's people and minutes) recorded in this pool.
set lock_timeout = '5s';

create table tip_pools (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  business_date date not null,
  method        text not null check (method in ('hours', 'even', 'roomServer')),
  status        text not null default 'open' check (status in ('open', 'closed', 'exported')),
  exported_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, business_date)
);
alter table tip_pools enable row level security;
alter table tip_pools force row level security;
create policy venue_isolation on tip_pools to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on tip_pools to app_rw;
grant update (status, exported_at) on tip_pools to app_rw;
select audit_table('tip_pools');

create table tip_pool_occupations (
  venue_id   uuid not null references venues (id),
  pool_id    uuid not null,
  occupation text not null,
  share_pct  numeric(6, 3) not null check (share_pct >= 0 and share_pct <= 100),
  primary key (venue_id, pool_id, occupation),
  foreign key (venue_id, pool_id) references tip_pools (venue_id, id)
);
alter table tip_pool_occupations enable row level security;
alter table tip_pool_occupations force row level security;
create policy venue_isolation on tip_pool_occupations to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on tip_pool_occupations to app_rw;
select audit_table('tip_pool_occupations');

create table tip_shares (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues (id),
  pool_id           uuid not null,
  for_business_date date not null,
  user_id           uuid not null,
  duty              text not null check (duty in ('bar', 'front_desk', 'runner')),
  minutes           integer not null check (minutes >= 0),
  gratuity_cents    bigint not null,
  card_tip_cents    bigint not null,
  cash_tip_cents    bigint not null,
  unique (venue_id, id),
  foreign key (venue_id, pool_id) references tip_pools (venue_id, id)
);
create index tip_shares_by_pool on tip_shares (venue_id, pool_id);
create index tip_shares_by_user on tip_shares (venue_id, user_id);
alter table tip_shares enable row level security;
alter table tip_shares force row level security;
create policy venue_isolation on tip_shares to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on tip_shares to app_rw;
select audit_table('tip_shares');

-- Shares are written while their pool is still open, as it closes: a closed or exported pool never changes.
create or replace function tip_shares_open_pool() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if (select status from tip_pools where venue_id = new.venue_id and id = new.pool_id) <> 'open' then
    raise exception 'this pool is closed: its shares never change' using errcode = 'W4P01';
  end if;
  return new;
end;
$$;
create trigger tip_shares_open_pool before insert on tip_shares
  for each row execute function tip_shares_open_pool();
create trigger closed_night_guard before insert or update of business_date on tip_pools
  for each row execute function refuse_closed_night();
