-- Escalating room orders nobody has accepted (M3-16; spec 10 rule 7): 1 when
-- bar phones buzzed (30 s), 2 when the board showed it (2 min), 3 when the
-- manager on duty's phone was told (4 min), 4 when they were texted (6 min).
-- Each step happens once; Accept, a cancel or a decline stops the rest.
set lock_timeout = '5s';

alter table orders add column escalation_level smallint not null default 0
  check (escalation_level between 0 and 4);
