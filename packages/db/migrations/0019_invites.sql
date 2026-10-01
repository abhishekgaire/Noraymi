-- M1-23 · Invites, phone codes and PINs.
-- invites and phone_codes are the tables the data model implies but doesn't
-- name. An invite is a single-use link to one membership, stored hashed; a
-- phone code confirms the person's number once. The PIN verifier lives on the
-- membership (0002). The invite link opens with no session, so one definer
-- function resolves a token across venues, as the auth lookups do (0015).
set lock_timeout = '5s';

alter table users add column phone_verified_at timestamptz;

create table invites (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  membership_id uuid not null,
  token_hash    text not null unique,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, membership_id) references memberships (venue_id, id)
);
create index invites_open_idx on invites (venue_id, membership_id) where used_at is null;

alter table invites enable row level security;
alter table invites force row level security;
create policy venue_isolation on invites to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_read on invites for select to app_definer using (true);
grant select, insert, update on invites to app_rw;
grant select on invites to app_definer;

create table phone_codes (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  membership_id uuid not null,
  phone_e164    text not null,
  code_hash     text not null,
  attempts      int not null default 0,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  verified_at   timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, membership_id) references memberships (venue_id, id)
);
create index phone_codes_open_idx on phone_codes (venue_id, membership_id) where verified_at is null;

alter table phone_codes enable row level security;
alter table phone_codes force row level security;
create policy venue_isolation on phone_codes to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on phone_codes to app_rw;

-- The invite behind a token, before any venue is set.
create or replace function auth_invite_by_token(p_token_hash text)
returns table (
  invite_id uuid, venue_id uuid, venue_name text, membership_id uuid, user_id uuid,
  name text, email text, role text, pin_digits smallint, locale text,
  phone_verified boolean, expires_at timestamptz, used_at timestamptz
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select i.id, v.id, v.name, m.id, u.id, u.name, u.email, m.role, m.pin_digits, m.locale,
         u.phone_verified_at is not null, i.expires_at, i.used_at
  from invites i
  join memberships m on m.id = i.membership_id
  join venues v on v.id = m.venue_id
  join users u on u.id = m.user_id
  where i.token_hash = p_token_hash
$$;
alter function auth_invite_by_token(text) owner to app_definer;
revoke all on function auth_invite_by_token(text) from public;
grant execute on function auth_invite_by_token(text) to app_rw;
