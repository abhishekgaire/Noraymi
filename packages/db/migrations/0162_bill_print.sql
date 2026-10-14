-- The bill before paying (P-01): Print the bill on a room's close-out, Present the check and a bar
-- tab prints a print job of kind `bill` on the station's receipt printer, laid out like a receipt
-- and ending "This is not a receipt". Reprints are new rows, numbered by reprint_n and audited.
set lock_timeout = '5s';

alter table print_jobs drop constraint print_jobs_kind_check;
alter table print_jobs add constraint print_jobs_kind_check
  check (kind in ('ticket', 'receipt', 'check', 'drawer', 'x_report', 'z_report', 'break_glass', 'room_qr', 'bill')) not valid;
alter table print_jobs validate constraint print_jobs_kind_check;
