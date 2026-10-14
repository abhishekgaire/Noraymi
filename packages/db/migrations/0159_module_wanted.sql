-- On once ready (O-17; D129): the owner may choose a module in Set up your venue before its own
-- needs are in place (Kitchen & food before its allergy notice and kitchen printer). The choice is
-- kept here; the module itself stays off, and the API switches it on once the needs are met, at
-- Finish setup at the latest. Row-level security is unchanged: venue_modules already forces it.
set lock_timeout = '5s';

alter table venue_modules add column wanted_at timestamptz;
