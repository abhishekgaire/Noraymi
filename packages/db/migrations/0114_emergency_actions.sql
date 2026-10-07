-- The Console's emergency path (M8-11; spec 02 · Support access; spec 13 · On
-- call; spec 12 · 7; screens N39, Console). Our staff ask for one of four
-- listed actions on one venue, with a reason: re-sync a payment, cancel a
-- reader action, requeue a print, or close a stuck night. A second person on
-- our side, in their own Console session, approves it before it runs (never
-- the one who asked: the check below and the API both refuse it), and a
-- request nobody approves in its time box expires. The venue's owner is told
-- the moment it opens and again when it ran. Every audit row the action
-- writes names who asked (actor), who approved (approver) and the request
-- (emergency_action_id), and the hash covers all three.
set lock_timeout = '5s';

create table emergency_actions (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues (id),
  action            text not null
                      check (action in ('resync_payment', 'cancel_reader_action', 'requeue_print', 'close_night')),
  target            text not null check (length(target) between 1 and 100),  -- a payment, reader, print job id, or the night's date
  fixes             jsonb not null default '[]'::jsonb,                     -- close_night: the named fixes, each with its reason
  reason            text not null check (length(reason) between 3 and 500),
  requested_by      uuid not null references console_staff (id),
  requested_at      timestamptz not null,
  expires_at        timestamptz not null,
  status            text not null default 'requested'
                      check (status in ('requested', 'declined', 'withdrawn', 'approved', 'done', 'failed')),
  decided_by        uuid references console_staff (id),                      -- the second approver on our side
  decided_at        timestamptz,
  done_at           timestamptz,
  result            jsonb,
  unique (venue_id, id),
  check (jsonb_typeof(fixes) = 'array'),
  check (expires_at > requested_at and expires_at <= requested_at + interval '60 minutes'),
  check (decided_by is null or decided_by <> requested_by),
  check ((status in ('approved', 'done', 'failed', 'declined')) = (decided_by is not null)),
  check ((status in ('done', 'failed')) = (done_at is not null))
);
create index emergency_actions_venue_idx on emergency_actions (venue_id, requested_at desc);
alter table emergency_actions enable row level security;
alter table emergency_actions force row level security;
create policy venue_isolation on emergency_actions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on emergency_actions to app_rw;
grant update (status, decided_by, decided_at, done_at, result) on emergency_actions to app_rw;
select audit_table('emergency_actions');

-- A night our staff closed on the emergency path names our staff member, not a user.
alter table night_closes alter column closed_by drop not null;
alter table night_closes add column closed_by_support uuid references console_staff (id);
alter table night_closes add constraint night_closes_one_closer
  check ((closed_by is null) <> (closed_by_support is null)) not valid;
alter table night_closes validate constraint night_closes_one_closer;

-- Audit rows name the emergency action and its second approver.
alter table audit_log add column emergency_action_id uuid;

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
  v_emergency uuid := nullif(current_setting('app.emergency_action_id', true), '')::uuid;
  v_approver  uuid := nullif(current_setting('app.approver_id', true), '')::uuid;
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
  if v_emergency is not null then
    v_payload := v_payload || '|emergency:' || v_emergency::text || '|approver:' || coalesce(v_approver::text, '');
  end if;
  insert into audit_log (venue_id, actor, approver, support_grant_id, emergency_action_id, action, target,
                         changed_fields, old_values, new_values, request_id, at, prev_hash, hash)
  values (v_venue, nullif(current_setting('app.user_id', true), '')::uuid,
          case when v_emergency is not null then v_approver end, v_grant, v_emergency, v_action, v_target,
          v_changed, v_old_out, v_new_out, nullif(current_setting('app.request_id', true), ''), v_at, v_prev,
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
    if r.emergency_action_id is not null then
      v_payload := v_payload || '|emergency:' || r.emergency_action_id::text || '|approver:' || coalesce(r.approver::text, '');
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
