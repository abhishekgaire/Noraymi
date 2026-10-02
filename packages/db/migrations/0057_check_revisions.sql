-- Check revisions (M4-07; Data model · the money core): each finalize
-- writes revision n + 1 with its totals, the settings versions and the
-- billing basis, and the check moves to it. Append-only like every money
-- row: the app may insert and read revisions, never change or delete one.
-- The core SQL grants no update on checks at all, yet a check's revision,
-- status and paid time must move (finalize, present, pay, reopen), so the app
-- may update those three columns; the audit trigger records every change.
set lock_timeout = '5s';

create table check_revisions (
  venue_id          uuid not null,
  check_id          uuid not null,
  rev               int not null,
  subtotal_cents    bigint not null,
  tax_cents         bigint not null,
  gratuity_cents    bigint not null,
  total_cents       bigint not null,
  gratuity_basis    jsonb,
  billing_basis     jsonb,
  pay_version       int not null,
  prices_version    int not null,
  rule_pack_version text not null,
  finalized_by      uuid not null,
  finalized_at      timestamptz not null default now(),
  primary key (venue_id, check_id, rev),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
alter table check_revisions enable row level security;
alter table check_revisions force row level security;
create policy venue_isolation on check_revisions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on check_revisions to app_rw;
select audit_table('check_revisions');

grant update (status, revision, paid_at) on checks to app_rw;
