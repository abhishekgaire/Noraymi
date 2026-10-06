-- The play log (M6-19; Song systems and texts · the play log; Data model ·
-- song_plays; GA-M10): every started song writes one row, with the tab's check
-- (or the room's session), the title, the artist, when it started and what
-- marked it started (`staff` tapping Started, or a song system's `adapter`).
-- It answers licensing questions, so it's append-only: insert and select only.
-- A singer with no tab still gets a row, with neither a check nor a session.
set lock_timeout = '5s';

create table song_plays (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  business_date  date not null,
  queue_id       uuid,
  singer_id      uuid,
  session_id     uuid,
  check_id       uuid,
  title          text not null check (length(title) between 1 and 120),
  artist         text check (length(artist) <= 120),
  started_at     timestamptz not null,
  started_by     uuid,
  source         text not null check (source in ('staff', 'adapter')),
  unique (venue_id, id),
  foreign key (venue_id, queue_id) references song_queue (venue_id, id),
  foreign key (venue_id, singer_id) references singers (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);

create index song_plays_by_night on song_plays (venue_id, business_date, started_at);
create unique index song_plays_one_per_song on song_plays (venue_id, queue_id) where queue_id is not null;

alter table song_plays enable row level security;
alter table song_plays force row level security;
create policy venue_isolation on song_plays to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on song_plays to app_rw;
select audit_table('song_plays');
