-- Cancelling, no-shows and the venue cancelling (M5-12; Payment flows · Deposit
-- when booking online, steps 4 and 6; Money rules 11).
--   * bookings.cancelled_via: who cancelled, when it wasn't a lapsed hold:
--     'guest' from the manage page, 'venue' when a blocked date cancels it.
--     Empty means a hold that lapsed (or a staff cancel from M2), so a deposit
--     landing late after a guest's or the venue's cancel is refunded in full by
--     rule instead of confirming the booking again.
--   * checks.opened_by may be empty for a check the system opens by rule: the
--     `fee` check that keeps a deposit when a guest cancels after the refund
--     cut-off, with no one on staff asking.
set lock_timeout = '5s';

alter table bookings add column cancelled_via text
  check (cancelled_via in ('guest', 'venue'));

alter table checks alter column opened_by drop not null;
