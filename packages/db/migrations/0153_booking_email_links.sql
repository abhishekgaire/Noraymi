-- Every booking is emailed to the guest (F-06; D124): each email carries its own manage link, a
-- 128-bit token stored hashed like the confirmation text's, with its own purpose so the text's
-- "sent once" check never mistakes an email's link for the text's.
set lock_timeout = '5s';

alter table booking_links drop constraint booking_links_purpose_check;
alter table booking_links add constraint booking_links_purpose_check
  check (purpose in ('confirmation', 'payment_link', 'email')) not valid;
alter table booking_links validate constraint booking_links_purpose_check;
