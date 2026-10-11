-- Modular menu choices (K-12; Data model · Menu, orders and songs; Kitchen and food · Meals,
-- combos and sauces). Every setting is the manager's, in Admin → Menu:
--   * modifier_groups.included_choices: how many picks the price includes (null: no limit
--     priced by the group, each pick costs its own price change only); every pick past it
--     costs extra_choice_cents more ("1 sauce included, each extra $0.75").
--   * modifier_groups.variant_ids: the sizes the group applies to (null: every size).
--   * modifier_groups.when_option_id: the group shows only once that choice of the same item
--     is picked ("Make it a meal" opens "Meal side" and "Meal drink").
--   * menu_options.component_variant_id: the choice is another menu item (a side, a soda),
--     sold as its own line with its own station and tax category, at the choice's price
--     change plus its share of the choice that opened its group.
--   * order_items.parent_item_id and component: a component's line points at the line it
--     came with, and names the choice it was ({ group, name }).
-- Row-level security is unchanged: the new columns sit on venue tables that already force it.
-- The foreign keys between groups and choices form a cycle, so they're deferrable (a restore
-- writes groups before choices; 0122).
set lock_timeout = '5s';

alter table modifier_groups add column included_choices integer;
alter table modifier_groups add constraint modifier_groups_included_check
  check (included_choices is null or included_choices between 0 and 50) not valid;
alter table modifier_groups validate constraint modifier_groups_included_check;
alter table modifier_groups add column extra_choice_cents integer not null default 0;
alter table modifier_groups add constraint modifier_groups_extra_check
  check (extra_choice_cents between 0 and 10000000) not valid;
alter table modifier_groups validate constraint modifier_groups_extra_check;
alter table modifier_groups add column variant_ids uuid[];
alter table modifier_groups add constraint modifier_groups_variant_ids_check
  check (variant_ids is null or cardinality(variant_ids) between 1 and 50) not valid;
alter table modifier_groups validate constraint modifier_groups_variant_ids_check;
alter table modifier_groups add column when_option_id uuid;
alter table modifier_groups add constraint modifier_groups_when_option_fk
  foreign key (venue_id, when_option_id) references menu_options (venue_id, id)
  deferrable initially deferred not valid;
alter table modifier_groups validate constraint modifier_groups_when_option_fk;

alter table menu_options add column component_variant_id uuid;
alter table menu_options add constraint menu_options_component_fk
  foreign key (venue_id, component_variant_id) references menu_variants (venue_id, id) not valid;
alter table menu_options validate constraint menu_options_component_fk;

alter table order_items add column parent_item_id uuid;
alter table order_items add constraint order_items_parent_fk
  foreign key (venue_id, parent_item_id) references order_items (venue_id, id)
  deferrable initially deferred not valid;
alter table order_items validate constraint order_items_parent_fk;
alter table order_items add column component jsonb;
