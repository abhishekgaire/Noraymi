-- Bar tabs (M6-02; Data model · tabs; Payment flows · bar tabs): a card-first
-- tab on a bar check. M6-02 lists them on the bar POS; opening one on a card
-- with its hold comes with M6-06, so payment_id and the consent's policy
-- version are filled in from there.
set lock_timeout = '5s';

create table tabs (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid not null references venues (id),
  check_id             uuid not null,
  payment_id           uuid,
  state                text not null default 'open' check (state in
                         ('open', 'tipping', 'awaiting_tip', 'captured', 'walkout_captured', 'capture_failed', 'closed')),
  -- The name the bar knows the tab by ("Jess P.", "Seat 6 · blue jacket"), and where it sits ("Seat 3").
  name                 text not null check (length(name) between 1 and 80),
  label                text check (length(label) <= 80),
  card_brand           text,
  card_last4           text check (card_last4 ~ '^[0-9]{4}$'),
  card_fingerprint     text,
  hold_cents           integer not null default 0 check (hold_cents >= 0),
  party_size           integer check (party_size >= 1),
  owner_id             uuid,
  opened_by            uuid,
  opened_at            timestamptz not null,
  consent_text_version uuid,
  consent_read_by      uuid,
  receipt_printed_at   timestamptz,
  cut_off_at           timestamptz,
  cut_off_by           uuid,
  cut_off_reason       text,
  moved_to_check_id    uuid,
  closed_at            timestamptz,
  closed_by            uuid,
  reopened_at          timestamptz,
  unique (venue_id, id),
  unique (venue_id, check_id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, moved_to_check_id) references checks (venue_id, id)
);
-- One open tab per card.
create unique index tabs_one_open_per_card on tabs (venue_id, card_fingerprint)
  where card_fingerprint is not null and state in ('open', 'tipping');
create index tabs_by_opened on tabs (venue_id, opened_at);
alter table tabs enable row level security;
alter table tabs force row level security;
create policy venue_isolation on tabs to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on tabs to app_rw;
select audit_table('tabs');
