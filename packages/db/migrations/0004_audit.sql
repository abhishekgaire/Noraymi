-- 0004 · the audit log, written only by triggers, hash-chained per venue
-- (spec 02 · Audit rows; spec 04 · audit_log; spec 12 · 4; M1-07).
set lock_timeout = '5s';

-- Rows that belong to no venue (platform actions, seeds) chain under this id.
create or replace function platform_venue_id() returns uuid
language sql immutable
as $$ select '00000000-0000-0000-0000-000000000000'::uuid $$;

create table audit_log (
  id               bigint generated always as identity primary key,
  venue_id         uuid not null,
  actor            uuid,                 -- app.user_id
  approver         uuid,                 -- M2: the approval that allowed this
  support_grant_id uuid,                 -- M8: the support grant behind this
  action           text not null,        -- table.insert, table.update, table.delete
  target           text not null,        -- table/id
  changed_fields   text[] not null,
  old_values       jsonb,
  new_values       jsonb,
  request_id       text,
  at               timestamptz not null, -- the database's real now(), never the simulated clock
  prev_hash        text,
  hash             text not null,
  unique (venue_id, id)
);
create index audit_log_venue_at_idx on audit_log (venue_id, at);

alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy venue_isolation on audit_log for select to app_rw using (venue_id = app_venue_id());
create policy definer_all on audit_log to app_definer using (true) with check (true);
-- The app only reads. Inserts come from the trigger (as app_definer); nobody updates or deletes.
grant select on audit_log to app_rw;
grant select, insert on audit_log to app_definer;

-- Columns whose values never enter the audit log: they show as changed, no
-- old or new value. Guest contact columns join the list with the guests
-- table (M2). Staff contact details and the PIN verifier are here from the
-- start, as a cautious default.
create table audit_redactions (
  table_name  text not null,
  column_name text not null,
  primary key (table_name, column_name)
);
insert into audit_redactions values
  ('users', 'email'),
  ('users', 'phone_e164'),
  ('memberships', 'pin_verifier');
grant select on audit_redactions to app_rw, app_definer;

-- Alerts the database raises on its own: DDL outside a migration, TRUNCATE.
create table security_alerts (
  id     bigint generated always as identity primary key,
  kind   text not null,
  detail text not null,
  at     timestamptz not null default now()
);
grant select on security_alerts to app_rw;

