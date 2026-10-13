-- The texting switch (F-01; D124; spec 11 · Texting switch). The switches themselves are the
-- `texting` settings key; this marks the replies the carriers require (the STOP confirmation and
-- the HELP answer), the only texts that still go while texting is off, so a send job can tell them
-- from a text queued just before the switch went off, which it drops. An older STOP confirmation
-- reads as one through its own stop_confirmation flag, so nothing is backfilled.
set lock_timeout = '5s';

alter table messages add column carrier_reply boolean not null default false;
