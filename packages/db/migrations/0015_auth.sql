-- M1-19 · Sign in owners and managers with a passkey or an authenticator app.
-- auth_credentials, auth_sessions and auth_challenges are the tables the data
-- model implies but doesn't name. None has a venue: a person's passkey works at
-- every venue they belong to, so the wall here is the person (app_user_id()),
-- and the two lookups that arrive before anyone is signed in (email → user,
-- session token → session) run as app_definer, like resolve_device.
set lock_timeout = '5s';

-- Two-step sign-in can't be turned off for owners and managers (spec 02).
create or replace function require_mfa_for_managers() returns trigger
language plpgsql
as $$
begin
  if new.role in ('owner', 'manager') then
    update users set mfa_required = true where id = new.user_id and mfa_required = false;
  end if;
  return new;
end $$;
create trigger require_mfa after insert or update of role on memberships
  for each row execute function require_mfa_for_managers();

-- The resolver functions below read users as app_definer, which had no policy on users until now.
create policy definer_read on users for select to app_definer using (true);

-- The one-time backfill runs as the audited migration role, which sees the two tables through its own policies.
grant select, update on users to app_migrator;
grant select on memberships to app_migrator;
create policy migrator_all on users to app_migrator using (true) with check (true);
create policy migrator_read on memberships for select to app_migrator using (true);
set role app_migrator;
update users set mfa_required = true
  where mfa_required = false
    and id in (select user_id from memberships where role in ('owner', 'manager'));
reset role;

create table auth_credentials (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id),
  kind           text not null check (kind in ('passkey', 'totp')),
  name           text,                                   -- "iPhone", "Authenticator app": what the person called it
  credential_id  text,                                   -- passkey: base64url credential id
  public_key     text,                                   -- passkey: base64url COSE public key
  sign_count     bigint not null default 0,              -- passkey: the authenticator's counter, refused when it goes backwards
  transports     jsonb,                                  -- passkey: the transports the browser reported
  secret_enc     text,                                   -- totp: the shared secret, AES-256-GCM under AUTH_SECRET_KEY
  totp_last_step bigint,                                 -- totp: the last 30-second step accepted, so a code works once
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  check ((kind = 'passkey' and credential_id is not null and public_key is not null and secret_enc is null)
      or (kind = 'totp' and secret_enc is not null and credential_id is null))
);
create unique index auth_credentials_credential_id_key on auth_credentials (credential_id) where credential_id is not null;
create index auth_credentials_user_idx on auth_credentials (user_id) where revoked_at is null;
alter table auth_credentials enable row level security;
alter table auth_credentials force row level security;
create policy own_credentials on auth_credentials to app_rw
  using (user_id = app_user_id())
  with check (user_id = app_user_id());
create policy definer_all on auth_credentials to app_definer using (true) with check (true);
grant select, insert, update on auth_credentials to app_rw;
grant select on auth_credentials to app_definer;
select audit_table('auth_credentials');

create table auth_sessions (
  id            uuid primary key default gen_random_uuid(),
  principal     text not null check (principal in ('owner_manager', 'staff')),
  user_id       uuid not null references users (id),
  membership_id uuid,                                    -- a PIN or badge session's membership (M1-24, M1-25)
  device_id     uuid,                                    -- the shared screen it was opened on (M1-24, M1-25)
  assurance     text not null check (assurance in ('passkey', 'authenticator', 'pin', 'badge')),
  client        text not null check (client in ('web', 'desktop', 'phone', 'shared')),
  token_hash    text not null unique,                    -- sha256 of the cookie or bearer token
  started_at    timestamptz not null,
  last_seen_at  timestamptz not null,
  expires_at    timestamptz not null,
  ended_at      timestamptz,
  end_reason    text check (end_reason in ('signed_out', 'idle', 'expired', 'revoked', 'replaced'))
);
create index auth_sessions_user_idx on auth_sessions (user_id) where ended_at is null;
alter table auth_sessions enable row level security;
alter table auth_sessions force row level security;
create policy own_sessions on auth_sessions to app_rw
  using (user_id = app_user_id())
  with check (user_id = app_user_id());
