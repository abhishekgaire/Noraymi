set lock_timeout = '5s';
alter table audit_log add column note text;
alter table venue_events add column source text null;
