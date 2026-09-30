-- 0002 · tenancy: organizations, venues, users, memberships, the database
-- roles and the venue walls (spec 02 · The hierarchy, The database walls;
-- spec 04 · Venue, people and platform; spec 13 · Capacity).
set lock_timeout = '5s';

-- Roles are cluster-wide, so create them only when missing.
--   app_rw        what the API connects as: no BYPASSRLS, no delete, 5-second limits
--   app_definer   can't log in; owns the SECURITY DEFINER resolver functions
--   app_migrator  the audited migration role that batched backfills run as
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rw') then
    create role app_rw nologin nobypassrls noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_definer') then
    create role app_definer nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_migrator') then
    create role app_migrator nologin nobypassrls;
  end if;
end $$;

alter role app_rw set statement_timeout = '5s';
alter role app_rw set idle_in_transaction_session_timeout = '5s';

-- The table owner may act as each role: tests and the CLI use "set role".
grant app_rw to current_user;
grant app_definer to current_user;
grant app_migrator to current_user;
grant usage on schema public to app_rw, app_definer, app_migrator;

-- The request's settings. Reading the venue when it isn't set is an error,
-- never "everything".
create or replace function app_venue_id() returns uuid
language plpgsql stable
as $$
declare v text := current_setting('app.venue_id', true);
begin
  if v is null or v = '' then
    raise exception 'app.venue_id is not set for this transaction' using errcode = '28000';
  end if;
  return v::uuid;
end $$;

create or replace function app_user_id() returns uuid
language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- True only inside a read-only transaction an owner-report route marked app.scope = 'org'.
create or replace function app_org_scope() returns boolean
language sql stable
as $$
  select current_setting('transaction_read_only', true) = 'on'
     and current_setting('app.scope', true) = 'org'
$$;

create table organizations (
  id                  uuid primary key default gen_random_uuid(),
  legal_name          text not null,
  stripe_account_id   text,
  billing_customer_id text,
  created_at          timestamptz not null default now()
);

create table venues (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id),
  name               text not null,
  slug               text not null unique,
  address            jsonb,
  time_zone          text not null default 'America/New_York',
  day_cutover        time not null default '06:00',
  rule_pack_id       text,                       -- rule_packs arrive in M1-10
  stripe_location_id text,
  created_at         timestamptz not null default now()
);

create table users (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text,
  phone_e164   text,
  mfa_required boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index users_email_key on users (lower(email)) where email is not null;

create table memberships (
  id                 uuid primary key default gen_random_uuid(),
  venue_id           uuid not null references venues (id),
  user_id            uuid not null references users (id),
  role               text not null check (role in ('owner', 'manager', 'bartender', 'front_desk', 'staff')),
  status             text not null default 'invited' check (status in ('invited', 'active', 'deactivated')),
  pin_verifier       text,
  pin_digits         smallint check (pin_digits in (4, 6)),
  locale             text not null default 'en' check (locale in ('en', 'es')),
  tip_eligible       boolean not null default true,
  occupation_code    text,
  eligibility_set_by uuid,
  eligibility_set_at timestamptz,
  training           boolean not null default false,
  deactivated_at     timestamptz,
  created_at         timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, user_id)
);

-- Owned by the no-login role, with a pinned search_path: the one door through
-- the wall, and it returns only ids (spec 02 · Requests that arrive without a venue).
create or replace function owner_venues() returns uuid[]
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(venue_id), '{}')
  from memberships
  where user_id = app_user_id() and role = 'owner' and status = 'active'
$$;
alter function owner_venues() owner to app_definer;
revoke all on function owner_venues() from public;
grant execute on function owner_venues() to app_rw;

create or replace function current_org_id() returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select org_id from venues where id = app_venue_id()
$$;
alter function current_org_id() owner to app_definer;
revoke all on function current_org_id() from public;
grant execute on function current_org_id() to app_rw;

-- The walls. Each policy names the role it's for: permissive policies are
-- OR-ed per role, so a policy for everyone would let the app's policy fire
-- (and raise) inside the definer functions too.
alter table memberships enable row level security;
alter table memberships force row level security;
create policy venue_isolation on memberships to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
-- The definer functions read across venues to answer "which venues does this owner have".
create policy definer_read on memberships for select to app_definer using (true);

alter table venues enable row level security;
alter table venues force row level security;
-- In org scope this policy steps aside so org_read alone decides; otherwise a
-- missing venue still errors.
create policy venue_self on venues to app_rw
  using (case when app_org_scope() then false else id = app_venue_id() end)
  with check (id = app_venue_id());
-- Owner reports list the organization's venues: read-only, org scope, active owner.
create policy org_read on venues for select to app_rw
  using (app_org_scope() and id = any (owner_venues()));
create policy definer_read on venues for select to app_definer using (true);

alter table organizations enable row level security;
alter table organizations force row level security;
create policy venue_org on organizations to app_rw
  using (id = current_org_id());

alter table users enable row level security;
alter table users force row level security;
-- A user sees themselves and the members of the current venue.
create policy users_visible on users to app_rw
  using (
    id = app_user_id()
    or exists (select 1 from memberships m where m.user_id = users.id and m.venue_id = app_venue_id())
  )
  with check (true);

-- What the app may do. Never delete, truncate, references or trigger.
grant select on organizations, venues to app_rw;
grant select, insert, update on users, memberships to app_rw;
grant select on organizations, venues, users, memberships to app_definer;
