set lock_timeout = '5s';
grant select, insert on checks to app_rw;
grant update (status, revision, version, paid_at) on checks to app_rw;
grant select, insert, update on rooms to app_rw;
grant delete on scratch_notes to app_ro_reporting;
