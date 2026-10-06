-- The hold-expiry watch and the awaiting-tip sweeper (M6-17; Payment flows ·
-- Bar tab with a growing hold, steps 6 and 7; Data model · Tabs at the cut-off
-- and at close).
--  - `tab_closings.swept_at`: a paper slip whose tip was never entered, captured
--    by the sweeper at a tip of 0, 12 hours before its hold's `capture_before`
--    (the flag the manager sees).
--  - `tabs.hold_expiry_alerted_at`: when the manager on duty was told the tab's
--    hold had under 12 hours left, once per hold.
set lock_timeout = '5s';

alter table tab_closings add column swept_at timestamptz;
alter table tabs add column hold_expiry_alerted_at timestamptz;
