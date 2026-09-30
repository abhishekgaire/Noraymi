set lock_timeout = '5s';
set role app_migrator;
insert into check_lines (venue_id, check_id, kind, description, unit_cents, amount_cents)
  select venue_id, id, 'fee', 'migrated', 0, 0 from checks where false;
update rooms set name = trim(name) where name <> trim(name);
reset role;
