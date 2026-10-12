-- Set up your venue's step 3, Card payments (O-05; spec 17 · Step details 3;
-- Stripe setup 2). Connect with Stripe makes the organization's Accounts v2
-- account as the owner, once (one idempotency key per organization), and
-- keeps only its id; the route writes it only while the organization has
-- none. Bank details, the EIN and IDs go to Stripe's own form, never to us.
set lock_timeout = '5s';

grant update (stripe_account_id) on organizations to app_rw;
