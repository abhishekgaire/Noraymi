-- Stations (K-02; Kitchen and food · Stations; Data model · Room orders).
--   * menu_items.station and order_items.station are bar or kitchen.
--   * orders.station: every order belongs to one station; a basket or round
--     with lines for both becomes one order per station sharing basket_id.
--   * order_items.kitchen_note (up to 200 characters) and
--     kitchen_note_allergy: a line's note for the kitchen, printed on the
--     kitchen ticket and never texted or kept on the guest's record;
--     kitchen_sent_at and kitchen_sent_by: Send to kitchen (K-05);
--     package_id: the package a line came in (K-09).
-- Row-level security is unchanged: the new columns sit on venue tables that
-- already force it.
set lock_timeout = '5s';

alter table menu_items add constraint menu_items_station_check
  check (station in ('bar', 'kitchen')) not valid;
alter table menu_items validate constraint menu_items_station_check;

alter table order_items add constraint order_items_station_check
  check (station in ('bar', 'kitchen')) not valid;
alter table order_items validate constraint order_items_station_check;

alter table orders add column station text not null default 'bar';
alter table orders add constraint orders_station_check
  check (station in ('bar', 'kitchen')) not valid;
alter table orders validate constraint orders_station_check;
alter table orders add column basket_id uuid;

alter table order_items add column kitchen_note text;
alter table order_items add constraint order_items_kitchen_note_check
  check (kitchen_note is null or length(kitchen_note) <= 200) not valid;
alter table order_items validate constraint order_items_kitchen_note_check;
alter table order_items add column kitchen_note_allergy boolean not null default false;
alter table order_items add column kitchen_sent_at timestamptz;
alter table order_items add column kitchen_sent_by uuid;
alter table order_items add column package_id uuid;
alter table order_items add constraint order_items_package_fk
  foreign key (venue_id, package_id) references packages (venue_id, id) not valid;
alter table order_items validate constraint order_items_package_fk;
