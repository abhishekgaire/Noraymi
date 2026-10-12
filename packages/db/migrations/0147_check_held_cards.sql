-- Keep the card behind the bar (O-08; D116; spec 03 · DepositRule.walkIn
-- "cardBehindBar"). After a walk-in is seated, staff keep the guest's physical
-- card and type the name on it and its last 4 digits; they're saved on the
-- room's check. No reader, no Stripe call, nothing charged; a full card number
-- is never accepted (the last 4 are exactly four digits). Close-out ends with
-- "Give the card back" (returned_by, returned_at), Close the night lists a card
-- not returned, and the close clears the name and last 4 (cleared_at), keeping
-- only who took and returned the card and when. The audit log never holds the
-- name or the last 4. A room moved keeps its check, so its card.
set lock_timeout = '5s';

create table check_held_cards (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  check_id      uuid not null,
  business_date date not null,
  guest_name    text check (guest_name is null or char_length(guest_name) between 1 and 60),
  last4         text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  taken_by      uuid not null references users (id),
  taken_at      timestamptz not null,
  returned_by   uuid references users (id),
  returned_at   timestamptz,
  cleared_at    timestamptz,
  check ((guest_name is null) = (last4 is null)),
  check ((guest_name is null) = (cleared_at is not null)),
  check ((returned_by is null) = (returned_at is null)),
  unique (venue_id, id),
  unique (venue_id, check_id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
-- A closed night takes no new card (M7's guard, as on every table with a business date).
create trigger closed_night_guard before insert or update of business_date on check_held_cards
  for each row execute function refuse_closed_night();
alter table check_held_cards enable row level security;
alter table check_held_cards force row level security;
create policy venue_isolation on check_held_cards to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on check_held_cards to app_rw;
grant update (returned_by, returned_at, guest_name, last4, cleared_at) on check_held_cards to app_rw;

set role app_migrator;
insert into audit_redactions values
  ('check_held_cards', 'guest_name'),
  ('check_held_cards', 'last4');
reset role;
select audit_table('check_held_cards');
