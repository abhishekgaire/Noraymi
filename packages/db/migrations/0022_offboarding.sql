-- M1-27 · Offboarding in one step.
-- Deactivating a membership needs no new columns (status and deactivated_at
-- are in 0002). What it touches must be audited like everything else: the
-- tables M1-22 to M1-25 added now carry the audit trigger (0004), so a
-- revoked phone, a switched-off badge and a revoked subscription each leave
-- a row that still names the person.
set lock_timeout = '5s';

select audit_table('push_subscriptions');
select audit_table('invites');
select audit_table('phone_codes');
select audit_table('pin_lockouts');
select audit_table('staff_badges');
