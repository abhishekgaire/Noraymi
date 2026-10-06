-- Charge the saved card on a reopened tab (M6-12; Payment flows · Bar tab
-- with a growing hold, step 9; API · Bar tabs `/charge-saved-card`; Data
-- model · tab_card_confirms). A reopened tab whose hold was captured has no
-- hold; new drinks can go on the card saved from the first tap (the reader's
-- generated_card), charged off-session, once the guest says Yes on the bar
-- reader (collect_inputs) or a manager approves (kind card_on_file). One row
-- per question on the reader: what was asked, the guest's answer and when, on
-- which reader, kept with the payment as evidence of the guest's consent.
set lock_timeout = '5s';

create table tab_card_confirms (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references venues (id),
  tab_id           uuid not null,
  check_id         uuid not null,
  -- The card_on_file payment waiting for the go-ahead.
  payment_id       uuid not null,
  amount_cents     integer not null check (amount_cents > 0),
  reader_device_id uuid not null,
  stripe_reader_id text not null,
  -- asking: the question is on the reader; yes: the guest said Yes and the charge runs; no: No, or
  -- Cancel on the reader; timed_out: no answer in 2 minutes; offline: the reader couldn't ask;
  -- canceled: staff cancelled, or the payment went ahead (or ended) another way first.
  state            text not null check (state in ('asking', 'yes', 'no', 'timed_out', 'offline', 'canceled')),
  asked_by         uuid not null,
  asked_at         timestamptz not null,
  answered_at      timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, tab_id) references tabs (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, reader_device_id) references devices (venue_id, id)
);
-- One question at a time per tab.
create unique index tab_card_confirms_one_asking on tab_card_confirms (venue_id, tab_id)
  where state = 'asking';
create index tab_card_confirms_by_payment on tab_card_confirms (venue_id, payment_id);
alter table tab_card_confirms enable row level security;
alter table tab_card_confirms force row level security;
create policy venue_isolation on tab_card_confirms to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on tab_card_confirms to app_rw;
select audit_table('tab_card_confirms');
