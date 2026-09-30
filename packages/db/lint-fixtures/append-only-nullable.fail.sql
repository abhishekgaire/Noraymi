set lock_timeout = '5s';
alter table audit_log add column note text not null default '';
