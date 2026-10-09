-- Payment links for staff and big-party bookings, and cardHold (M5-13;
-- Payment flows · Deposit when booking online, step 7; Data model ·
-- bookings.pending_until; Settings · DepositRule mode cardHold).
--   * booking_links.purpose 'payment_link': the link the Payment link text
--     carries (128 bits, stored hashed), beside the booking's own and the
--     confirmation text's.
--   * pay_links.purpose 'card_hold' and pay_links.setup_intent_id: in cardHold
--     mode the payment page saves the card with a SetupIntent and charges
--     nothing; the SetupIntent is made once per link and found again by its id
--     (never by metadata, Stripe setup 6).
set lock_timeout = '5s';

alter table booking_links drop constraint booking_links_purpose_check;
alter table booking_links add constraint booking_links_purpose_check
  check (purpose in ('confirmation', 'payment_link')) not valid;
alter table booking_links validate constraint booking_links_purpose_check;

alter table pay_links drop constraint pay_links_purpose_check;
alter table pay_links add constraint pay_links_purpose_check
  check (purpose in ('balance', 'deposit', 'link', 'card_hold')) not valid;
alter table pay_links validate constraint pay_links_purpose_check;

alter table pay_links add column setup_intent_id text;

-- A cardHold link charges nothing: its amount is 0, every other link's stays above 0.
alter table pay_links drop constraint pay_links_amount_cents_check;
alter table pay_links add constraint pay_links_amount_cents_check
  check (amount_cents > 0 or (purpose = 'card_hold' and amount_cents = 0)) not valid;
alter table pay_links validate constraint pay_links_amount_cents_check;
