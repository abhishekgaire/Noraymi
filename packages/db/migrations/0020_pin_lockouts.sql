-- M1-24 · PIN sign-in with lockouts.
-- pin_lockouts counts wrong PINs per person and device (spec 04): five lock
-- that person on that device for 1 minute, the next five for 5, then 15 each
-- time; a right PIN clears them. A device counts wrong tries in a row across
-- any names: ten pause PIN sign-in there until a manager pairs it again (spec
-- 02 · PINs). A PIN or badge session belongs to one membership, so the session
-- lookup now returns only that membership, plus the session's own membership
-- and device for the "ask for the PIN again" check.
set lock_timeout = '5s';

create table pin_lockouts (
  venue_id      uuid not null references venues (id),
  membership_id uuid not null,
  device_id     uuid not null,
  failures      int not null default 0,
  locked_until  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (venue_id, membership_id, device_id),
  foreign key (venue_id, membership_id) references memberships (venue_id, id),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);

alter table pin_lockouts enable row level security;
alter table pin_lockouts force row level security;
create policy venue_isolation on pin_lockouts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on pin_lockouts to app_rw;

alter table devices
  add column pin_failures  int not null default 0,   -- wrong PINs in a row, any name
  add column pin_paused_at timestamptz;              -- PIN sign-in paused here until paired again

drop function auth_resolve_session(text, timestamptz, interval, interval);
create function auth_resolve_session(p_token_hash text, p_now timestamptz, p_idle interval, p_max interval)
returns table (session_id uuid, state text, user_id uuid, user_name text, assurance text, expires_at timestamptz,
               venue_id uuid, membership_id uuid, role text, session_membership_id uuid, session_device_id uuid)
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
           m.venue_id, m.id, m.role, s.membership_id, s.device_id
    from users u
    left join memberships m on m.user_id = u.id and m.status = 'active'
      and (s.membership_id is null or m.id = s.membership_id)
    where u.id = s.user_id;
end $$;
alter function auth_resolve_session(text, timestamptz, interval, interval) owner to app_definer;
revoke all on function auth_resolve_session(text, timestamptz, interval, interval) from public;
grant execute on function auth_resolve_session(text, timestamptz, interval, interval) to app_rw;
