-- M8-16 · Watching production (spec 13 · Watching production; spec 01 · Targets):
-- each room order's trace, so the bar device's alarm closes the trace the room
-- page opened and the time from order to alarm is measured; and the public
-- status page's parts (ordering, payments, printing, texts).
set lock_timeout = '5s';

-- One row per traced order: the trace it was placed in, and when a bar device's alarm first rang
-- for it. Ids and times only, no personal data; gone after 30 days with the logs (spec 12).
create table order_traces (
  venue_id     uuid not null references venues (id),
  order_id     uuid not null,
  trace_parent text not null check (trace_parent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'),
  placed_at    timestamptz not null,
  rang_at      timestamptz,
  rang_device  uuid,
  primary key (venue_id, order_id),
  foreign key (venue_id, order_id) references orders (venue_id, id)
);
alter table order_traces enable row level security;
alter table order_traces force row level security;
create policy venue_isolation on order_traces to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on order_traces to app_rw;
-- No audit_table('order_traces'): telemetry, like heartbeats, never reaches the audit log.

-- The nightly retention job lets a trace go after 30 days (M8-12's role and wall).
create policy retention_wall on order_traces to app_retention
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, delete on order_traces to app_retention;

-- The public status page (platform table: no venue_id, no wall; it names no venue). Each part has
-- the state the jobs set (auto) and, over it, the state an operator posts (an incident, a drill,
-- maintenance). The page shows the operator's when there is one.
create table status_parts (
  part           text primary key check (part in ('ordering', 'payments', 'printing', 'texts')),
  auto_state     text not null default 'operational'
                   check (auto_state in ('operational', 'degraded', 'outage', 'maintenance')),
  auto_note      text,
  auto_since     timestamptz,
  operator_state text check (operator_state in ('operational', 'degraded', 'outage', 'maintenance')),
  operator_note  text check (char_length(operator_note) <= 280),
  operator_since timestamptz,
  operator_by    text,
  updated_at     timestamptz not null default now()
);
insert into status_parts (part) values ('ordering'), ('payments'), ('printing'), ('texts');
grant select, update on status_parts to app_rw;
