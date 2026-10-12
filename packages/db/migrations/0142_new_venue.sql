-- New venue from the Console (O-01; spec 17 · Who runs it, D113). Our staff make
-- the organization (or pick one already there), the venue and its owner's
-- invited membership in one go; nothing else is filled in. Making them goes
-- through the definer door below because app_rw can't insert organizations or
-- venues. The door checks that the caller (app.user_id) is an active Console
-- staff member, so a venue's own principals can never use it.
--
-- venue_onboarding keeps who made the venue and why (the audit log records the
-- actor on every row; the reason lives here). An invite now says when Send
-- again replaced it, so the link can be refused with that reason.
set lock_timeout = '5s';

alter table invites add column replaced_at timestamptz;

create table venue_onboarding (
  venue_id    uuid primary key references venues (id),
  created_by  uuid not null references console_staff (id),
  reason      text not null check (length(reason) between 3 and 500),
  created_at  timestamptz not null default now()
);
alter table venue_onboarding enable row level security;
alter table venue_onboarding force row level security;
create policy venue_isolation on venue_onboarding to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on venue_onboarding to app_rw;
select audit_table('venue_onboarding');

drop function auth_invite_by_token(text);
create or replace function auth_invite_by_token(p_token_hash text)
returns table (
  invite_id uuid, venue_id uuid, venue_name text, membership_id uuid, user_id uuid,
  name text, email text, role text, pin_digits smallint, locale text,
  phone_verified boolean, expires_at timestamptz, used_at timestamptz, replaced_at timestamptz
)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select i.id, v.id, v.name, m.id, u.id, u.name, u.email, m.role, m.pin_digits, m.locale,
         u.phone_verified_at is not null, i.expires_at, i.used_at, i.replaced_at
  from invites i
  join memberships m on m.id = i.membership_id
  join venues v on v.id = m.venue_id
  join users u on u.id = m.user_id
  where i.token_hash = p_token_hash
$$;
alter function auth_invite_by_token(text) owner to app_definer;
revoke all on function auth_invite_by_token(text) from public;
grant execute on function auth_invite_by_token(text) to app_rw;

-- The organizations the New venue form can pick from (a second venue of the same owner).
create or replace function console_organizations()
returns table (id uuid, legal_name text, stripe_account_id text, venues bigint)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select o.id, o.legal_name, o.stripe_account_id,
         (select count(*) from venues v where v.org_id = o.id)
  from organizations o
  where exists (select 1 from console_staff s where s.id = app_user_id() and s.active)
  order by o.legal_name
$$;
alter function console_organizations() owner to app_definer;
revoke all on function console_organizations() from public;
grant execute on function console_organizations() to app_rw;

-- Makes the organization (when p_org_id is null), the venue with the given id,
-- and finds or makes the owner's user by email. Called inside a transaction
-- whose app.venue_id is the new venue's id, so every audit row lands on it.
create or replace function console_create_venue(
  p_venue_id uuid, p_org_id uuid, p_legal_name text, p_name text, p_slug text,
  p_rule_pack_id text, p_owner_name text, p_owner_email text
) returns table (org_id uuid, user_id uuid)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_org  uuid := p_org_id;
  v_user uuid;
begin
  if not exists (select 1 from console_staff s where s.id = app_user_id() and s.active) then
    raise exception 'only Console staff can make a venue' using errcode = '42501';
  end if;
  if exists (select 1 from venues where slug = p_slug) then
    raise exception 'slug taken' using errcode = '23505', constraint = 'venues_slug_key';
  end if;
  if v_org is null then
    insert into organizations (legal_name) values (p_legal_name) returning id into v_org;
  elsif not exists (select 1 from organizations where id = v_org) then
    raise exception 'no such organization' using errcode = 'P0002';
  end if;
  insert into venues (id, org_id, name, slug, time_zone, day_cutover, rule_pack_id)
    values (p_venue_id, v_org, p_name, p_slug, 'America/New_York', '06:00', p_rule_pack_id);
  select u.id into v_user from users u where lower(u.email) = lower(p_owner_email);
  if v_user is null then
    insert into users (name, email) values (p_owner_name, p_owner_email) returning id into v_user;
  end if;
  return query select v_org, v_user;
end $$;
grant select on console_staff to app_definer;
grant insert on organizations, venues, users to app_definer;
create policy definer_insert on organizations for insert to app_definer with check (true);
create policy definer_insert on venues for insert to app_definer with check (true);
create policy definer_insert on users for insert to app_definer with check (true);
alter function console_create_venue(uuid, uuid, text, text, text, text, text, text) owner to app_definer;
revoke all on function console_create_venue(uuid, uuid, text, text, text, text, text, text) from public;
grant execute on function console_create_venue(uuid, uuid, text, text, text, text, text, text) to app_rw;
