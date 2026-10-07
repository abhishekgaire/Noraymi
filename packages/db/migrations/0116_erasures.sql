-- Erasing a guest or a singer on request (M8-13; spec 12 · Erasing a guest).
-- The erase runs as app_retention (M8-12), so its audit rows name the fields
-- it blanked, never their old values. erasures is the erasure log: one row
-- per guest or singer erased, which M8-20 re-applies after a restore. Its
-- pending list (saved cards and Twilio message ids, never contact details)
-- is worked off by the guests.erase job between transactions.
set lock_timeout = '5s';

create table erasures (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  subject        text not null check (subject in ('guest', 'singer')),
  subject_id     uuid not null,
  requested_by   uuid,
  requested_at   timestamptz not null,
  state          text not null default 'pending' check (state in ('pending', 'done')),
  pending        jsonb not null default '{}'::jsonb check (jsonb_typeof(pending) = 'object'),
  removed        jsonb not null default '{}'::jsonb check (jsonb_typeof(removed) = 'object'),
  held_messages  integer not null default 0 check (held_messages >= 0),
  done_at        timestamptz,
  unique (venue_id, id),
  unique (venue_id, subject, subject_id)
);
alter table erasures enable row level security;
alter table erasures force row level security;
create policy venue_isolation on erasures to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy retention_wall on erasures to app_retention
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on erasures to app_rw;
grant select on erasures to app_retention;
grant update (state, pending, removed, held_messages, done_at) on erasures to app_retention;
select audit_table('erasures');

-- What the erase reads to find a legal hold: an open dispute on the booking's or session's check.
do $$
declare t text;
begin
  foreach t in array array['disputes', 'payment_allocations', 'room_sessions'] loop
    execute format(
      'create policy retention_wall on %I to app_retention using (venue_id = app_venue_id()) with check (venue_id = app_venue_id())',
      t);
  end loop;
end $$;
grant select on disputes, payment_allocations, room_sessions to app_retention;

-- What the erase blanks beyond the nightly job: our copy of a message body, and a consent's number.
grant update (body) on messages to app_retention;
grant update (phone_e164) on consents to app_retention;
