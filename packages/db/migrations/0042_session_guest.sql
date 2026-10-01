-- A session's guest (M2-32): the booking's guest, or a walk-in's ("Leo M.'s
-- walk-in in Room 5"), which had nowhere to live.
set lock_timeout = '5s';

alter table room_sessions add column guest_id uuid;
alter table room_sessions
  add constraint room_sessions_guest_fkey foreign key (venue_id, guest_id) references guests (venue_id, id) not valid;
alter table room_sessions validate constraint room_sessions_guest_fkey;
