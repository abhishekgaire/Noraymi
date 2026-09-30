-- 0005 · idempotency keys (spec 08 · Idempotency; M1-08). Keyed by venue and
-- caller, written before the work starts, replayed for 7 days.
set lock_timeout = '5s';

create table idempotency_keys (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null,                  -- platform_venue_id() for routes outside a venue
  principal_id text not null,
  key          text not null,
  route        text not null,
  request_hash text not null,
  state        text not null default 'running' check (state in ('running', 'done', 'failed')),
  response     jsonb,                          -- { status, body } once done
  created_at   timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, principal_id, key)
);
create index idempotency_keys_created_idx on idempotency_keys (created_at);

alter table idempotency_keys enable row level security;
alter table idempotency_keys force row level security;
create policy venue_isolation on idempotency_keys to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_all on idempotency_keys to app_definer using (true) with check (true);
grant select, insert, update on idempotency_keys to app_rw;
grant select, delete on idempotency_keys to app_definer;

-- The daily clean-up (a bulk job) runs this; app_rw itself can't delete.
create or replace function clear_idempotency_keys(p_before timestamptz) returns bigint
language sql volatile security definer
set search_path = pg_catalog, public
as $$
  with gone as (delete from idempotency_keys where created_at < p_before returning 1)
  select count(*) from gone
$$;
alter function clear_idempotency_keys(timestamptz) owner to app_definer;
revoke all on function clear_idempotency_keys(timestamptz) from public;
grant execute on function clear_idempotency_keys(timestamptz) to app_rw;
