-- Opening a bar tab card first (M6-06; Payment flows · Bar tab with a growing
-- hold, steps 1 and 2; Data model · tabs, policy_versions). The consent line
-- read out at New tab is a policy version of its own kind, and a tab being
-- opened waits in tab_openings while the bar reader collects the card: the
-- fingerprint is checked before the hold is confirmed, and the tab is made
-- only once the hold is placed (or the card's open tab is opened instead).
set lock_timeout = '5s';

alter table policy_versions drop constraint policy_versions_kind_check;
alter table policy_versions add constraint policy_versions_kind_check
  check (kind in ('deposit', 'tab_consent')) not valid;
alter table policy_versions validate constraint policy_versions_kind_check;

-- The wording read out at opening is a published policy version.
alter table tabs add constraint tabs_consent_version_fk
  foreign key (venue_id, consent_text_version) references policy_versions (venue_id, id) not valid;
alter table tabs validate constraint tabs_consent_version_fk;

create table tab_openings (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid not null references venues (id),
  -- The opening hold's card payment: the reader collects on it, and it becomes the tab's hold.
  payment_id           uuid not null,
  -- The new tab's check number, taken first in its own transaction, so a declined card keeps it.
  check_number         integer not null,
  name                 text check (length(name) between 1 and 80),
  label                text check (length(label) between 1 and 80),
  party_size           integer check (party_size >= 1),
  consent_text_version uuid not null,
  consent_read_by      uuid not null,
  opened_by            uuid not null,
  -- Whose Quick sale drinks move onto the tab, unsent.
  membership_id        uuid,
  card_brand           text,
  card_last4           text check (card_last4 ~ '^[0-9]{4}$'),
  card_fingerprint     text,
  -- "Jess P." from a dip or swipe; a tap or a phone brings no name.
  card_name            text,
  -- waiting: the reader has it; opened: a new tab with its hold; existing: the card's open tab,
  -- with no second hold; canceled: nothing was opened.
  state                text not null default 'waiting' check (state in ('waiting', 'opened', 'existing', 'canceled')),
  tab_id               uuid,
  created_at           timestamptz not null,
  settled_at           timestamptz,
  unique (venue_id, id),
  unique (venue_id, payment_id),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, tab_id) references tabs (venue_id, id),
  foreign key (venue_id, consent_text_version) references policy_versions (venue_id, id),
  check ((state in ('opened', 'existing')) = (tab_id is not null))
);
create index tab_openings_by_created on tab_openings (venue_id, created_at);
alter table tab_openings enable row level security;
alter table tab_openings force row level security;
create policy venue_isolation on tab_openings to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on tab_openings to app_rw;
select audit_table('tab_openings');
