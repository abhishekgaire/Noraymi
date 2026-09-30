-- 0012 · devices, pairing codes and signature nonces (spec 02 · Shared device,
-- Room tablet; spec 04 · devices; spec 09 · Pairing; M1-15).
set lock_timeout = '5s';

create table devices (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid not null references venues (id),
  kind                 text not null check (kind in ('bar_computer', 'front_desk', 'room_tablet', 'reader', 'printer', 'nfc_reader', 'router', 'staff_phone', 'up_next_display', 'mic_outlet')),
  name                 text not null,
  public_key           jsonb,                       -- the device's WebCrypto public key (JWK); null for readers, printers, routers
  room_id              uuid,                        -- a tablet's room (rooms arrive in M2; the key is added then)
  user_id              uuid,                        -- a staff phone's person
  cash_drawer_id       uuid,                        -- M4
  network              jsonb,
  clock_skew_ms        int,
  app_version          text,
  consecutive_failures int not null default 0,
  training             boolean not null default false,
  last_seen_at         timestamptz,
  disabled_at          timestamptz,
  revoked_at           timestamptz,
  created_at           timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, user_id) references memberships (venue_id, user_id)
);
alter table devices enable row level security;
alter table devices force row level security;
create policy venue_isolation on devices to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_all on devices to app_definer using (true) with check (true);
grant select, insert, update on devices to app_rw;
grant select, update on devices to app_definer;
select audit_table('devices');

-- One-time pairing codes a manager makes in Admin → Printers & devices.
create table device_pairing_codes (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues (id),
  code_hash  text not null unique,                  -- sha256 of the code; the code itself is shown once
  kind       text not null,
  name       text not null,
  room_id    uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  device_id  uuid,
  unique (venue_id, id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
alter table device_pairing_codes enable row level security;
alter table device_pairing_codes force row level security;
create policy venue_isolation on device_pairing_codes to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_all on device_pairing_codes to app_definer using (true) with check (true);
grant select, insert on device_pairing_codes to app_rw;
grant select, insert, update on device_pairing_codes to app_definer;
grant select, insert on devices to app_definer;

-- Every signed request's nonce, kept for the replay window.
create table device_nonces (
  device_id uuid not null,
  nonce     text not null,
  seen_at   timestamptz not null default now(),
  primary key (device_id, nonce)
);
grant select, insert, delete on device_nonces to app_definer;

-- The claim: the code and the device's public key, from a request that has no
-- venue yet. Definer, pinned search_path, returns ids only (spec 02).
create or replace function claim_device(p_code_hash text, p_public_key jsonb)
returns table (device_id uuid, venue_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  c device_pairing_codes%rowtype;
  d uuid;
begin
  select * into c from device_pairing_codes where code_hash = p_code_hash for update;
  if not found or c.claimed_at is not null or c.expires_at < now() then
    return;
  end if;
  insert into devices (venue_id, kind, name, public_key, room_id)
    values (c.venue_id, c.kind, c.name, p_public_key, c.room_id) returning id into d;
  update device_pairing_codes set claimed_at = now(), device_id = d where id = c.id;
  return query select d, c.venue_id;
end $$;
alter function claim_device(text, jsonb) owner to app_definer;
revoke all on function claim_device(text, jsonb) from public;
grant execute on function claim_device(text, jsonb) to app_rw;

-- Finds the venue from a signed request: the device's venue, key and standing,
-- nothing else. Also records the nonce, so a replay within the window is
-- refused (replayed = false).
create or replace function resolve_device(p_device_id uuid, p_nonce text, p_window interval)
returns table (venue_id uuid, kind text, public_key jsonb, revoked boolean, disabled boolean, fresh_nonce boolean)
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  d devices%rowtype;
  inserted boolean := false;
begin
  select * into d from devices where id = p_device_id;
  if not found then
    return;
  end if;
  delete from device_nonces where device_id = p_device_id and seen_at < now() - p_window;
  insert into device_nonces (device_id, nonce) values (p_device_id, p_nonce) on conflict do nothing;
  inserted := found;
  update devices set last_seen_at = now() where id = p_device_id and inserted;
  return query select d.venue_id, d.kind, d.public_key, d.revoked_at is not null, d.disabled_at is not null, inserted;
end $$;
alter function resolve_device(uuid, text, interval) owner to app_definer;
revoke all on function resolve_device(uuid, text, interval) from public;
grant execute on function resolve_device(uuid, text, interval) to app_rw;
