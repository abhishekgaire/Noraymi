-- Online booking holds (M5-07; Payment flows · Deposit when booking online,
-- step 1; Data model · bookings.pending_until): picking a slot creates a
-- pending web booking with a real room and a hold block for 10 minutes,
-- before the guest has given a name. The guest is filled in at Details
-- (M5-08); a hold that lapses without one is cancelled.
set lock_timeout = '5s';

alter table bookings alter column guest_id drop not null;
alter table bookings add constraint bookings_guest_known
  check (guest_id is not null or (source = 'web' and status in ('pending', 'cancelled'))) not valid;
alter table bookings validate constraint bookings_guest_known;

-- "More time": each extension adds 10 minutes to the hold, at least ten times (WCAG 2.2 timing).
alter table bookings add column hold_extensions integer not null default 0
  check (hold_extensions between 0 and 100);
