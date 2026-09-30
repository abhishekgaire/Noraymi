set lock_timeout = '5s';
set role app_migrator;
update check_lines set amount_cents = 0 where amount_cents is null;
delete from payments where status = 'void';
reset role;
