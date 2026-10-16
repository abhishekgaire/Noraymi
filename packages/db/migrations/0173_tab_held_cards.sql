-- The card behind the bar on bar tabs (U-23; D134; Staff screens and the bar POS · Tabs without a
-- card). A tab opened by name may keep the guest's card behind the bar, as a room's walk-in does
-- (O-08; D116): the name on the card and its last 4, both optional on a tab, never the full number.
-- `tab_id` is the tab it was taken on; a tab moved into a room carries the card to the room's check
-- (`check_id` moves) and Undo brings it back. The name and last 4 no longer need each other, and the
-- close still clears both.
set lock_timeout = '5s';

alter table check_held_cards add column tab_id uuid;
alter table check_held_cards add constraint check_held_cards_tab_fkey
  foreign key (venue_id, tab_id) references tabs (venue_id, id) not valid;
alter table check_held_cards validate constraint check_held_cards_tab_fkey;

alter table check_held_cards drop constraint check_held_cards_check;
alter table check_held_cards drop constraint check_held_cards_check1;
alter table check_held_cards add constraint check_held_cards_cleared_check
  check (cleared_at is null or (guest_name is null and last4 is null)) not valid;
alter table check_held_cards validate constraint check_held_cards_cleared_check;

grant update (check_id) on check_held_cards to app_rw;