-- The chain: hash = sha256(prev_hash || payload). The payload is every
-- audited field in a fixed order; jsonb prints keys in a canonical order.
create or replace function audit_payload(
  p_venue uuid, p_actor uuid, p_action text, p_target text, p_changed text[],
  p_old jsonb, p_new jsonb, p_request text, p_at timestamptz
) returns text
language sql immutable
as $$
  select concat_ws('|', p_venue::text, coalesce(p_actor::text, ''), p_action, p_target,
                   array_to_string(p_changed, ','), coalesce(p_old::text, ''), coalesce(p_new::text, ''),
                   coalesce(p_request, ''), to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$$;

create or replace function audit_hash(p_prev text, p_payload text) returns text
language sql immutable
as $$
  select encode(digest(convert_to(coalesce(p_prev, '') || '|' || p_payload, 'utf8'), 'sha256'), 'hex')
$$;

-- The trigger. SECURITY DEFINER, owned by app_definer, so the app role never
-- needs insert on audit_log. One advisory lock per venue keeps the chain in
-- order when two requests write at once.
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
begin
  -- Which venue's chain: the row's venue, a venue's own id, the request's venue, else the platform chain.
  v_venue := coalesce(
    nullif(coalesce(v_new, v_old) ->> 'venue_id', '')::uuid,
    case when tg_table_name = 'venues' then (coalesce(v_new, v_old) ->> 'id')::uuid end,
    nullif(current_setting('app.venue_id', true), '')::uuid,
    platform_venue_id());
  v_id := coalesce(v_new ->> 'id', v_old ->> 'id');
  v_target := tg_table_name || '/' || coalesce(v_id, '?');

  select coalesce(array_agg(column_name), '{}') into v_redacted
    from audit_redactions where table_name = tg_table_name;

  -- Changed fields: everything on insert and delete, the differences on update.
  for v_key in select key from jsonb_object_keys(coalesce(v_new, v_old)) as t(key) order by key loop
    if tg_op = 'UPDATE' and v_old -> v_key is not distinct from v_new -> v_key then
      continue;
    end if;
    v_changed := v_changed || v_key;
    if v_key = any (v_redacted) then
      continue;  -- marked changed, values withheld
    end if;
    if v_old ? v_key then v_old_out := v_old_out || jsonb_build_object(v_key, v_old -> v_key); end if;
    if v_new ? v_key then v_new_out := v_new_out || jsonb_build_object(v_key, v_new -> v_key); end if;
  end loop;
  if tg_op = 'UPDATE' and cardinality(v_changed) = 0 then
    return null;  -- nothing changed, nothing to record
  end if;
  if tg_op <> 'INSERT' then null; end if;
  if v_old is null then v_old_out := null; end if;
  if v_new is null then v_new_out := null; end if;

  perform pg_advisory_xact_lock(hashtext('audit:' || v_venue::text));
  select hash into v_prev from audit_log where venue_id = v_venue order by id desc limit 1;

  v_payload := audit_payload(v_venue, nullif(current_setting('app.user_id', true), '')::uuid, v_action, v_target,
                             v_changed, v_old_out, v_new_out, nullif(current_setting('app.request_id', true), ''), v_at);
  insert into audit_log (venue_id, actor, action, target, changed_fields, old_values, new_values, request_id, at, prev_hash, hash)
  values (v_venue, nullif(current_setting('app.user_id', true), '')::uuid, v_action, v_target, v_changed,
          v_old_out, v_new_out, nullif(current_setting('app.request_id', true), ''), v_at, v_prev, audit_hash(v_prev, v_payload));
  return null;
end $$;
alter function audit_row() owner to app_definer;
revoke all on function audit_row() from public;

-- Walks a venue's chain and returns the id of the first row whose hash no
-- longer matches its content and its predecessor, or null when it's intact.
create or replace function verify_audit_chain(p_venue uuid, p_from bigint default 0, p_to bigint default null)
returns bigint
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  r        audit_log%rowtype;
  v_prev   text;
  v_expect text;
begin
  select hash into v_prev from audit_log where venue_id = p_venue and id < greatest(p_from, 1) order by id desc limit 1;
  for r in select * from audit_log where venue_id = p_venue and id >= p_from and (p_to is null or id <= p_to) order by id loop
    v_expect := audit_hash(v_prev, audit_payload(r.venue_id, r.actor, r.action, r.target, r.changed_fields,
                                                 r.old_values, r.new_values, r.request_id, r.at));
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

-- The last hash of a business date for a venue: what the daily export stores.
-- A business date ends at the cutover instant the caller passes.
create or replace function audit_head_before(p_venue uuid, p_before timestamptz)
returns table (id bigint, hash text, at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select id, hash, at from audit_log where venue_id = p_venue and at < p_before order by id desc limit 1
$$;
alter function audit_head_before(uuid, timestamptz) owner to app_definer;
revoke all on function audit_head_before(uuid, timestamptz) from public;
grant execute on function audit_head_before(uuid, timestamptz) to app_rw;

-- TRUNCATE raises an alert. Heartbeats never reach the audit log (M1-16 keeps them in their own table).
create or replace function truncate_alert() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  insert into security_alerts (kind, detail) values ('truncate', tg_table_name || ' by ' || session_user);
  raise warning 'security alert: truncate on % by %', tg_table_name, session_user;
  return null;
end $$;
alter function truncate_alert() owner to app_definer;
grant insert on security_alerts to app_definer;

-- Attach the audit trigger and the truncate alert.
create or replace function audit_table(p_table regclass) returns void
language plpgsql
as $$
begin
  execute format('create trigger audit_row after insert or update or delete on %s for each row execute function audit_row()', p_table);
  execute format('create trigger truncate_alert after truncate on %s for each statement execute function truncate_alert()', p_table);
end $$;

select audit_table('organizations');
select audit_table('venues');
select audit_table('users');
select audit_table('memberships');

-- Every table gets the truncate alert, even ones that aren't audited row by row.
do $$
declare t record;
begin
  for t in select c.oid::regclass as tbl from pg_class c
           where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace
             and not exists (select 1 from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'truncate_alert') loop
    execute format('create trigger truncate_alert after truncate on %s for each statement execute function truncate_alert()', t.tbl);
  end loop;
end $$;

-- DDL outside a migration raises an alert, and every new table gets the
-- truncate alert. The migration runner sets app.migrating for its own DDL.
create or replace function ddl_alert() returns event_trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands() loop
    if cmd.command_tag = 'CREATE TABLE' and cmd.schema_name = 'public'
       and not exists (select 1 from pg_trigger g where g.tgrelid = cmd.objid and g.tgname = 'truncate_alert') then
      execute format('create trigger truncate_alert after truncate on %s for each statement execute function truncate_alert()', cmd.objid::regclass);
    end if;
    if current_setting('app.migrating', true) is distinct from 'on' then
      insert into security_alerts (kind, detail) values ('ddl', cmd.command_tag || ' ' || coalesce(cmd.object_identity, '') || ' by ' || session_user);
      raise warning 'security alert: % % by %', cmd.command_tag, cmd.object_identity, session_user;
    end if;
  end loop;
end $$;
create event trigger ddl_alert on ddl_command_end execute function ddl_alert();
