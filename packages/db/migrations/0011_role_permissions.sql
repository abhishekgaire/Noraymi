-- 0011 · role_permissions (spec 02 · Roles; spec 04 · role_permissions; M1-14):
-- a venue's changes to the default permission table, which lives in
-- packages/shared. A row overrides one (role, action); no row means the default.
set lock_timeout = '5s';

create table role_permissions (
  venue_id       uuid not null references venues (id),
  role           text not null check (role in ('owner', 'manager', 'bartender', 'front_desk', 'staff')),
  action         text not null,
  allowed        boolean not null,
  needs_approval boolean not null default false,
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  primary key (venue_id, role, action)
);
alter table role_permissions enable row level security;
alter table role_permissions force row level security;
create policy venue_isolation on role_permissions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on role_permissions to app_rw;
select audit_table('role_permissions');
