-- M9-15 · The nightly money audit (milestones · the go-live gate, a money error).
--
-- One row per audit of a venue's night: after the close, and again whenever a
-- payout arrives for it. `errors` lists each money error the audit found (its
-- kind, the check or payment, what the rules give, what was stored, the
-- difference in cents); amounts and ids only, never a guest's name or card.
-- The morning summary marks `summary_sent_at` once its emails are queued, so a
-- rerun never emails twice. Our people sign each error off in
-- docs/gate/money-errors.md; this table is the machine's side of that log.
set lock_timeout = '5s';

create table money_audits (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues (id),
  night            date not null,
  ran_at           timestamptz not null,
  trigger          text not null check (trigger in ('morning', 'manual')),
  ok               boolean not null,
  covered          text[] not null,
  errors           jsonb not null default '[]'::jsonb,
  summary_sent_at  timestamptz,
  unique (venue_id, id)
);
create index money_audits_night_idx on money_audits (venue_id, night, ran_at);
alter table money_audits enable row level security;
alter table money_audits force row level security;
create policy venue_isolation on money_audits to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on money_audits to app_rw;
grant update (summary_sent_at) on money_audits to app_rw;
-- A one-venue restore (M8-20) copies it like every venue table.
create policy restore_wall on money_audits to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on money_audits to app_migrator;
