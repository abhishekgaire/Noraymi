-- A bar tab's growing hold (M6-07; Payment flows · Bar tab with a growing
-- hold, steps 3 and 4; Data model · tabs). A declined raise leaves the old
-- hold good and marks the tab: its badge reads "Hold raise declined" and new
-- drinks on it wait for a manager (approvals kind over_hold) until another
-- card is added. A tab passing tabs.flagOverCents is shown once on the
-- manager on duty's phone; the time it passed is kept so it's shown once.
set lock_timeout = '5s';

alter table tabs add column hold_declined_at timestamptz;
alter table tabs add column flagged_over_at timestamptz;
