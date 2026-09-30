-- M1-20 · Recovery codes and owner recovery.
-- recovery_codes is the table the data model implies but doesn't name: ten
-- single-use codes per owner, shown once at enrollment and stored hashed.
-- owner_recoveries records each recovery in flight: it starts with a code or
-- through a second owner, and is ready 48 hours later, with notice to every
-- manager sent at once. Neither table belongs to a venue (an owner may own
-- several), so the wall is the person, as for the other auth tables (0015).
set lock_timeout = '5s';

create table recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id),
  code_hash   text not null,                              -- sha256 of the code; the code itself is shown once and never stored
  created_at  timestamptz not null,
  used_at     timestamptz,                                -- a code works once
  revoked_at  timestamptz                                 -- a new set of codes retires the old one
);
create index recovery_codes_user_idx on recovery_codes (user_id) where used_at is null and revoked_at is null;
alter table recovery_codes enable row level security;
alter table recovery_codes force row level security;
create policy own_codes on recovery_codes to app_rw
  using (user_id = app_user_id())
  with check (user_id = app_user_id());
grant select, insert, update on recovery_codes to app_rw;

-- True when the caller (app.user_id) is an active owner at a venue where
-- p_user is also an active owner: a "second owner" in the spec's words.
create or replace function auth_co_owner(p_user uuid) returns boolean
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from memberships mine
    join memberships theirs on theirs.venue_id = mine.venue_id
    where mine.user_id = app_user_id() and mine.role = 'owner' and mine.status = 'active'
      and theirs.user_id = p_user and theirs.role = 'owner' and theirs.status = 'active'
      and theirs.user_id <> mine.user_id
  )
$$;
alter function auth_co_owner(uuid) owner to app_definer;
revoke all on function auth_co_owner(uuid) from public;
grant execute on function auth_co_owner(uuid) to app_rw;

create table owner_recoveries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id),     -- the owner getting back in
  method        text not null check (method in ('recovery_code', 'second_owner')),
  requested_by  uuid references users (id),              -- the second owner, on that path
  requested_at  timestamptz not null,
  ready_at      timestamptz not null,                    -- requested_at + 48 hours
  completed_at  timestamptz,                             -- when the owner enrolled a new sign-in method
  cancelled_at  timestamptz,
  cancelled_by  uuid references users (id),
  check (completed_at is null or cancelled_at is null)
);
create index owner_recoveries_open_idx on owner_recoveries (user_id)
  where completed_at is null and cancelled_at is null;
alter table owner_recoveries enable row level security;
alter table owner_recoveries force row level security;
-- The owner sees their own; a second owner at one of their venues sees it too, to start or cancel it.
create policy own_or_co_owner on owner_recoveries to app_rw
  using (user_id = app_user_id() or auth_co_owner(user_id))
  with check (user_id = app_user_id() or auth_co_owner(user_id));
grant select, insert, update on owner_recoveries to app_rw;

-- Who to tell when an owner's recovery starts: every active owner and manager
-- at every venue where p_user is an active owner, with the venue's name and
-- clock for the email's wording. No rows means p_user isn't an owner anywhere.
create or replace function auth_owner_recovery_contacts(p_user uuid)
returns table (venue_id uuid, venue_name text, time_zone text, user_id uuid, name text, email text, role text, locale text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select v.id, v.name, v.time_zone, u.id, u.name, u.email, m.role, m.locale
  from memberships o
  join venues v on v.id = o.venue_id
  join memberships m on m.venue_id = v.id and m.status = 'active' and m.role in ('owner', 'manager')
  join users u on u.id = m.user_id
  where o.user_id = p_user and o.role = 'owner' and o.status = 'active'
  order by v.name, u.name
$$;
alter function auth_owner_recovery_contacts(uuid) owner to app_definer;
revoke all on function auth_owner_recovery_contacts(uuid) from public;
grant execute on function auth_owner_recovery_contacts(uuid) to app_rw;
