-- How each approval was decided (F-04; D124; spec 02 · Approvals): the venue chooses, in the
-- `approvals` settings key, on the manager's phone (today's rule), by a manager's PIN at the
-- register, or no approval at all (role permissions only). Every request is still a row, so the
-- record, the exceptions report and the audit log are unchanged.
--   phone: never the requester, never on the device that asked (as before);
--   pin:   never the requester, but on the register that asked;
--   none:  the requester's own action, recorded as approved at once.
set lock_timeout = '5s';

alter table approvals add column decided_with text not null default 'phone'
  check (decided_with in ('phone', 'pin', 'none'));

alter table approvals drop constraint approvals_check;
alter table approvals add constraint approvals_routed_check
  check (routed_to <> requested_by or decided_with = 'none') not valid;
alter table approvals validate constraint approvals_routed_check;

alter table approvals drop constraint approvals_check1;
alter table approvals add constraint approvals_approver_check
  check (approver_id is null or approver_id <> requested_by or decided_with = 'none') not valid;
alter table approvals validate constraint approvals_approver_check;

alter table approvals drop constraint approvals_check2;
alter table approvals add constraint approvals_device_check
  check (decided_device_id is null or requested_device_id is null
         or decided_device_id <> requested_device_id or decided_with in ('pin', 'none')) not valid;
alter table approvals validate constraint approvals_device_check;

grant update (decided_with) on approvals to app_rw;
