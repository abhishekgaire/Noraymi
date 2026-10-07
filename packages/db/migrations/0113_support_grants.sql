-- Support grants (M8-10; spec 02 · Support access; spec 12 · 7; spec 04 ·
-- support_grants, audit_log.support_grant_id; screens N39, Console notes 2, 3).
-- Our staff ask in the Console with a reason, a scope (read, or write for one
-- named action) and a length of up to 60 minutes. Only the venue's owner
-- approves, in Admin → Console, and either side can end it. While it's open,
-- the support session reads through masked views as app_support inside a
-- read-only transaction; an approved write spends its one action once
-- (action_used_at), and every audit row written under it names the grant.
set lock_timeout = '5s';

create table support_grants (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  staff_id        uuid not null references console_staff (id),   -- who works under the grant
  requested_by    uuid not null references console_staff (id),
  reason          text not null check (length(reason) between 3 and 500),
  scope           text not null check (scope in ('read', 'write')),
  action          text check (action ~ '^[a-z][a-z_]{1,40}$'),     -- the one named action of a write grant
  minutes         smallint not null check (minutes between 1 and 60),
  status          text not null default 'requested'
                    check (status in ('requested', 'approved', 'declined', 'revoked')),
  approved_by     uuid,                                          -- the owner (users.id) who approved or declined
  second_approver uuid,                                          -- M8-11: the emergency path's second approver on our side
  requested_at    timestamptz not null,
  decided_at      timestamptz,
  starts_at       timestamptz,
  ends_at         timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid,
  revoked_side    text check (revoked_side in ('venue', 'support')),
  action_used_at  timestamptz,
  unique (venue_id, id),
  check ((scope = 'write') = (action is not null)),
  check (ends_at is null or (starts_at is not null and ends_at > starts_at
                             and ends_at <= starts_at + interval '60 minutes')),
  check (status <> 'approved' or (starts_at is not null and ends_at is not null and approved_by is not null)),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (action_used_at is null or scope = 'write')
);
create index support_grants_venue_idx on support_grants (venue_id, requested_at desc);
alter table support_grants enable row level security;
alter table support_grants force row level security;
create policy venue_isolation on support_grants to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on support_grants to app_rw;
grant update (status, approved_by, decided_at, starts_at, ends_at, revoked_at, revoked_by, revoked_side,
              action_used_at) on support_grants to app_rw;
select audit_table('support_grants');

-- The Console's authenticator finds a grant's venue without a venue set: the
-- grant id and the staff member in, the venue out, only while it's open.
create policy definer_read on support_grants for select to app_definer using (true);
grant select on support_grants to app_definer;
create or replace function resolve_support_grant(p_grant uuid, p_staff uuid, p_at timestamptz)
returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select venue_id from support_grants
   where id = p_grant and staff_id = p_staff and status = 'approved'
     and starts_at <= p_at and ends_at > p_at
$$;
alter function resolve_support_grant(uuid, uuid, timestamptz) owner to app_definer;
revoke all on function resolve_support_grant(uuid, uuid, timestamptz) from public;
grant execute on function resolve_support_grant(uuid, uuid, timestamptz) to app_rw;

-- The masked views. app_masked owns them and reads the venue's rows behind
-- the same wall; app_support (what a support transaction switches to) may
-- read the views and nothing else: no guests table, no phone numbers or
-- emails, no id_checks at all.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_masked') then
    create role app_masked nologin nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_support') then
    create role app_support nologin nobypassrls noinherit;
  end if;
end $$;
grant app_masked to current_user;
grant app_support to current_user;
grant app_support to app_rw;          -- only so a support transaction can "set local role app_support"
grant usage on schema public to app_masked, app_support;

create policy masked_read on guests for select to app_masked using (venue_id = app_venue_id());
create policy masked_read on checks for select to app_masked using (venue_id = app_venue_id());
create policy masked_read on print_jobs for select to app_masked using (venue_id = app_venue_id());
grant select on guests, checks, print_jobs to app_masked;

create view support_guests as
  select id, venue_id, name,
         case when phone_e164 is null then null else '••• ••• ' || right(phone_e164, 2) end as phone_masked,
         email is not null as has_email,
         locale, last_seen_at, erased_at, created_at
    from guests
   where venue_id = app_venue_id();
create view support_checks as
  select id, venue_id, number, kind, business_date, status, training, opened_at, paid_at
    from checks
   where venue_id = app_venue_id();
create view support_print_jobs as
  select id, venue_id, kind, station, status, reprint_of, reprint_n, created_at, sent_at, failed_at, confirmed_at
    from print_jobs
   where venue_id = app_venue_id();
