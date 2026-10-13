-- The room's join QR slip (F-07; D124): printed on the front desk's receipt printer at every room
-- start while Ordering from the room is on, and again with Reprint QR. The QR is the printer's own
-- command; the job's payload holds the join link with the room's current code.
set lock_timeout = '5s';

alter table print_jobs drop constraint print_jobs_kind_check;
alter table print_jobs add constraint print_jobs_kind_check
  check (kind in ('ticket', 'receipt', 'check', 'drawer', 'x_report', 'z_report', 'break_glass', 'room_qr')) not valid;
alter table print_jobs validate constraint print_jobs_kind_check;
