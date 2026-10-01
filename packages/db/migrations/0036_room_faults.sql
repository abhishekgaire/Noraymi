-- Room faults (M2-16; spec 04 · room_faults; screens N14). A fault is logged on
-- the board or DeskRoom and can take the room out of service, pause the clock
-- (with approval; the paused segment is linked) or comp minutes of room time
-- (a reason-only comp, linked by comp_line_id). Open faults show on the tile.
set lock_timeout = '5s';

create table room_faults (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues (id),
  room_id           uuid not null,
  session_id        uuid,
  text              text not null check (length(text) between 1 and 500),
  reported_by       uuid,                       -- a user; empty only for faults carried over from before (the seed's Room 4)
  reported_at       timestamptz not null,
  out_of_service    boolean not null default false,
  pause_segment_id  uuid,
  comp_line_id      bigint,
  fixed_by          uuid,
  fixed_at          timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, room_id) references rooms (venue_id, id),
  foreign key (venue_id, session_id) references room_sessions (venue_id, id),
  foreign key (venue_id, pause_segment_id) references session_segments (venue_id, id),
  foreign key (venue_id, comp_line_id) references check_lines (venue_id, id),
  check ((fixed_at is null) = (fixed_by is null))
);
create index room_faults_open_idx on room_faults (venue_id, room_id) where fixed_at is null;
alter table room_faults enable row level security;
alter table room_faults force row level security;
create policy venue_isolation on room_faults to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on room_faults to app_rw;
grant update (pause_segment_id, comp_line_id, fixed_by, fixed_at) on room_faults to app_rw;
select audit_table('room_faults');
