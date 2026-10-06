-- Reports before go-live (M7-18; spec 08 · Reports and exports): the nightly
-- totals M9 loads from the old system, so the sales report's weeks and
-- trends reach back past the first live night. Read-only to the app.
set lock_timeout = '5s';

create table legacy_nightly_totals (
  venue_id         uuid not null references venues (id),
  business_date    date not null,
  net_sales_cents  bigint not null,
  rooms_cents      bigint not null default 0,
  bar_cents        bigint not null default 0,
  primary key (venue_id, business_date)
);
alter table legacy_nightly_totals enable row level security;
alter table legacy_nightly_totals force row level security;
create policy venue_isolation on legacy_nightly_totals to app_rw
  using (case when app_org_scope() then false else venue_id = app_venue_id() end)
  with check (venue_id = app_venue_id());
create policy org_read on legacy_nightly_totals for select to app_rw
  using (app_org_scope() and venue_id = any (owner_venues()));
grant select on legacy_nightly_totals to app_rw;
select audit_table('legacy_nightly_totals');
create trigger closed_night_guard before insert or update of business_date on legacy_nightly_totals
  for each row execute function refuse_closed_night();
