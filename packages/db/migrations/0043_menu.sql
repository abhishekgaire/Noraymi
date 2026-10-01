-- The menu (M3-03; spec 04 · Menu, orders and songs): categories, items,
-- their variants and choices, packages and dated price rules. An item has no
-- price of its own: every item has at least one variant, which carries it.
-- out_until is 86: an item, variant or choice is out while out_until is later
-- than now; it's set to the end of the business date (the next 6:00 AM
-- cutover), and the night close (M7) clears it sooner.
set lock_timeout = '5s';

create table menu_categories (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  name          text not null check (length(name) between 1 and 80),
  sort          integer not null default 0,
  tax_category  text not null default 'drink',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (venue_id, id)
);

create table menu_items (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  category_id   uuid not null,
  name          text not null check (length(name) between 1 and 120),
  button_name   text check (button_name is null or length(button_name) between 1 and 24),
  description   text check (description is null or length(description) <= 500),
  alcohol       boolean not null default false,
  station       text not null default 'bar',
  shown         boolean not null default true,
  sort          integer not null default 0,
  out_until     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, category_id) references menu_categories (venue_id, id)
);
create index menu_items_category_idx on menu_items (venue_id, category_id);

create table menu_variants (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  item_id       uuid not null,
  name          text not null check (length(name) between 1 and 80),
  price_cents   integer not null check (price_cents >= 0),
  sort          integer not null default 0,
  out_until     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, item_id) references menu_items (venue_id, id)
);
create index menu_variants_item_idx on menu_variants (venue_id, item_id);

create table modifier_groups (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  item_id       uuid not null,
  name          text not null check (length(name) between 1 and 80),
  required      boolean not null default false,
  min_choices   integer not null default 0 check (min_choices >= 0),
  max_choices   integer not null default 1 check (max_choices >= 1),
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (venue_id, id),
  check (min_choices <= max_choices),
  foreign key (venue_id, item_id) references menu_items (venue_id, id)
);
create index modifier_groups_item_idx on modifier_groups (venue_id, item_id);

-- A choice in a group: a flavor (Raspberry), a way (Rocks) or an add-on (Red Bull +$6.00).
create table menu_options (
  id                 uuid primary key default gen_random_uuid(),
  venue_id           uuid not null references venues (id),
  item_id            uuid not null,
  group_id           uuid not null,
  name               text not null check (length(name) between 1 and 80),
  price_delta_cents  integer not null default 0 check (price_delta_cents >= 0),
  is_default         boolean not null default false,
  sort               integer not null default 0,
  out_until          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, item_id) references menu_items (venue_id, id),
  foreign key (venue_id, group_id) references modifier_groups (venue_id, id)
);
create index menu_options_group_idx on menu_options (venue_id, group_id);

create table packages (
  id                     uuid primary key default gen_random_uuid(),
  venue_id               uuid not null references venues (id),
  name                   text not null check (length(name) between 1 and 120),
  price_cents            integer not null check (price_cents >= 0),
  hourly                 boolean not null default false,
  contents               jsonb not null default '[]',   -- [{ item_id, qty | null }]
  private_function_only  boolean not null default false,
  shown                  boolean not null default true,
  checked_pack_version   text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (venue_id, id)
);

create table price_rules (
  id                    uuid primary key default gen_random_uuid(),
  venue_id              uuid not null references venues (id),
  name                  text not null check (length(name) between 1 and 120),
  kind                  text not null check (kind in ('happy_hour', 'special', 'hourly')),
  days                  smallint[] not null default '{0,1,2,3,4,5,6}',
  from_min              integer check (from_min between 0 and 1799),
  to_min                integer check (to_min between 1 and 1800),
  target                jsonb not null,                   -- { item_ids, qty }
  pct_off               integer check (pct_off between 1 and 100),
  price_cents           integer check (price_cents >= 0),
  starts_on             date,
  ends_on               date,
  shown                 boolean not null default true,
  checked_pack_version  text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (venue_id, id),
  check ((pct_off is null) <> (price_cents is null)),
  check (starts_on is null or ends_on is null or starts_on <= ends_on)
);

alter table menu_categories enable row level security;
alter table menu_categories force row level security;
create policy venue_isolation on menu_categories to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
alter table menu_items enable row level security;
alter table menu_items force row level security;
create policy venue_isolation on menu_items to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
alter table menu_variants enable row level security;
alter table menu_variants force row level security;
create policy venue_isolation on menu_variants to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
alter table modifier_groups enable row level security;
alter table modifier_groups force row level security;
create policy venue_isolation on modifier_groups to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
alter table menu_options enable row level security;
alter table menu_options force row level security;
create policy venue_isolation on menu_options to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
alter table packages enable row level security;
alter table packages force row level security;
create policy venue_isolation on packages to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
alter table price_rules enable row level security;
alter table price_rules force row level security;
create policy venue_isolation on price_rules to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());

grant select, insert, update on menu_categories, menu_items, menu_variants, modifier_groups,
  menu_options, packages, price_rules to app_rw;

select audit_table('menu_categories');
select audit_table('menu_items');
select audit_table('menu_variants');
select audit_table('modifier_groups');
select audit_table('menu_options');
select audit_table('packages');
select audit_table('price_rules');
