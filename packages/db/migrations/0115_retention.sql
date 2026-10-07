-- The nightly retention job (M8-12; spec 12 · How long we keep things). One
-- job per venue runs under its own role, app_retention: it can see only its
-- own venue's rows (the retention_wall policies below), and it may delete or
-- blank only what the retention table lets go. Nothing here touches checks,
-- lines, payments, refunds, night closes, punches, tips or the audit log,
-- which it can only read. Saved cards are detached at Stripe and message
-- bodies redacted at Twilio between transactions; card_detaches records each
-- detach once. retention_runs keeps each run's counts by kind, never data.
set lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_retention') then
    create role app_retention nologin nobypassrls noinherit;
  end if;
end $$;
grant app_retention to current_user;
grant app_retention to app_rw;          -- only so the retention job can "set local role app_retention"
grant usage on schema public to app_retention;

-- What the job blanks, and when.
alter table bookings add column pseudonymized_at timestamptz;
alter table waitlist_entries add column pseudonymized_at timestamptz;
alter table enquiries add column pseudonymized_at timestamptz;
alter table print_jobs add column payload_purged_at timestamptz;
alter table webhook_events add column payload_purged_at timestamptz;
alter table messages add column provider_body_purged_at timestamptz;   -- the body redacted at Twilio (30 days)
-- A singer whose songs explain a check is pseudonymized rather than deleted (D91).
alter table singers add column erased_at timestamptz;
alter table singers alter column phone_e164 drop not null;

-- Opt-outs outlive the guest as a keyed hash of the number. The key is the
-- venue's own, random, readable only by opt_out_hash() (never by app_rw).
create table venue_hash_keys (
  venue_id   uuid primary key references venues (id),
  key        bytea not null,
  created_at timestamptz not null default now()
);
alter table venue_hash_keys enable row level security;
alter table venue_hash_keys force row level security;
create policy venue_isolation on venue_hash_keys to app_definer
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on venue_hash_keys to app_definer;

create or replace function opt_out_hash(p_phone text) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare v_key bytea;
begin
  if p_phone is null or p_phone = '' then
    return null;
  end if;
  insert into venue_hash_keys (venue_id, key) values (app_venue_id(), gen_random_bytes(32))
    on conflict (venue_id) do nothing;
  select key into v_key from venue_hash_keys where venue_id = app_venue_id();
  return encode(hmac(convert_to(p_phone, 'UTF8'), v_key, 'sha256'), 'hex');
end $$;
alter function opt_out_hash(text) owner to app_definer;
revoke all on function opt_out_hash(text) from public;
grant execute on function opt_out_hash(text) to app_rw, app_retention;

create table opt_out_hashes (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues (id),
  phone_hash  text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  revoked_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, phone_hash)
);
alter table opt_out_hashes enable row level security;
alter table opt_out_hashes force row level security;
create policy venue_isolation on opt_out_hashes to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on opt_out_hashes to app_rw;

-- Each saved card the job detached at Stripe, once (a rerun skips it).
create table card_detaches (
  id                        uuid primary key default gen_random_uuid(),
  venue_id                  uuid not null references venues (id),
  source                    text not null check (source in ('booking', 'tab', 'check_card')),
  source_id                 uuid not null,                  -- the booking, the tab or the check_cards row
  stripe_payment_method_id  text,
  training                  boolean not null default false,
  outcome                   text not null check (outcome in ('detached', 'gone')),
  detached_at               timestamptz not null,
  unique (venue_id, id),
  unique (venue_id, source, source_id)
);
alter table card_detaches enable row level security;
alter table card_detaches force row level security;
create policy venue_isolation on card_detaches to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on card_detaches to app_rw;
select audit_table('card_detaches');

-- Each run's log: counts per kind, and what it couldn't do (never any data).
create table retention_runs (
  id        uuid primary key default gen_random_uuid(),
  venue_id  uuid not null references venues (id),
  ran_at    timestamptz not null,
  removed   jsonb not null check (jsonb_typeof(removed) = 'object'),
  skipped   jsonb not null default '{}'::jsonb check (jsonb_typeof(skipped) = 'object'),
  unique (venue_id, id)
);
create index retention_runs_venue_idx on retention_runs (venue_id, ran_at desc);
alter table retention_runs enable row level security;
alter table retention_runs force row level security;
create policy venue_isolation on retention_runs to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on retention_runs to app_rw;

-- The retention role's wall: its own venue only, on every table it reads or changes.
do $$
declare t text;
begin
  foreach t in array array[
    'guests', 'bookings', 'waitlist_entries', 'enquiries', 'conversations', 'messages', 'consents',
    'print_jobs', 'webhook_events', 'idempotency_keys', 'venue_events', 'singers',
    'singer_push_subscriptions', 'song_queue', 'song_credits', 'song_plays', 'orders',
    'prepaid_accounts', 'checks', 'tabs', 'payments', 'check_cards', 'files', 'incidents',
    'incident_notes', 'opt_out_hashes', 'card_detaches', 'retention_runs'
  ] loop
    execute format(
      'create policy retention_wall on %I to app_retention using (venue_id = app_venue_id()) with check (venue_id = app_venue_id())',
      t);
  end loop;
end $$;

-- Reads: what decides whether a row's time is up.
grant select on guests, bookings, waitlist_entries, enquiries, conversations, messages, consents,
  print_jobs, webhook_events, idempotency_keys, venue_events, singers, singer_push_subscriptions,
  song_queue, song_credits, song_plays, orders, prepaid_accounts, checks, tabs, payments,
  check_cards, files, incidents, incident_notes, opt_out_hashes, card_detaches, retention_runs
  to app_retention;
-- Pseudonymizing: the personal columns only.
grant update (name, phone_e164, email, erased_at) on guests to app_retention;
grant update (accepted_ip, accepted_ua, manage_token_hash, payment_method_id, pseudonymized_at)
  on bookings to app_retention;
grant update (link_token_hash, link_expires_at, offer_message_id, pseudonymized_at)
  on waitlist_entries to app_retention;
grant update (message, pseudonymized_at) on enquiries to app_retention;
grant update (phone_e164) on conversations to app_retention;
grant update (provider_body_purged_at) on messages to app_retention;
grant update (payload, payload_purged_at) on print_jobs to app_retention;
grant update (payload, payload_purged_at) on webhook_events to app_retention;
grant update (display_name, phone_e164, phone_verified_at, code_hash, code_expires_at, token_hash, erased_at)
  on singers to app_retention;
-- Deleting: what the retention table lets go. Incidents only here: the app itself never deletes one.
grant delete on conversations, messages, consents, idempotency_keys, venue_events, singers,
  singer_push_subscriptions, incidents, incident_notes to app_retention;
grant insert on opt_out_hashes, card_detaches, retention_runs to app_retention;

-- The audit trail of a retention run names the fields it removed, never their old values.
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
  -- M8-12: the retention job (its own role) records which fields it removed, never their values.
  v_retention boolean := coalesce(current_setting('role', true) = 'app_retention', false);
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
    if v_key = any (v_redacted) or v_retention then
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
