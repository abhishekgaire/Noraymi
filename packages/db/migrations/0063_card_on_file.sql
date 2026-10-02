-- Card on file (M4-17; Payment flows · Room close-out; Data model ·
-- payments.mit_reason): when the guest has left, a manager's approval runs
-- the charge, and the requester's reason is written to the payment then, so
-- the API may set mit_reason after the payment row exists.
set lock_timeout = '5s';

grant update (mit_reason) on payments to app_rw;
