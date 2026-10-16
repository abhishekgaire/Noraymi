-- Inventory (P-16; spec 04 · Inventory; module inventory, off by default). A stock count per menu
-- item, or per variant when the venue counts its sizes apart. A sale takes it down when its line
-- joins a check (Accept, the bar POS, a quick sale, a replayed offline round), a void that wasn't
-- made puts it back, and Receive, Count and Adjust (with a reason) change it by hand. Every change
-- is a row in `stock_moves`, the ledger Reports → Stock adds up by business date; practice
-- (training) checks never move stock. A count can go below zero: it shows what was sold past it.
set lock_timeout = '5s';

create table stock_levels (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  item_id       uuid not null,
  -- Null counts the item whatever its size; a variant's own level wins for that variant.
  variant_id    uuid,
  on_hand       integer not null default 0 check (on_hand between -100000 and 1000000),
  -- At or below this the manager is told; null never tells.
  low_at        integer check (low_at is null or low_at between 0 and 100000),
  -- Counting stopped: the row stays for the ledger, and sales no longer move it.
  active        boolean not null default true,
  -- This level 86'd its item or variant at zero; it comes back when the count does.
  auto_out      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, item_id) references menu_items (venue_id, id),
  foreign key (venue_id, variant_id) references menu_variants (venue_id, id)
);
create unique index stock_levels_item_once on stock_levels (venue_id, item_id) where variant_id is null;
create unique index stock_levels_variant_once on stock_levels (venue_id, variant_id) where variant_id is not null;
alter table stock_levels enable row level security;
alter table stock_levels force row level security;
create policy venue_isolation on stock_levels to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on stock_levels to app_rw;
grant update (on_hand, low_at, active, auto_out, updated_at) on stock_levels to app_rw;
create policy restore_wall on stock_levels to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on stock_levels to app_migrator;
select audit_table('stock_levels');

create table stock_moves (
  id            bigint generated always as identity primary key,
  venue_id      uuid not null references venues (id),
  stock_id      uuid not null,
  kind          text not null check (kind in ('sale', 'void', 'receive', 'count', 'adjust')),
  delta         integer not null check (delta between -1000000 and 1000000),
  on_hand_after integer not null,
  reason        text check (reason is null or char_length(btrim(reason)) between 1 and 200),
  -- The sale's or void's line on its check.
  line_id       bigint,
  business_date date not null,
  by_user       uuid references users (id),
  at            timestamptz not null,
  check (kind <> 'adjust' or reason is not null),
  check ((kind in ('sale', 'void')) = (line_id is not null)),
  unique (venue_id, id),
  foreign key (venue_id, stock_id) references stock_levels (venue_id, id)
);
-- A line moves its stock once, however often its path is replayed.
create unique index stock_moves_line_once on stock_moves (venue_id, line_id) where line_id is not null;
create index stock_moves_date_idx on stock_moves (venue_id, business_date);
create trigger closed_night_guard before insert or update of business_date on stock_moves
  for each row execute function refuse_closed_night();
alter table stock_moves enable row level security;
alter table stock_moves force row level security;
create policy venue_isolation on stock_moves to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on stock_moves to app_rw;
create policy restore_wall on stock_moves to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on stock_moves to app_migrator;
select audit_table('stock_moves');