alter view support_guests owner to app_masked;
alter view support_checks owner to app_masked;
alter view support_print_jobs owner to app_masked;
grant select on support_guests, support_checks, support_print_jobs to app_support;

-- Audit rows name the support grant from app.support_grant_id. The hash
-- covers it whenever it's set, so earlier rows verify exactly as before.
create or replace function audit_row() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_old       jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new       jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_venue     uuid;
  v_id        text;
  v_changed   text[] := '{}';
  v_old_out   jsonb := '{}';
  v_new_out   jsonb := '{}';
  v_key       text;
  v_redacted  text[];
  v_prev      text;
  v_at        timestamptz := clock_timestamp();
  v_action    text := tg_table_name || '.' || lower(tg_op);
  v_target    text;
  v_payload   text;
  v_grant     uuid := nullif(current_setting('app.support_grant_id', true), '')::uuid;
begin
  v_venue := coalesce(
    nullif(coalesce(v_new, v_old) ->> 'venue_id', '')::uuid,
    case when tg_table_name = 'venues' then (coalesce(v_new, v_old) ->> 'id')::uuid end,
    nullif(current_setting('app.venue_id', true), '')::uuid,
    platform_venue_id());
  v_id := coalesce(v_new ->> 'id', v_old ->> 'id');
  v_target := tg_table_name || '/' || coalesce(v_id, '?');

  select coalesce(array_agg(column_name), '{}') into v_redacted
    from audit_redactions where table_name = tg_table_name;

  for v_key in select key from jsonb_object_keys(coalesce(v_new, v_old)) as t(key) order by key loop
    if tg_op = 'UPDATE' and v_old -> v_key is not distinct from v_new -> v_key then
      continue;
    end if;
    v_changed := v_changed || v_key;
    if v_key = any (v_redacted) then
      continue;
    end if;
    if v_old ? v_key then v_old_out := v_old_out || jsonb_build_object(v_key, v_old -> v_key); end if;
    if v_new ? v_key then v_new_out := v_new_out || jsonb_build_object(v_key, v_new -> v_key); end if;
  end loop;
  if tg_op = 'UPDATE' and cardinality(v_changed) = 0 then
    return null;
  end if;
  if v_old is null then v_old_out := null; end if;
  if v_new is null then v_new_out := null; end if;

  perform pg_advisory_xact_lock(hashtext('audit:' || v_venue::text));
  select hash into v_prev from audit_log where venue_id = v_venue order by id desc limit 1;

  v_payload := audit_payload(v_venue, nullif(current_setting('app.user_id', true), '')::uuid, v_action, v_target,
                             v_changed, v_old_out, v_new_out, nullif(current_setting('app.request_id', true), ''), v_at);
  if v_grant is not null then
    v_payload := v_payload || '|support:' || v_grant::text;
  end if;
  insert into audit_log (venue_id, actor, support_grant_id, action, target, changed_fields, old_values, new_values,
                         request_id, at, prev_hash, hash)
  values (v_venue, nullif(current_setting('app.user_id', true), '')::uuid, v_grant, v_action, v_target, v_changed,
          v_old_out, v_new_out, nullif(current_setting('app.request_id', true), ''), v_at, v_prev,
          audit_hash(v_prev, v_payload));
  return null;
end $$;
alter function audit_row() owner to app_definer;
revoke all on function audit_row() from public;

create or replace function verify_audit_chain(p_venue uuid, p_from bigint default 0, p_to bigint default null)
returns bigint
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  r        audit_log%rowtype;
  v_prev   text;
  v_expect text;
  v_payload text;
begin
  select hash into v_prev from audit_log where venue_id = p_venue and id < greatest(p_from, 1) order by id desc limit 1;
  for r in select * from audit_log where venue_id = p_venue and id >= p_from and (p_to is null or id <= p_to) order by id loop
    v_payload := audit_payload(r.venue_id, r.actor, r.action, r.target, r.changed_fields,
                               r.old_values, r.new_values, r.request_id, r.at);
    if r.support_grant_id is not null then
      v_payload := v_payload || '|support:' || r.support_grant_id::text;
    end if;
    v_expect := audit_hash(v_prev, v_payload);
    if r.prev_hash is distinct from v_prev or r.hash <> v_expect then
      return r.id;
    end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;
alter function verify_audit_chain(uuid, bigint, bigint) owner to app_definer;
revoke all on function verify_audit_chain(uuid, bigint, bigint) from public;
grant execute on function verify_audit_chain(uuid, bigint, bigint) to app_rw;
