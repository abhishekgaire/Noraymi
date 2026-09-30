set lock_timeout = '5s';
grant delete on check_lines to app_rw;
grant update (amount_cents) on check_lines to app_rw;
grant update on payments to app_rw;
grant truncate on rooms to app_rw;
grant all on rooms to app_rw;
