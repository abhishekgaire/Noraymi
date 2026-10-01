-- M1-35 · The Console's venue list. app_rw sees a venue only inside that
-- venue's context, so the Console reads the list through one definer door,
-- like owner_venues() (0002): names and time zones only, nothing venue-owned.
set lock_timeout = '5s';

create or replace function console_venues()
returns table (id uuid, name text, slug text, time_zone text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select id, name, slug, time_zone from venues order by name
$$;
alter function console_venues() owner to app_definer;
revoke all on function console_venues() from public;
grant execute on function console_venues() to app_rw;
