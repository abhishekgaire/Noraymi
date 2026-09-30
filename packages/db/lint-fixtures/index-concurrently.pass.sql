set lock_timeout = '5s';
create table fresh (id uuid primary key, name text);
create index fresh_name on fresh (name);              -- new table: fine
create index concurrently things_name on things (name);
