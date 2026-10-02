-- The live payment drill (M4-30; Testing and operations). While now is before
-- drill_drop_until, our copy of Stripe's answer to a tap is dropped on purpose,
-- so the drill proves the "Checking with Stripe · don't retry" path on live
-- readers: the reconciler settles each payment and nothing charges twice.
-- Ops sets it with an end at most an hour away and clears it after
-- (docs/runbooks/live-payment-drill.md); it can't stay on by mistake.
set lock_timeout = '5s';

alter table venues add column drill_drop_until timestamptz;
