-- Closed nights (M7-02; Data model · night_closes; Money rules 2 and 16).
-- A night closes once, with its Z number, and never reopens: app_rw may only
-- insert and read night_closes. Every row with a business date is stamped
-- through posting_business_date(), which moves a closed night's date forward
-- to the next open one, and a trigger on every table with business_date
-- refuses a row dated to a closed night, whatever route or job writes it.
set lock_timeout = '5s';

create table night_closes (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  business_date date not null,
  z_number      bigint not null check (z_number >= 1),
  closed_at     timestamptz not null,
  closed_by     uuid not null references users (id),
  totals        jsonb not null default '{}'::jsonb,
  export_id     uuid,
  created_at    timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, business_date),
  unique (venue_id, z_number)
);
alter table night_closes enable row level security;
alter table night_closes force row level security;
create policy venue_isolation on night_closes to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
-- The guard below reads it for the row's own venue, whoever writes the row.
create policy definer_read on night_closes for select to app_definer using (true);
grant select, insert on night_closes to app_rw;
grant select on night_closes to app_definer;
select audit_table('night_closes');

-- A refund asked before its night closed and approved after it moves to the
-- next open night, pointing back at the one it was asked on.
grant update (business_date, adjusts_business_date) on refunds to app_rw;

-- `p_date`, or the first business date after it that isn't closed.
create or replace function open_business_date(p_venue uuid, p_date date) returns date
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  d date := p_date;
begin
  while exists (select 1 from night_closes where venue_id = p_venue and business_date = d) loop
    d := d + 1;
  end loop;
  return d;
end;
$$;
grant execute on function open_business_date(uuid, date) to app_rw;

-- The business date of `p_at` (local time minus the venue's cutover), moved
-- forward past any closed night. Mirrors packages/rules postingBusinessDate().
create or replace function posting_business_date(p_venue uuid, p_at timestamptz) returns date
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  tz  text;
  cut time;
begin
  select time_zone, day_cutover into tz, cut from venues where id = p_venue;
  if not found then
    raise exception 'no venue %', p_venue;
  end if;
  return open_business_date(p_venue, ((p_at at time zone tz) - cut)::date);
end;
$$;
grant execute on function posting_business_date(uuid, timestamptz) to app_rw;

-- Refuses a row dated to a closed night: an insert, or an update that moves a
-- row onto one. Rows already on the night stay as they are.
create or replace function refuse_closed_night() returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if (tg_op = 'INSERT' or new.business_date is distinct from old.business_date)
     and exists (
       select 1 from night_closes where venue_id = new.venue_id and business_date = new.business_date
     ) then
    raise exception 'the night of % is closed', new.business_date
      using errcode = 'W4N01', hint = 'post it to the next open business date';
  end if;
  return new;
end;
$$;
alter function refuse_closed_night() owner to app_definer;
revoke all on function refuse_closed_night() from public;

do $$
declare
  t text;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables x using (table_schema, table_name)
     where c.table_schema = 'public' and c.column_name = 'business_date'
       and x.table_type = 'BASE TABLE' and c.table_name <> 'night_closes'
     order by 1
  loop
    execute format(
      'create trigger closed_night_guard before insert or update of business_date on %I
         for each row execute function refuse_closed_night()', t);
  end loop;
end;
$$;
