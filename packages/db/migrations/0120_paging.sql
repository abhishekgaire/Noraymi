-- M8-17 · Paging and on call (spec 13 · Watching production, On call; spec 09
-- · Heartbeats; spec 12 · 4). Alerts page us only when a target is burning or
-- money is at risk; device problems stay with the venue's manager. A page goes
-- to the first responder on the rota; nobody acknowledging it within 10
-- minutes sends it to the second.
--
-- All three tables are platform tables, like console_staff and status_parts:
-- they are our own on-call records, not a venue's data, so they carry no
-- venue_id and no venue wall. A page names the venue it is about only inside
-- its key (for example 'readers-offline:<venue id>') so the responder knows
-- where to look; it never copies a venue's rows, a guest or a card.
set lock_timeout = '5s';

-- Who is on call: the first responder and the second. Empty until an operator
-- sets it (pnpm --filter @west4/api oncall:set); we never invent a phone number.
-- Each slot names one of our Console staff, whose email gets the page; the
-- phone, when set, gets it as a text too.
create table oncall_rota (
  slot             text primary key check (slot in ('first', 'second')),
  console_staff_id uuid not null references console_staff (id),
  phone            text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  updated_at       timestamptz not null default now(),
  updated_by       text not null check (length(updated_by) between 1 and 200)
);
grant select, insert, update on oncall_rota to app_rw;

-- One row per page. `key` says what it is about; while a page's condition
-- holds it stays the one page for that key (the partial unique index), and it
-- clears when the condition does. A page that is about one event (a payout, a
-- failover) clears when acknowledged and never fires again for that key.
create table pages (
  id              uuid primary key default gen_random_uuid(),
  rule            text not null check (rule ~ '^[a-z][a-z0-9-]{1,60}$'),
  key             text not null check (length(key) between 1 and 200),
  severity        text not null check (severity in ('page', 'ticket')),
  summary         text not null check (length(summary) between 1 and 300),
  runbook         text not null check (runbook ~ '^docs/runbooks/[a-z0-9-]+\.md$'),
  opened_at       timestamptz not null,
  acked_at        timestamptz,
  acked_by        uuid references console_staff (id),
  cleared_at      timestamptz,
  test            boolean not null default false,
  check ((acked_at is null) = (acked_by is null))
);
create unique index pages_live_key_idx on pages (key) where cleared_at is null;
create index pages_open_idx on pages (opened_at) where acked_at is null;
grant select, insert, update on pages to app_rw;

-- Each send of a page to a responder: claimed in a transaction, sent outside
-- it with its key as the idempotency key, then marked sent (or its error kept
-- for the next sweep to retry under the same key).
create table page_notifications (
  page_id         uuid not null references pages (id),
  slot            text not null check (slot in ('first', 'second')),
  channel         text not null check (channel in ('email', 'text')),
  idempotency_key text not null unique,
  claimed_at      timestamptz not null,
  sent_at         timestamptz,
  last_error      text check (char_length(last_error) <= 500),
  primary key (page_id, slot, channel)
);
grant select, insert, update on page_notifications to app_rw;
