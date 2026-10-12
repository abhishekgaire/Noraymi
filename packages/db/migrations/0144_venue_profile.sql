-- Admin → Venue and Set up your venue's step 1 (O-03; spec 17 · Step details 1).
-- The owner edits the name guests see, the street address and the organization's
-- legal name through PUT /v1/venues/{v}/profile; the time zone, the cutover and
-- the rule pack never change here (a Console job). No EIN column exists anywhere:
-- the owner types it into Stripe's and Twilio's own forms.
set lock_timeout = '5s';

grant update (name, address) on venues to app_rw;
grant update (legal_name) on organizations to app_rw;
