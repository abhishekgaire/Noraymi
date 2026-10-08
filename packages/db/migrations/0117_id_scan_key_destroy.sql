-- M8-14 · Destroying each night's ID-scan key after 7 days (spec 12 · 6 and
-- How long we keep things; spec 04 · id_checks). The night's data key now
-- lives in the key store outside the database (key_ref names it), so no
-- database backup holds it; wrapped_key stays only for keys made before this
-- migration. The retention job (app_retention, M8-12) finds the nights whose
-- time is up and, once the key store has destroyed the key, marks the row
-- destroyed. Each destruction is an audit row.
set lock_timeout = '5s';

alter table id_scan_keys add column key_ref text;

create policy retention_wall on id_scan_keys to app_retention
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
create policy retention_wall on id_checks to app_retention
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select on id_scan_keys, id_checks to app_retention;
grant update (wrapped_key, destroyed_at) on id_scan_keys to app_retention;

select audit_table('id_scan_keys');
-- The audit names that a key changed, never the wrapped key itself (as in 0039).
set role app_migrator;
insert into audit_redactions values ('id_scan_keys', 'wrapped_key');
reset role;
