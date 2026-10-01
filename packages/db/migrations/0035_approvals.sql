-- M2-15 · Approvals (spec 02 · Approvals; spec 04 · approvals), and the
-- stand-in for the manager on duty until the time clock lands in M7.
set lock_timeout = '5s';

-- The manager on duty per business date, until the time clock's open Manager duty replaces it (M7 drops this).
create table duty_managers (
  venue_id      uuid not null references venues (id),
  business_date date not null,
  membership_id uuid not null,
  primary key (venue_id, business_date),
  foreign key (venue_id, membership_id) references memberships (venue_id, id)
);
alter table duty_managers enable row level security;
alter table duty_managers force row level security;
create policy venue_isolation on duty_managers to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on duty_managers to app_rw;

create table approvals (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references venues (id),
  kind                text not null check (kind in ('comp', 'void', 'refund', 'clock_pause', 'tip_review', 'paid_out',
                                                    'party_size_down', 'card_on_file', 'over_hold')),
  target_kind         text not null,      -- session, check, check_line, tab, payment …
  target_id           uuid not null,
  amount_cents        bigint,
  reason              text not null,
  payload             jsonb not null default '{}',   -- what runs when it's approved
  requested_by        uuid not null,                  -- a user
  requested_device_id uuid,
  requested_at        timestamptz not null,
  routed_to           uuid not null,                  -- the approver (a user)
  approver_id         uuid,
  decided_device_id   uuid,
  status              text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired')),
  decided_at          timestamptz,
  unique (venue_id, id),
  check (routed_to <> requested_by),
  check (approver_id is null or approver_id <> requested_by),
  check (decided_device_id is null or requested_device_id is null or decided_device_id <> requested_device_id)
);
create index approvals_inbox_idx on approvals (venue_id, routed_to) where status = 'pending';
alter table approvals enable row level security;
alter table approvals force row level security;
create policy venue_isolation on approvals to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on approvals to app_rw;
grant update (status, approver_id, decided_device_id, decided_at) on approvals to app_rw;
select audit_table('approvals');
