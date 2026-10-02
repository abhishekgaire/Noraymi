-- The card readers (M4-02; Stripe setup 4; Devices, printing and offline):
-- the venue's Terminal Configuration and Location ids, and each reader's
-- Stripe id, model and cellular flag on its `devices` row (kind reader).
-- Only the S710, S700 and WisePOS E are supported; never the M2.
set lock_timeout = '5s';

alter table venues add column stripe_terminal_config_id text;
grant update (stripe_location_id, stripe_terminal_config_id) on venues to app_rw;

alter table devices add column stripe_reader_id text;
alter table devices add column reader_model text
  check (reader_model in ('stripe_s710', 'stripe_s700', 'bbpos_wisepos_e'));
alter table devices add column cellular boolean;
