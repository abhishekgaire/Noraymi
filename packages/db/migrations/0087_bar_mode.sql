-- Bar mode's song queue (M6-18; Song systems and texts · Bar mode: Joining,
-- Rotation and Credits; Data model · singers, song_credits, song_queue).
--  - `singers`: someone singing at the bar, with a display name and a phone
--    number confirmed once by a code, and a tab (check_id) only once they owe
--    something. The Up next TV never shows the number.
--  - `song_nights`: one row per business date that bar mode ran, holding how
--    many songs were sung; every change to the queue locks it, so two songs
--    can't take the same place.
--  - `song_queue`: round-robin by singer, round and position; a staff move
--    records who and why on the song and in `song_queue_moves`.
--  - `song_credits`: one song each, from a drink (the drink's check line and
--    which of its units) or prepaid (bought at the song price through the
--    prepaid-value ledger). Queuing a song holds one, starting spends it, and a
--    comp or void of the drink forfeits a credit not yet spent. The credit
--    points at its song (used_by_queue_id); the song's credit_id copies it
--    without a second foreign key, so the two tables don't hold each other.
set lock_timeout = '5s';

create table singers (
  id                 uuid primary key default gen_random_uuid(),
  venue_id           uuid not null references venues (id),
  display_name       text not null check (length(display_name) between 1 and 40),
  phone_e164         text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_verified_at  timestamptz,
  code_hash          text,
  code_expires_at    timestamptz,
  code_attempts      integer not null default 0,
  token_hash         text unique,
  check_id           uuid,
  added_by           uuid,
  joined_at          timestamptz not null,
  last_song_at       timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
-- A number is confirmed for one singer per venue.
create unique index singers_one_per_phone on singers (venue_id, phone_e164)
  where phone_verified_at is not null;
create index singers_by_check on singers (venue_id, check_id) where check_id is not null;
alter table singers enable row level security;
alter table singers force row level security;
create policy venue_isolation on singers to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on singers to app_rw;
select audit_table('singers');

create table song_nights (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  business_date  date not null,
  started_at     timestamptz not null,
  songs_sung     integer not null default 0 check (songs_sung >= 0),
  unique (venue_id, id),
  unique (venue_id, business_date)
);
alter table song_nights enable row level security;
alter table song_nights force row level security;
create policy venue_isolation on song_nights to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on song_nights to app_rw;
select audit_table('song_nights');

create table song_queue (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  business_date  date not null,
  singer_id      uuid not null,
  check_id       uuid,
  title          text not null check (length(title) between 1 and 120),
  artist         text check (length(artist) <= 120),
  catalog_id     uuid,
  round          integer not null check (round >= 1),
  position       integer not null check (position >= 1),
  status         text not null default 'queued'
                   check (status in ('queued', 'singing', 'sung', 'skipped', 'removed')),
  pay_with       text not null check (pay_with in ('credit', 'price')),
  credit_id      uuid,
  price_cents    integer check (price_cents >= 0),
  check_line_id  bigint,
  queued_by      uuid,
  queued_at      timestamptz not null,
  started_by     uuid,
  started_at     timestamptz,
  skipped_by     uuid,
  skipped_at     timestamptz,
  moved_by       uuid,
  moved_at       timestamptz,
  move_reason    text check (length(move_reason) <= 300),
  unique (venue_id, id),
  foreign key (venue_id, singer_id) references singers (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, check_line_id) references check_lines (venue_id, id),
  foreign key (venue_id, business_date) references song_nights (venue_id, business_date)
);
create index song_queue_by_night on song_queue (venue_id, business_date, round, position);
-- One song singing at a time.
create unique index song_queue_one_singing on song_queue (venue_id, business_date)
  where status = 'singing';
alter table song_queue enable row level security;
alter table song_queue force row level security;
create policy venue_isolation on song_queue to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on song_queue to app_rw;
select audit_table('song_queue');

create table song_queue_moves (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  queue_id       uuid not null,
  direction      text not null check (direction in ('up', 'down')),
  reason         text not null check (length(reason) between 1 and 300),
  moved_by       uuid not null,
  moved_at       timestamptz not null,
  from_round     integer not null,
  from_position  integer not null,
  to_round       integer not null,
  to_position    integer not null,
  unique (venue_id, id),
  foreign key (venue_id, queue_id) references song_queue (venue_id, id)
);
create index song_queue_moves_by_song on song_queue_moves (venue_id, queue_id);
alter table song_queue_moves enable row level security;
alter table song_queue_moves force row level security;
create policy venue_isolation on song_queue_moves to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on song_queue_moves to app_rw;
select audit_table('song_queue_moves');

create table song_credits (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references venues (id),
  singer_id           uuid not null,
  source              text not null check (source in ('drink', 'prepaid')),
  check_line_id       bigint,
  unit                integer check (unit >= 1),
  payment_id          uuid,
  prepaid_account_id  uuid,
  given_by            uuid,
  earned_at           timestamptz not null,
  used_by_queue_id    uuid,
  used_at             timestamptz,
  forfeited_at        timestamptz,
  unique (venue_id, id),
  -- Each unit of a drink earns one credit, for one singer.
  unique (venue_id, check_line_id, unit),
  check (source = 'drink' or (payment_id is not null and check_line_id is null)),
  check ((check_line_id is null) = (unit is null)),
  foreign key (venue_id, singer_id) references singers (venue_id, id),
  foreign key (venue_id, check_line_id) references check_lines (venue_id, id),
  foreign key (venue_id, payment_id) references payments (venue_id, id),
  foreign key (venue_id, prepaid_account_id) references prepaid_accounts (venue_id, id),
  foreign key (venue_id, used_by_queue_id) references song_queue (venue_id, id)
);
create index song_credits_by_singer on song_credits (venue_id, singer_id)
  where used_at is null and forfeited_at is null;
alter table song_credits enable row level security;
alter table song_credits force row level security;
create policy venue_isolation on song_credits to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on song_credits to app_rw;
grant update (used_by_queue_id, used_at, forfeited_at) on song_credits to app_rw;
select audit_table('song_credits');
