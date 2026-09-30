-- 0003 · jobs, the claim function and the clock control (spec 01 · Jobs and
-- scheduler; spec 02 · The database walls, Jobs; M1-06).
set lock_timeout = '5s';

create table jobs (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues (id),
  kind         text not null,
  pool         text not null check (pool in ('critical', 'normal', 'bulk')),
  dedupe_key   text unique,                        -- one job per key, ever (scheduled runs use kind:venue:date)
  priority     int not null default 0,             -- higher runs first
  payload      jsonb not null default '{}',
  run_at       timestamptz not null,               -- from the app clock, never the database's now()
  attempts     int not null default 0,
  max_attempts int not null default 5,
  locked_until timestamptz,                        -- the worker's lease
  last_error   text,
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'dead')),
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  unique (venue_id, id)
);
create index jobs_claim_idx on jobs (pool, run_at, priority desc) where status = 'queued';
create index jobs_running_idx on jobs (pool, locked_until) where status = 'running';

alter table jobs enable row level security;
alter table jobs force row level security;
create policy venue_isolation on jobs to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy definer_all on jobs to app_definer using (true) with check (true);

grant select, insert, update on jobs to app_rw;
grant select, insert, update on jobs to app_definer;

-- A worker claims the next jobs of its pool in one short transaction:
-- queued jobs that are due, or running jobs whose lease ran out (a crashed
-- worker). SKIP LOCKED keeps two workers off the same row. Runs as the
-- definer because it reads across venues; the worker then sets the job's
-- venue for every step it runs.
create or replace function claim_jobs(p_pool text, p_now timestamptz, p_lease interval, p_limit int)
returns setof jobs
language sql volatile security definer
set search_path = pg_catalog, public
as $$
  with candidates as (
    select id from jobs
    where pool = p_pool
      and ((status = 'queued' and run_at <= p_now)
        or (status = 'running' and locked_until < p_now))
    order by priority desc, run_at
    limit p_limit
    for update skip locked
  )
  update jobs j
     set status = 'running', locked_until = p_now + p_lease, attempts = j.attempts + 1
    from candidates c
   where j.id = c.id
  returning j.*
$$;
alter function claim_jobs(text, timestamptz, interval, int) owner to app_definer;
revoke all on function claim_jobs(text, timestamptz, interval, int) from public;
grant execute on function claim_jobs(text, timestamptz, interval, int) to app_rw;

-- The scheduler fans work out to every venue, so it reads them all through a definer.
create or replace function venues_for_scheduler()
returns table (id uuid, time_zone text, day_cutover time)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select id, time_zone, day_cutover from venues
$$;
alter function venues_for_scheduler() owner to app_definer;
revoke all on function venues_for_scheduler() from public;
grant execute on function venues_for_scheduler() to app_rw;

-- The simulated clock (staging and tests). One row: when it's set, the app's
-- time is simulated_at plus the real time that has passed since real_at, so
-- pages tick; when it's clear, the app uses the real clock. Production never
-- reads it (ALLOW_STAGING_FEATURES is off there).
create table clock_control (
  id           boolean primary key default true check (id),
  simulated_at timestamptz,
  real_at      timestamptz,
  set_by       text
);
insert into clock_control (id) values (true);
alter table clock_control enable row level security;
alter table clock_control force row level security;
create policy anyone on clock_control to app_rw using (true) with check (true);
grant select, update on clock_control to app_rw;
