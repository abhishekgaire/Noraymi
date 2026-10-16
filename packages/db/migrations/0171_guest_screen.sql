-- Guest screen (P-18; module guest_screen, off by default). A second monitor on a bar computer (a
-- desktop-app window) or a paired device of kind guest_display shows the guest the check being rung
-- up at one register: the lines, tax, gratuity, the total and the cash price; idle, the venue's name.
-- The register says what it shows (guest_screens, one row per register, replaced whole each time so
-- the screen never mixes two checks); the screen reads it through the API, which works the amounts
-- out with packages/rules. No amounts are kept here. A paired guest display names the register it
-- follows (devices.follows_device_id); empty, it follows the venue's only bar computer.
-- guest_screens is screen state, like heartbeats: not audited.
set lock_timeout = '5s';

alter table devices drop constraint devices_kind_check;
alter table devices add constraint devices_kind_check
  check (kind in ('bar_computer', 'front_desk', 'room_tablet', 'reader', 'printer', 'nfc_reader', 'router',
                  'staff_phone', 'up_next_display', 'mic_outlet', 'kitchen_display', 'guest_display')) not valid;
alter table devices validate constraint devices_kind_check;

alter table devices add column follows_device_id uuid;
alter table devices add constraint devices_follows_device_fkey
  foreign key (venue_id, follows_device_id) references devices (venue_id, id) not valid;
alter table devices validate constraint devices_follows_device_fkey;

create table guest_screens (
  venue_id       uuid not null references venues (id),
  -- The register: the bar or front-desk computer the bar POS runs on.
  device_id      uuid not null,
  -- The check on the register (a tab, a room, a quick sale once Pay made it); null shows the venue's name.
  check_id       uuid,
  -- Whether the screen also shows this person's unsent drinks for that check (or the quick sale's).
  membership_id  uuid,
  draft          boolean not null default false,
  version        bigint not null default 1,
  updated_at     timestamptz not null,
  primary key (venue_id, device_id),
  check (not draft or membership_id is not null),
  foreign key (venue_id, device_id) references devices (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, membership_id) references memberships (venue_id, id)
);
alter table guest_screens enable row level security;
alter table guest_screens force row level security;
create policy venue_isolation on guest_screens to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on guest_screens to app_rw;
create policy restore_wall on guest_screens to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert, update on guest_screens to app_migrator;
