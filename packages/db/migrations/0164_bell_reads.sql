-- One bell for everything waiting (P-11; spec 10 · The bell; module bell). What's waiting is worked
-- out from the rows it already lives in (approvals, the board's alerts, bar orders, guest texts,
-- tickets that didn't print); the only new thing kept is which of those each person has marked
-- read, so the bell's count is per person on every screen they sign in to. A key names one waiting
-- thing ("order:<id>", "text:<conversation>:<last inbound>"), so something new rings again. Insert
-- only: marking read twice is a no-op, and the bell reads back only the last few days.
set lock_timeout = '5s';

create table bell_reads (
  venue_id   uuid not null references venues (id),
  user_id    uuid not null references users (id),
  item_key   text not null check (length(item_key) between 1 and 200),
  read_at    timestamptz not null,
  primary key (venue_id, user_id, item_key)
);
create index bell_reads_by_age on bell_reads (venue_id, user_id, read_at);
alter table bell_reads enable row level security;
alter table bell_reads force row level security;
create policy venue_isolation on bell_reads to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on bell_reads to app_rw;
-- A one-venue restore (M8-20) needs the wall and the grants every venue table has.
create policy restore_wall on bell_reads to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on bell_reads to app_migrator;
