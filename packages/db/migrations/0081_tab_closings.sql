-- Closing a bar tab with the tip on the reader (M6-08; Payment flows · Bar tab
-- with a growing hold, step 5; Stripe setup 4; Data model · tab_closings).
-- One row per Close: the bar reader asks for the tip through collect_inputs
-- (the venue's three choices, Custom and No tip), and the hold is captured
-- with the tip in one call. The row keeps what the guest picked on the reader
-- (the choice, its amount, when and on which reader) with the payment, as
-- dispute evidence, and the receipt the guest asked for.
set lock_timeout = '5s';

create table tab_closings (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  tab_id          uuid not null,
  check_id        uuid not null,
  -- The tab's hold, captured with the tip.
  payment_id      uuid not null,
  -- reader: the guest tips on the reader; none: no tip screen (No tip, or a gratuity on the tab).
  path            text not null check (path in ('reader', 'none')),
  reader_device_id uuid,
  stripe_reader_id text,
  -- asking: the tip screen is on the reader; custom: the reader asks for the custom amount;
  -- raising: the hold grows before the capture; capturing: the capture is with Stripe;
  -- captured; canceled (Cancel on the reader or on the screen); timed_out (no answer in 2 minutes);
  -- failed (the hold can't cover the total: the tab is capture_failed for a manager).
  state           text not null check (state in
                    ('asking', 'custom', 'raising', 'capturing', 'captured', 'canceled', 'timed_out', 'failed')),
  -- The reader's current question, numbered so each collect_inputs call has its own key.
  step_no         integer not null default 0,
  step_started_at timestamptz,
  -- What the guest owes before the tip, and the drinks before tax the choices work on.
  balance_cents   integer not null check (balance_cents >= 0),
  drinks_cents    integer not null,
  gratuity_cents  integer not null default 0 check (gratuity_cents >= 0),
  tip_kind        text check (tip_kind in ('percent', 'fixed')),
  choices_cents   integer[] not null default '{}',
  -- The guest's answer: choice_1 to choice_3 (the venue's choices in order), fixed_<cents>, custom or none; with its amount and when, as dispute evidence.
  tip_choice      text,
  tip_cents       integer check (tip_cents >= 0),
  tip_picked_at   timestamptz,
  capture_cents   integer check (capture_cents >= 0),
  -- The receipt: text (the guest types their number on the reader), print or none.
  receipt         text check (receipt in ('text', 'print', 'none')),
  receipt_step_no integer,
  receipt_sent_at timestamptz,
  closed_by       uuid not null,
  created_at      timestamptz not null,
  settled_at      timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, tab_id) references tabs (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, reader_device_id) references devices (venue_id, id)
);
-- One Close at a time per tab.
create unique index tab_closings_one_active on tab_closings (venue_id, tab_id)
  where state in ('asking', 'custom', 'raising', 'capturing');
create index tab_closings_by_payment on tab_closings (venue_id, payment_id);
alter table tab_closings enable row level security;
alter table tab_closings force row level security;
create policy venue_isolation on tab_closings to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on tab_closings to app_rw;
select audit_table('tab_closings');
