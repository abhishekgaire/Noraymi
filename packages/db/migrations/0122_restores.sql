-- Restoring one venue from a scratch copy (M8-20; spec 13 · Backups and
-- restore). The restore tool reads one venue's rows from a scratch copy of
-- the cluster and inserts the ones production is missing, as the audited
-- migration role (app_migrator), one venue at a time:
--   * restore_wall: app_migrator sees and writes only the venue in
--     app.venue_id, on every venue table, on both the scratch copy and
--     production, so a restore can't cross venues;
--   * restoring(): true only inside the tool's own transactions (the role is
--     app_migrator and app.restore_id is set). The business-rule triggers
--     (a closed night refuses new rows, the tip ledger derives its own rows,
--     the training and MFA guards) step aside then, because the rows being put
--     back were already checked when they were first written, and their
--     derived rows come back from the copy too. The audit trigger never steps
--     aside: every restored row is audited.
--   * restores: one row per restore or drill, with its counts and its time
--     against the recovery targets.
set lock_timeout = '5s';

create or replace function restoring() returns boolean
language sql stable
as $$
  select coalesce(current_setting('role', true), '') = 'app_migrator'
     and coalesce(current_setting('app.restore_id', true), '') <> ''
$$;
grant execute on function restoring() to public;

-- Each guard trigger's function, re-created with the restoring() check first.
do $$
declare
  f text;
  def text;
begin
  foreach f in array array[
    'approval_training', 'check_drawer_kick', 'payment_allocation_training', 'refuse_closed_night',
    'require_mfa_for_managers', 'tip_ledger_from_check', 'tip_ledger_from_payment', 'tip_shares_open_pool'
  ] loop
    select pg_get_functiondef(p.oid) into def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f;
    if def is null then
      raise exception 'no function %', f;
    end if;
    if position('restoring()' in def) = 0 then
      execute regexp_replace(def, E'\nbegin\n', E'\nbegin\n  if restoring() then return new; end if;\n');
    end if;
  end loop;
end $$;

-- The restore wall on every venue table: the venue in app.venue_id only.
do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'venue_id' and not a.attisdropped)
     order by c.relname
  loop
    if not exists (select 1 from pg_policy where polrelid = t::regclass and polname = 'restore_wall') then
      execute format(
        'create policy restore_wall on %I to app_migrator using (venue_id = app_venue_id()) with check (venue_id = app_venue_id())',
        t);
    end if;
    execute format('grant select, insert on %I to app_migrator', t);
  end loop;
end $$;

-- The menu comes back as new versions of its rows: the restore updates them, and the audit keeps the old ones.
grant update on menu_categories, menu_items, menu_variants, modifier_groups, menu_options, packages, price_rules
  to app_migrator;

create table restores (
  id                 uuid primary key default gen_random_uuid(),
  venue_id           uuid not null references venues (id),
  kind               text not null check (kind in ('restore', 'drill')),
  restore_point      timestamptz not null,
  scratch            text not null,
  state              text not null default 'applying'
                       check (state in ('applying', 'pulling', 'done', 'failed')),
  started_at         timestamptz not null,
  scratch_ready_s    integer check (scratch_ready_s >= 0),
  applied_at         timestamptz,
  finished_at        timestamptz,
  inserted           jsonb not null default '{}'::jsonb,
  updated            jsonb not null default '{}'::jsonb,
  settings_versions  integer not null default 0,
  skipped            jsonb not null default '{}'::jsonb,
  pulled             jsonb not null default '{}'::jsonb,
  erasures_reapplied integer not null default 0,
  stripe_check       jsonb,
  rto_target_s       integer,
  within_target      boolean,
  failure            text,
  unique (venue_id, id)
);
alter table restores enable row level security;
alter table restores force row level security;
create policy venue_isolation on restores to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy restore_wall on restores to app_migrator
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on restores to app_rw;
-- The pull after a restore runs as the API's role (the restore.pull job) and closes the record.
grant update (state, finished_at, pulled, erasures_reapplied, stripe_check, within_target, failure)
  on restores to app_rw;
grant select, insert, update on restores to app_migrator;
select audit_table('restores');

-- The pull after a restore and its count against Stripe read the organization's account, which every
-- venue of the organization shares: of the PaymentIntents given, the ones another venue has recorded.
-- It names no venue and no row, only the PaymentIntent ids that aren't this venue's.
create or replace function stripe_pis_elsewhere(p_venue uuid, p_pis text[]) returns text[]
language sql stable security definer
set search_path = public
as $$
  select coalesce(array_agg(p.stripe_pi_id), '{}')
    from payments p
   where p.stripe_pi_id = any(p_pis) and p.venue_id <> p_venue
$$;
alter function stripe_pis_elsewhere(uuid, text[]) owner to app_definer;
revoke all on function stripe_pis_elsewhere(uuid, text[]) from public;
grant execute on function stripe_pis_elsewhere(uuid, text[]) to app_rw, app_migrator;
