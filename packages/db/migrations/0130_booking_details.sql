-- The booking's Details and Terms steps (M5-08; Payment flows · Deposit when
-- booking online, step 2; Song systems and texts · Consent and timing): the
-- booking form's marketing box keeps its exact wording as a policy version
-- (kind `marketing_opt_in`, SHA-256 and all), and a ticked box's `consents`
-- row names that version in `text_version`, with the form, the IP address and
-- the time. The guest, the policy version accepted and the acceptance's time,
-- IP address and browser already have their columns on `bookings` (0029).
set lock_timeout = '5s';

alter table policy_versions drop constraint policy_versions_kind_check;
alter table policy_versions add constraint policy_versions_kind_check
  check (kind in ('deposit', 'tab_consent', 'room_card_consent', 'imported_terms', 'marketing_opt_in')) not valid;
alter table policy_versions validate constraint policy_versions_kind_check;
