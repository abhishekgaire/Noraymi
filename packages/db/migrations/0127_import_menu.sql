-- The menu import (M9-04): the menu goes in through Admin → Menu's save path,
-- so the import (as app_migrator) reads the rule pack for the promotion checks
-- and publishes the bar's grid like Admin → Bar POS. Its references now name
-- each item, variant, choice group, choice and package.
set lock_timeout = '5s';

alter table import_refs drop constraint import_refs_kind_check;
alter table import_refs add constraint import_refs_kind_check
  check (kind in ('guest', 'booking', 'consent', 'menu_category', 'menu_item', 'person', 'nightly_total',
                  'policy', 'menu_variant', 'modifier_group', 'menu_option', 'package')) not valid;
alter table import_refs validate constraint import_refs_kind_check;

-- Rule packs are global and public to every venue; the import reads them like app_rw does.
grant select on rule_pack_signing_keys, rule_packs to app_migrator;
grant update (status, sections, version, published_by, published_at, starts_on) on pos_layouts to app_migrator;

-- The checks read the venue's rule pack; the import sees only its own venue's row.
grant select (id, rule_pack_id) on venues to app_migrator;
create policy restore_wall on venues for select to app_migrator using (id = app_venue_id());
create policy migrator_read on rule_packs for select to app_migrator using (true);
create policy migrator_read on rule_pack_signing_keys for select to app_migrator using (true);
