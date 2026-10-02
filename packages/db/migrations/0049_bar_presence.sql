-- No bar device connected (M3-17; screens N32; spec 09 · Room orders at the
-- bar). lost_at is when the venue's last bar computer dropped its connection
-- during opening hours; it clears when one connects again.
set lock_timeout = '5s';

create table bar_presence (
  venue_id  uuid primary key references venues (id),
  lost_at   timestamptz
);
alter table bar_presence enable row level security;
alter table bar_presence force row level security;
create policy venue_isolation on bar_presence to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert, update on bar_presence to app_rw;
