-- The card surcharge at the reader (M4-25; Money rules 10; Payment flows ·
-- Card fee at the reader). The surcharge path stays behind this venue flag,
-- which we turn on (ops only, no screen) after its sandbox test passes and
-- Stripe answers the open questions. Off everywhere, and at West 4 the fee is
-- off anyway.
set lock_timeout = '5s';

alter table venues add column surcharge_reader boolean not null default false;
