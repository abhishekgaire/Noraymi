-- 0008 · venue_settings (spec 03 · Settings; M1-11): one typed key per topic,
-- append-only versions. starts_on is the business date a version takes
-- effect (the next one for the drawer model, the tip-pool method and the bar
-- POS layouts; today's for everything else). Old versions are the change log.
set lock_timeout = '5s';

create table venue_settings (
  venue_id  uuid not null references venues (id),
  key       text not null,
  version   int not null,
  value     jsonb not null,
  saved_by  uuid,
  saved_at  timestamptz not null default now(),
  starts_on date not null,
  primary key (venue_id, key, version)
);
create index venue_settings_lookup_idx on venue_settings (venue_id, key, starts_on, version desc);

alter table venue_settings enable row level security;
alter table venue_settings force row level security;
create policy venue_isolation on venue_settings to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
-- Append-only: the app inserts and reads, never updates or deletes.
grant select, insert on venue_settings to app_rw;

-- Since 0004's DDL event trigger attaches the truncate alert to every new
-- table itself, audit_table() now adds only what's missing.
create or replace function audit_table(p_table regclass) returns void
language plpgsql
as $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = p_table and tgname = 'audit_row') then
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function audit_row()', p_table);
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = p_table and tgname = 'truncate_alert') then
    execute format('create trigger truncate_alert after truncate on %s for each statement execute function truncate_alert()', p_table);
  end if;
end $$;

select audit_table('venue_settings');
