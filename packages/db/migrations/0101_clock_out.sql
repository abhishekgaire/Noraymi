-- The clock-out checklist (M7-11; spec 10 · Shifts; spec 08 · Time clock):
-- each person declares their cash tips before they clock out, any amount,
-- $0.00 included. The declaration stays on the shift; an amount over zero is
-- also a `cash_tip` row in the tip ledger.
set lock_timeout = '5s';

alter table shifts add column cash_tips_declared_cents bigint check (cash_tips_declared_cents >= 0);
alter table shifts add column cash_tips_declared_at timestamptz;
grant update (cash_tips_declared_cents, cash_tips_declared_at) on shifts to app_rw;
