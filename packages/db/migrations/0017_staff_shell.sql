-- M1-21 · The staff app shell.
-- auth_memberships_of answers "where does this person work, in which language,
-- on which clock" for the signed-in person before any venue is set: the shell
-- needs it to pick the venue, the language and the time zone in one call. It
-- reads across venues the way the other auth definer functions do (0015, 0016).
set lock_timeout = '5s';

create or replace function auth_memberships_of(p_user uuid)
returns table (membership_id uuid, venue_id uuid, venue_name text, time_zone text, day_cutover text, role text, locale text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select m.id, v.id, v.name, v.time_zone, to_char(v.day_cutover, 'HH24:MI'), m.role, m.locale
  from memberships m
  join venues v on v.id = m.venue_id
  where m.user_id = p_user and m.status = 'active'
  order by m.created_at
$$;
alter function auth_memberships_of(uuid) owner to app_definer;
revoke all on function auth_memberships_of(uuid) from public;
grant execute on function auth_memberships_of(uuid) to app_rw;
