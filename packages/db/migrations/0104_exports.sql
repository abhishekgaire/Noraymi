-- The nightly accounting journal and Export for QuickBooks (M7-15; Money
-- rules 16; spec 08 · Reports and exports). Each night's journal is posted at
-- the close from the same lines as the Z report and kept here with its file;
-- `night_closes.export_id` points at it. Emailing it records when and to whom.
set lock_timeout = '5s';

create table exports (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  kind          text not null check (kind in ('accounting')),
  business_date date not null,
  journals      jsonb not null,
  file          text not null,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  emailed_at    timestamptz,
  emailed_to    text[],
  unique (venue_id, id),
  unique (venue_id, kind, business_date)
);
alter table exports enable row level security;
alter table exports force row level security;
create policy venue_isolation on exports to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on exports to app_rw;
grant update (emailed_at, emailed_to) on exports to app_rw;
select audit_table('exports');
create trigger closed_night_guard before insert or update of business_date on exports
  for each row execute function refuse_closed_night();
