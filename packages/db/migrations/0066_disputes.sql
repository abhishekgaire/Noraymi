-- Disputes (M4-24; Stripe setup step 9; Data model · disputes). A chargeback
-- opens an item with its evidence already gathered from our own rows (the
-- receipt, the room clock's segments, the booking's accepted policy, damage
-- photos, who served); Submit uploads the files to Stripe and sends the
-- evidence before due_by. Closing and the funds moves are kept for M7's
-- journal: each move once, keyed by Stripe's event.
set lock_timeout = '5s';

create table disputes (
  id                 uuid primary key default gen_random_uuid(),
  venue_id           uuid not null references venues (id),
  payment_id         uuid,
  check_id           uuid,
  stripe_dispute_id  text not null unique,
  reason             text not null,
  amount_cents       bigint not null check (amount_cents > 0),
  status             text not null,
  due_by             timestamptz,
  evidence           jsonb not null default '{}'::jsonb,
  evidence_file_ids  uuid[] not null default '{}',
  submitted_at       timestamptz,
  submitted_by       uuid,
  outcome            text check (outcome in ('won', 'lost')),
  closed_at          timestamptz,
  opened_at          timestamptz not null,
  unique (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
create index disputes_open_idx on disputes (venue_id, due_by) where closed_at is null;
alter table disputes enable row level security;
alter table disputes force row level security;
create policy venue_isolation on disputes to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on disputes to app_rw;
grant update (status, due_by, evidence, submitted_at, submitted_by, outcome, closed_at) on disputes to app_rw;
select audit_table('disputes');

create table dispute_funds (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues (id),
  dispute_id       uuid not null,
  kind             text not null check (kind in ('withdrawn', 'reinstated')),
  amount_cents     bigint not null check (amount_cents > 0),
  stripe_event_id  text not null unique,
  at               timestamptz not null,
  unique (venue_id, id),
  foreign key (venue_id, dispute_id) references disputes (venue_id, id)
);
alter table dispute_funds enable row level security;
alter table dispute_funds force row level security;
create policy venue_isolation on dispute_funds to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on dispute_funds to app_rw;
select audit_table('dispute_funds');
