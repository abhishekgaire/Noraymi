set lock_timeout = '5s';
alter table rooms add column display_name text;
set role app_migrator;
update rooms set display_name = name where display_name is null;
reset role;
create table seeds (id int primary key, label text);
insert into seeds values (1, 'a new table may be seeded as the owner');
