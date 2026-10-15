-- Can also open (P-10; spec 02 · Roles): the Admin sections the owner gives one person on top of
-- their role, in Admin → Team. One row per grant; taking a grant back stamps it (the app role never
-- deletes), so the record keeps who gave what and when, and the audit trigger records both. A
-- section is one of the grantable ones (packages/shared roles.ts · grantableAdminSections): never
-- Payments, Team or Console. Admin still needs a passkey; the API reads only live rows.
set lock_timeout = '5s';

create table admin_section_grants (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  membership_id uuid not null,
  section       text not null
    check (section in ('menu', 'hours', 'rooms', 'cashDrawers', 'alerts', 'licenses', 'barMode')),
  granted_by    uuid not null references users (id),
  granted_at    timestamptz not null,
  revoked_by    uuid references users (id),
  revoked_at    timestamptz,
  check ((revoked_at is null) = (revoked_by is null)),
  unique (venue_id, id),
  foreign key (venue_id, membership_id) references memberships (venue_id, id)
);
-- One live grant per person and section.
create unique index admin_section_grants_live on admin_section_grants (venue_id, membership_id, section)
  where revoked_at is null;
alter table admin_section_grants enable row level security;
alter table admin_section_grants force row level security;
create policy venue_isolation on admin_section_grants to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on admin_section_grants to app_rw;
grant update (revoked_by, revoked_at) on admin_section_grants to app_rw;
-- A one-venue restore (M8-20) needs the wall and the grants every venue table has.
create policy restore_wall on admin_section_grants to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on admin_section_grants to app_migrator;
select audit_table('admin_section_grants');

-- Admin needs a passkey, and a passkey sign-in is by email: a person with a live grant signs in the
-- way an owner or a manager does (email, then a passkey or an authenticator app). Their session
-- opens only the granted sections' routes; everything else follows their role.
create policy definer_read on admin_section_grants for select to app_definer using (true);
grant select on admin_section_grants to app_definer;

create or replace function auth_user_by_email(p_email text)
returns table (user_id uuid, name text, locale text, venue_id uuid, venue_name text, mfa_required boolean)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select u.id, u.name, m.locale, v.id, v.name, u.mfa_required
  from users u
  join memberships m on m.user_id = u.id and m.status = 'active'
   and (m.role in ('owner', 'manager')
        or exists (select 1 from admin_section_grants g
                    where g.venue_id = m.venue_id and g.membership_id = m.id and g.revoked_at is null))
  join venues v on v.id = m.venue_id
  where lower(u.email) = lower(p_email)
  order by m.created_at
  limit 1
$$;
alter function auth_user_by_email(text) owner to app_definer;

-- Two-step sign-in can't be turned off for anyone who can open Admin (spec 02): a grant turns it
-- on for its person, as an owner's or a manager's role does (require_mfa_for_managers).
create or replace function require_mfa_for_grants() returns trigger
language plpgsql
as $$
begin
  update users set mfa_required = true
   where mfa_required = false
     and id = (select m.user_id from memberships m
                where m.venue_id = new.venue_id and m.id = new.membership_id);
  return new;
end $$;
create trigger require_mfa after insert on admin_section_grants
  for each row execute function require_mfa_for_grants();
revoke all on function auth_user_by_email(text) from public;
grant execute on function auth_user_by_email(text) to app_rw;
