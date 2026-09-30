-- 0010 · venue_modules and venue_flags (spec 03 · Modules; M1-13).
set lock_timeout = '5s';

create table venue_modules (
  venue_id   uuid not null references venues (id),
  module_id  text not null,
  allowed    boolean not null default false,        -- the Console's allow-list, from the plan and add-ons
  state      text not null default 'off' check (state in ('on', 'stopping', 'off')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (venue_id, module_id)
);
alter table venue_modules enable row level security;
alter table venue_modules force row level security;
create policy venue_isolation on venue_modules to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on venue_modules to app_rw;
select audit_table('venue_modules');

-- Beta and rollout switches, separate from modules; our own test venue first in line.
create table venue_flags (
  venue_id uuid not null references venues (id),
  flag     text not null,
  "on"     boolean not null default false,
  set_by   text,
  set_at   timestamptz not null default now(),
  primary key (venue_id, flag)
);
alter table venue_flags enable row level security;
alter table venue_flags force row level security;
create policy venue_isolation on venue_flags to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on venue_flags to app_rw;
select audit_table('venue_flags');
