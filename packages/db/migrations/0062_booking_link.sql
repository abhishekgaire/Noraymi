-- The guest's booking link (M4-16; screens N5): `resolve_booking_link` finds
-- the venue from the link token's hash, as the pay links' function does, so
-- the bill behind Marcus's booking link reads inside his venue's wall. M5
-- issues the tokens when a booking is made; M4 reads them.
set lock_timeout = '5s';

grant select (venue_id, manage_token_hash) on bookings to app_definer;
create policy definer_read on bookings for select to app_definer using (true);

create or replace function resolve_booking_link(p_token_hash text) returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select venue_id from bookings where manage_token_hash = p_token_hash
$$;
alter function resolve_booking_link(text) owner to app_definer;
revoke all on function resolve_booking_link(text) from public;
grant execute on function resolve_booking_link(text) to app_rw;
