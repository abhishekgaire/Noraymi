-- Splits (M4-14; Money rules 13; Data model · check_splits, split_shares):
-- a split kept on the server, so a paid share survives leaving the pay
-- screen or switching devices. One open split per check; each share is even
-- (1 of N) or by item, with its own tax and gratuity parts and its own state
-- (open, paying, paid). Payments point at shares through
-- payment_allocations.share_id.
set lock_timeout = '5s';

create table check_splits (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues (id),
  check_id    uuid not null,
  share_count int not null check (share_count >= 2),
  base_cents  bigint not null check (base_cents >= 0),
  created_by  uuid not null,
  created_at  timestamptz not null,
  ended_by    uuid,
  ended_at    timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
create unique index check_splits_one_open on check_splits (venue_id, check_id) where ended_at is null;
alter table check_splits enable row level security;
alter table check_splits force row level security;
create policy venue_isolation on check_splits to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on check_splits to app_rw;
grant update (ended_by, ended_at) on check_splits to app_rw;
select audit_table('check_splits');

create table split_shares (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  split_id       uuid not null,
  share_no       int not null check (share_no >= 1),
  kind           text not null check (kind in ('even', 'items')),
  amount_cents   bigint not null check (amount_cents >= 0),
  tax_cents      bigint not null default 0,
  gratuity_cents bigint not null default 0,
  line_ids       bigint[] not null default '{}',
  room_guest_id  uuid,
  state          text not null default 'open' check (state in ('open', 'paying', 'paid')),
  unique (venue_id, id),
  unique (venue_id, split_id, share_no),
  foreign key (venue_id, split_id) references check_splits (venue_id, id)
);
alter table split_shares enable row level security;
alter table split_shares force row level security;
create policy venue_isolation on split_shares to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on split_shares to app_rw;
grant update (state, room_guest_id) on split_shares to app_rw;
select audit_table('split_shares');

alter table payment_allocations add constraint payment_allocations_share_fk
  foreign key (venue_id, share_id) references split_shares (venue_id, id) not valid;
alter table payment_allocations validate constraint payment_allocations_share_fk;
