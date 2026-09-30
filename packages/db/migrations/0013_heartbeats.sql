-- 0013 · heartbeats and venue outages (spec 09 · Clocks, Heartbeats; M1-16).
-- One row per device, rewritten every 30 seconds by POST /v1/devices/heartbeat
-- and read by the quiet-device sweep. Never audited (0004 says so): the audit
-- log is for what people change, and 28 devices × 2,880 heartbeats a night
-- would bury it. The last-seen, clock and version columns move here from the
-- audited devices table, so a heartbeat can't write an audit row.
set lock_timeout = '5s';

create table device_heartbeats (
  device_id        uuid primary key,
  venue_id         uuid not null references venues (id),
  last_seen_at     timestamptz not null,   -- the venue's clock (the simulated one in staging), never the database's now()
  app_version      text,
  network          jsonb,                  -- as the device reports it: { "type": "wifi" | "ethernet" | "cellular", ... }
  clock_skew_ms    int,                    -- the device's clock minus the server's real clock at the last heartbeat
  offline_since    timestamptz,            -- set when the sweep raised device.offline or venue.offline; cleared by the next heartbeat
  clock_alerted_at timestamptz,            -- set when device.clock_skew was raised; cleared once the clock is back within the limit
  unique (venue_id, device_id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
alter table device_heartbeats enable row level security;
alter table device_heartbeats force row level security;
create policy venue_isolation on device_heartbeats to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_all on device_heartbeats to app_definer using (true) with check (true);
grant select, insert, update on device_heartbeats to app_rw;
-- No audit_table('device_heartbeats'): heartbeats never reach the audit log.

-- A venue-wide outage: one row per venue, offline_since set while every
-- device is quiet, so managers get one "venue offline" alert instead of one
-- per device. The first heartbeat back clears it and raises venue.online.
create table venue_outages (
  venue_id      uuid primary key references venues (id),
  offline_since timestamptz
);
alter table venue_outages enable row level security;
alter table venue_outages force row level security;
create policy venue_isolation on venue_outages to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_all on venue_outages to app_definer using (true) with check (true);
grant select, insert, update on venue_outages to app_rw;

-- These lived on devices (0012), where every signed request's last_seen_at
-- update became an audit row. Nothing has read them yet.
alter table devices
  drop column last_seen_at,
  drop column network,
  drop column clock_skew_ms,
  drop column app_version;

-- resolve_device no longer touches devices on every request: last seen is the
-- heartbeat's business.
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
  return query select d.venue_id, d.kind, d.public_key, d.revoked_at is not null, d.disabled_at is not null, inserted;
end $$;
alter function resolve_device(uuid, text, interval) owner to app_definer;
revoke all on function resolve_device(uuid, text, interval) from public;
grant execute on function resolve_device(uuid, text, interval) to app_rw;
