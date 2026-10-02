-- Network printers (M3-13; spec 09 · Tickets; spec 02 · Printer). A printer
-- is a device of kind printer with its own credential: it polls with its
-- device id and a secret (HTTP Basic), and only the secret's hash is kept.
-- station routes tickets to it; protocol is Star CloudPRNT, Epson Server
-- Direct Print, or a USB printer on a desktop-app host (M3-14). A print job
-- not confirmed within three polls (15 seconds) is marked failed.
set lock_timeout = '5s';

alter table devices add column station text;
alter table devices add column protocol text check (protocol in ('cloudprnt', 'server_direct', 'usb'));
alter table devices add column secret_hash text;
alter table print_jobs add column sent_at timestamptz;
alter table print_jobs add column failed_at timestamptz;
alter table print_jobs add column failure text;

-- A printer's poll, before any venue is set: the venue and the printer's station and protocol.
create or replace function resolve_printer(p_device_id uuid, p_secret_hash text)
returns table (venue_id uuid, station text, protocol text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select d.venue_id, coalesce(d.station, 'bar'), coalesce(d.protocol, 'cloudprnt') from devices d
   where d.id = p_device_id and d.kind = 'printer' and d.revoked_at is null and d.disabled_at is null
     and d.secret_hash is not null and d.secret_hash = p_secret_hash
$$;
alter function resolve_printer(uuid, text) owner to app_definer;
revoke all on function resolve_printer(uuid, text) from public;
grant execute on function resolve_printer(uuid, text) to app_rw;

-- A test ticket from Admin belongs to no order or check; a job still never belongs to both.
alter table print_jobs drop constraint print_jobs_check;
alter table print_jobs add constraint print_jobs_one_owner check (order_id is null or check_id is null) not valid;
alter table print_jobs validate constraint print_jobs_one_owner;
