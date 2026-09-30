set lock_timeout = '5s';
alter table rooms add column display_name text;
update rooms set display_name = name where display_name is null;
