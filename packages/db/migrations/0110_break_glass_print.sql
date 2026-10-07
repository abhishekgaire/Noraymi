-- The break-glass card's short version prints on the front-desk receipt
-- printer (M8-06; spec 09 · Break-glass card): a print job of kind
-- break_glass, laid out like a receipt.
set lock_timeout = '5s';

alter table print_jobs drop constraint print_jobs_kind_check;
alter table print_jobs add constraint print_jobs_kind_check
  check (kind in ('ticket', 'receipt', 'check', 'drawer', 'x_report', 'z_report', 'break_glass')) not valid;
alter table print_jobs validate constraint print_jobs_kind_check;