create policy definer_all on auth_sessions to app_definer using (true) with check (true);
grant select, insert, update on auth_sessions to app_rw;
grant select, update on auth_sessions to app_definer;

-- One row per ceremony in flight: a passkey challenge, an emailed code, a
-- pending authenticator secret or a step-up token. Used once, then kept
-- briefly for the attempt count.
create table auth_challenges (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users (id),
  purpose         text not null check (purpose in ('login_passkey', 'login_email', 'enroll_email', 'enroll_passkey', 'enroll_totp', 'step_up', 'step_up_token')),
  challenge       text,                                  -- passkey challenge (base64url) or the step-up token's sha256
  code_hash       text,                                  -- sha256 of an emailed code
  secret_enc      text,                                  -- a pending authenticator secret, encrypted
  session_id      uuid references auth_sessions (id),    -- a step-up belongs to one session
  attempts        int not null default 0,
  created_at      timestamptz not null,
  expires_at      timestamptz not null,
  used_at         timestamptz
);
create index auth_challenges_user_idx on auth_challenges (user_id, purpose) where used_at is null;
alter table auth_challenges enable row level security;
alter table auth_challenges force row level security;
create policy own_challenges on auth_challenges to app_rw
  using (user_id = app_user_id())
  with check (user_id = app_user_id());
grant select, insert, update on auth_challenges to app_rw;

-- The email names the account. Only people with an active owner or manager
-- membership sign in this way; anyone else gets no row, the same as an unknown
-- address. The venue named is the first active one, for the email's wording.
create or replace function auth_user_by_email(p_email text)
returns table (user_id uuid, name text, locale text, venue_id uuid, venue_name text, mfa_required boolean)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select u.id, u.name, m.locale, v.id, v.name, u.mfa_required
  from users u
  join memberships m on m.user_id = u.id and m.status = 'active' and m.role in ('owner', 'manager')
  join venues v on v.id = m.venue_id
  where lower(u.email) = lower(p_email)
  order by m.created_at
  limit 1
$$;
alter function auth_user_by_email(text) owner to app_definer;
revoke all on function auth_user_by_email(text) from public;
grant execute on function auth_user_by_email(text) to app_rw;

-- A session token, hashed, to the person behind it and every active
-- membership they hold. Sessions lock after p_idle without a request and end
-- at p_max after they started (spec 02: 30 minutes and 12 hours); the clock
-- is the caller's, so tests and staging run on the simulated one. A live
-- session's last_seen_at moves forward here.
create or replace function auth_resolve_session(p_token_hash text, p_now timestamptz, p_idle interval, p_max interval)
returns table (session_id uuid, state text, user_id uuid, user_name text, assurance text, expires_at timestamptz,
               venue_id uuid, membership_id uuid, role text)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  s auth_sessions%rowtype;
  v_state text;
begin
  select * into s from auth_sessions where token_hash = p_token_hash for update;
  if not found then
    return;
  end if;
  if s.ended_at is not null then
    v_state := case when s.end_reason = 'idle' then 'locked' when s.end_reason = 'expired' then 'expired' else 'ended' end;
  elsif p_now >= s.expires_at or p_now >= s.started_at + p_max then
    update auth_sessions set ended_at = p_now, end_reason = 'expired' where id = s.id;
    v_state := 'expired';
  elsif p_now >= s.last_seen_at + p_idle then
    update auth_sessions set ended_at = p_now, end_reason = 'idle' where id = s.id;
    v_state := 'locked';
  else
    if p_now > s.last_seen_at then
      update auth_sessions set last_seen_at = p_now where id = s.id;
    end if;
    v_state := 'ok';
  end if;
  return query
    select s.id, v_state, s.user_id, u.name, s.assurance, least(s.expires_at, s.started_at + p_max),
           m.venue_id, m.id, m.role
    from users u
    left join memberships m on m.user_id = u.id and m.status = 'active'
    where u.id = s.user_id;
end $$;
alter function auth_resolve_session(text, timestamptz, interval, interval) owner to app_definer;
revoke all on function auth_resolve_session(text, timestamptz, interval, interval) from public;
grant execute on function auth_resolve_session(text, timestamptz, interval, interval) to app_rw;
