-- M1-35 · The Console: our own staff, their FIDO2 security keys, sessions and
-- the single sign-on handshake. Platform tables: no venue_id, no wall (the
-- Console is ours, not a venue's). Every Console action on a venue's rows is
-- audited by the venue table's own trigger with the staff member's id as actor.
set lock_timeout = '5s';

create table console_staff (
  id          uuid primary key default gen_random_uuid(),
  sso_subject text unique,                      -- the identity provider's subject, linked on first sign-in
  name        text not null,
  email       text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index console_staff_email_idx on console_staff (lower(email));
grant select, insert, update on console_staff to app_rw;

-- FIDO2 security keys only: the API refuses a platform authenticator at enrolment.
create table console_credentials (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references console_staff (id),
  credential_id text not null unique,
  public_key    text not null,
  sign_count    integer not null default 0,
  transports    text[],
  name          text,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create index console_credentials_staff_idx on console_credentials (staff_id) where revoked_at is null;
grant select, insert, update on console_credentials to app_rw;

create table console_sessions (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references console_staff (id),
  token_hash   text not null unique,
  started_at   timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at   timestamptz not null,
  ended_at     timestamptz
);
create index console_sessions_staff_idx on console_sessions (staff_id) where ended_at is null;
grant select, insert, update on console_sessions to app_rw;

-- One row per WebAuthn ceremony (register or sign in), used once.
create table console_challenges (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references console_staff (id),
  purpose    text not null check (purpose in ('register', 'login')),
  challenge  text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index console_challenges_staff_idx on console_challenges (staff_id, purpose) where used_at is null;
grant select, insert, update on console_challenges to app_rw;

-- The OpenID Connect handshake: state and PKCE verifier between redirect and callback.
create table console_sso_states (
  id         uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  verifier   text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
grant select, insert, update on console_sso_states to app_rw;
