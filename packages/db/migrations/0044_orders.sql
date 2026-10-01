-- Room orders (M3-06; spec 04 · orders, order_items, print_jobs, Room orders).
-- An order moves ringing → held → accepted → ready → on_the_way → delivered,
-- with returned and cancelled as the side exits; accepted_at is the sale.
-- Its items copy the price, name, alcohol flag and tax category at order
-- time, so a menu edit, the 4 AM stop and the cut-offs all read what was
-- ordered. room_guest_id gets its key when room guests arrive (M3-08), and
-- the gift columns when singers and bar tabs do (M6).
set lock_timeout = '5s';

create table orders (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references venues (id),
  check_id            uuid not null,
  session_id          uuid,
  room_guest_id       uuid,
  source              text not null check (source in ('room', 'staff', 'gift', 'offline')),
  status              text not null default 'ringing' check (status in ('ringing', 'held', 'accepted',
                        'ready', 'on_the_way', 'delivered', 'returned', 'cancelled')),
  cancel_reason       text check (cancel_reason in ('guest', 'staff', 'declined', 'alcohol_closed', 'cut_off')),
  client_order_id     text check (client_order_id is null or length(client_order_id) between 8 and 64),
  placed_by           uuid,               -- a user, for a staff order
  placed_at           timestamptz not null,
  business_date       date not null,
  gift_for_singer_id  uuid,
  gift_for_check_id   uuid,
  same_again_of       uuid,
  held_by             uuid,
  held_at             timestamptz,
  accepted_by         uuid,
  accepted_at         timestamptz,
  escalated_at        timestamptz,
  ready_by            uuid,
  ready_at            timestamptz,
  claimed_by          uuid,
  claimed_at          timestamptz,
  delivered_by        uuid,
  delivered_at        timestamptz,
  returned_by         uuid,
  returned_at         timestamptz,
  returned_reason     text check (returned_reason in ('no_id', 'too_drunk', 'nobody_there', 'other')),
  returned_note       text check (returned_note is null or length(returned_note) <= 300),
  return_resolution   text check (return_resolution in ('void_not_made', 'void_made', 'remake')),
  cancelled_by        uuid,
  cancelled_at        timestamptz,
  decline_reason      text check (decline_reason is null or length(decline_reason) between 1 and 200),
  version             integer not null default 0,
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, same_again_of) references orders (venue_id, id),
  check ((status = 'cancelled') = (cancel_reason is not null)),
  check (cancel_reason <> 'declined' or decline_reason is not null)
);
create unique index orders_client_order_idx on orders (venue_id, client_order_id)
  where client_order_id is not null;
create index orders_status_idx on orders (venue_id, status)
  where status in ('ringing', 'held', 'accepted', 'ready', 'on_the_way', 'returned');
create index orders_session_idx on orders (venue_id, session_id);

create table order_items (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  order_id       uuid not null,
  variant_id     uuid,
  item_id        uuid,
  options        jsonb not null default '[]',   -- [{ group, name, price_delta_cents }]
  qty            integer not null check (qty between 1 and 100),
  unit_cents     integer not null check (unit_cents >= 0),
  name_snapshot  text not null,
  alcohol        boolean not null,
  tax_category   text not null default 'drink',
  station        text not null default 'bar',
  notes          text check (notes is null or length(notes) <= 200),
  sort           integer not null default 0,
  unique (venue_id, id),
  foreign key (venue_id, order_id) references orders (venue_id, id),
  foreign key (venue_id, variant_id) references menu_variants (venue_id, id),
  foreign key (venue_id, item_id) references menu_items (venue_id, id)
);
create index order_items_order_idx on order_items (venue_id, order_id);

-- Tickets and receipts to print (M3-13 and M3-14 print them). job_token is the CloudPRNT token.
create table print_jobs (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  device_id     uuid,
  order_id      uuid,
  check_id      uuid,
  kind          text not null check (kind in ('ticket', 'receipt', 'check')),
  station       text not null default 'bar',
  payload       jsonb not null,
  status        text not null default 'queued' check (status in ('queued', 'sent', 'printed', 'failed')),
  job_token     text,
  reprint_of    uuid,
  reprint_n     integer not null default 0,
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  unique (venue_id, id),
  check ((order_id is null) <> (check_id is null)),
  foreign key (venue_id, device_id) references devices (venue_id, id),
  foreign key (venue_id, order_id) references orders (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, reprint_of) references print_jobs (venue_id, id)
);
create index print_jobs_queued_idx on print_jobs (venue_id, status) where status in ('queued', 'sent');

alter table orders enable row level security;
alter table orders force row level security;
create policy venue_isolation on orders to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
alter table order_items enable row level security;
alter table order_items force row level security;
create policy venue_isolation on order_items to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
alter table print_jobs enable row level security;
alter table print_jobs force row level security;
create policy venue_isolation on print_jobs to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());

grant select, insert, update on orders to app_rw;
grant select, insert on order_items to app_rw;
grant select, insert, update on print_jobs to app_rw;

select audit_table('orders');
select audit_table('order_items');
select audit_table('print_jobs');
