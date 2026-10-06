-- The X and Z reports print on the front-desk receipt printer (M7-13; spec 08
-- · Night close): print jobs of kind x_report and z_report, laid out like a
-- receipt.
set lock_timeout = '5s';

alter table print_jobs drop constraint print_jobs_kind_check;
alter table print_jobs add constraint print_jobs_kind_check
  check (kind in ('ticket', 'receipt', 'check', 'drawer', 'x_report', 'z_report')) not valid;
alter table print_jobs validate constraint print_jobs_kind_check;
