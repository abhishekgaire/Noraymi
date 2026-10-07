-- Replayed offline orders (M8-05; spec 09 · Replay, Review after outage):
-- every round the bar computer queued in an outage, as it reached the server.
-- One row per device-made order id, so uploading the same queue twice lands
-- each order once. A round that passes the checks again becomes a held order
-- (source offline) that waits for a bartender's Accept; one that fails is kept
-- here with the reason, for a manager on Close the night. Offline cash noted
-- on a round is posted later as a cash payment, named here once.
set lock_timeout = '5s';

create table offline_replays (
  id                 uuid primary key default gen_random_uuid(),
  venue_id           uuid not null references venues (id),
  client_order_id    text not null check (length(client_order_id) between 8 and 64),
  device_id          uuid,
  -- The night it was queued on, from the time it was queued, and the night it reached us. Not
  -- a sale's business date (the order, if one landed, carries that): no closed-night guard, so
  -- a round queued before a closed night's cutover still reaches Review after outage.
  queued_on          date not null,
  replayed_on        date not null,
  queued_at          timestamptz not null,
  replayed_at        timestamptz not null,
  check_id           uuid not null,
  tab_name           text not null check (char_length(tab_name) between 1 and 120),
  staff_membership_id uuid,
  staff_name         text not null check (char_length(staff_name) between 1 and 120),
  lines              jsonb not null,
  total_cents        integer not null check (total_cents >= 0),
  cash_note          text check (char_length(cash_note) <= 200),
  outcome            text not null check (outcome in ('held', 'failed')),
  reason             text check (reason in ('earlier_night', 'no_check', 'tab_closed', 'check_paid',
                       'check_closed', 'alcohol_closed', 'cut_off', 'not_on_menu', 'out_tonight')),
  order_id           uuid,
  cash_payment_id    uuid,
  cash_posted_by     uuid references users (id),
  cash_posted_at     timestamptz,
  created_at         timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, client_order_id),
  check ((outcome = 'failed') = (reason is not null)),
  check ((outcome = 'held') = (order_id is not null)),
  foreign key (venue_id, order_id) references orders (venue_id, id),
  foreign key (venue_id, cash_payment_id) references payments (venue_id, id)
);
create index offline_replays_night on offline_replays (venue_id, queued_on);
create index offline_replays_replayed_on on offline_replays (venue_id, replayed_on);
alter table offline_replays enable row level security;
alter table offline_replays force row level security;
create policy venue_isolation on offline_replays to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on offline_replays to app_rw;
select audit_table('offline_replays');
