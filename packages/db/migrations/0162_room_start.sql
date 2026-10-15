-- Starting a room (P-04; D131): a note on the room, shown on its tile and at close-out; a prepaid
-- block (the party bills at least its minutes, at the room's rate or as a package's room-time share,
-- spec 05 · rule 3); and the package it started with. A package may carry a length of room time,
-- which only an at-start sale uses. Row-level security is unchanged: room_sessions and packages
-- already force it.
set lock_timeout = '5s';

alter table room_sessions
  add column note text check (note is null or length(note) between 1 and 200),
  add column prepaid_minutes integer check (prepaid_minutes between 15 and 720),
  add column prepaid_cents integer check (prepaid_cents >= 0),
  add column package_id uuid,
  add constraint room_sessions_prepaid_check
    check ((prepaid_minutes is null) = (prepaid_cents is null));

alter table packages
  add column minutes integer check (minutes between 15 and 720),
  add constraint packages_minutes_not_hourly_check check (minutes is null or not hourly);
