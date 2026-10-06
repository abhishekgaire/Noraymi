-- The paper tip slip (M6-09; Payment flows · Bar tab with a growing hold,
-- steps 5 and 7; Data model · tab_closings, approvals kind tip_review,
-- payments.adjusts_business_date). Printing the slip (a reader that's offline,
-- a guest who asks for one, a tip screen untouched for 2 minutes, or a venue
-- whose bar tabs tip on paper) moves the tab to awaiting_tip with its hold
-- standing. The Close row then waits as `slip` until a staff phone types the
-- tip in from the signed slip, with a photo of it; the capture follows as on
-- the reader. A tip over 25% or $50, or entered more than 2 hours after the
-- slip, waits for a manager (tip_approval_id) before anything is captured.
set lock_timeout = '5s';

alter table tab_closings drop constraint tab_closings_path_check;
alter table tab_closings add constraint tab_closings_path_check
  check (path in ('reader', 'none', 'slip')) not valid;
alter table tab_closings validate constraint tab_closings_path_check;

-- slip: printed, waiting for the tip from the signed slip (the tab is awaiting_tip).
alter table tab_closings drop constraint tab_closings_state_check;
alter table tab_closings add constraint tab_closings_state_check
  check (state in ('asking', 'custom', 'raising', 'capturing', 'captured', 'canceled', 'timed_out', 'failed',
                   'slip')) not valid;
alter table tab_closings validate constraint tab_closings_state_check;

-- When the slip printed: a tip typed in more than 2 hours later needs approval.
alter table tab_closings add column slip_printed_at timestamptz;
-- The photo of the signed slip (files kind slip_photo); no tip goes in without it.
alter table tab_closings add column slip_photo_file_id uuid;
alter table tab_closings add constraint tab_closings_slip_photo_fk
  foreign key (venue_id, slip_photo_file_id) references files (venue_id, id) not valid;
alter table tab_closings validate constraint tab_closings_slip_photo_fk;
-- Who typed the tip in, and when; and the tip_review approval it waits on, if any.
alter table tab_closings add column tip_entered_by uuid;
alter table tab_closings add column tip_entered_at timestamptz;
alter table tab_closings add column tip_approval_id uuid;

-- A tip typed in after its night's Z report posts to the next business date, with adjusts_business_date
-- pointing at the night it belongs to (Money rules 16): the capture moves the payment's date.
grant update (business_date, adjusts_business_date) on payments to app_rw;
