-- Training mode (M7-03; Security and data retention 15; Data model · Training
-- mode). A person (memberships.training) or a device (devices.training) in
-- training rings practice checks (checks.training), numbered from their own
-- counter. Practice room sessions block nothing and are seen only on screens
-- in training; approvals carry the flag of what they're about. Every report,
-- export, tax, tip and reason-only query reads the live_* views below, never
-- the base tables (a lint rule checks the report and export code).
set lock_timeout = '5s';

-- A practice session (cautious default, ticket notes): opened on a free room
-- from [+ Walk-in] in training; it writes no room_blocks and no room_states.
alter table room_sessions add column training boolean not null default false;

-- An approval from a practice check goes to the manager like a live one,
-- marked TRAINING in the inbox, and never counts anywhere.
alter table approvals add column training boolean not null default false;

-- The flag comes from what the approval is about, whatever route asked.
create or replace function approval_training() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.training := coalesce(case new.target_kind
    when 'check' then (select k.training from checks k where k.venue_id = new.venue_id and k.id = new.target_id)
    when 'tab' then (select k.training from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
                      where t.venue_id = new.venue_id and t.id = new.target_id)
    when 'order' then (select k.training from orders o join checks k on k.venue_id = o.venue_id and k.id = o.check_id
                        where o.venue_id = new.venue_id and o.id = new.target_id)
    when 'payment' then (select p.training from payments p where p.venue_id = new.venue_id and p.id = new.target_id)
    when 'session' then (select s.training from room_sessions s where s.venue_id = new.venue_id and s.id = new.target_id)
    else false end, false) or new.training;
  return new;
end;
$$;
create trigger approval_training before insert on approvals
  for each row execute function approval_training();

-- The live views: what every Z, tax, tip, export, report and reason-only
-- query reads. security_invoker keeps the base tables' row-level security.
create view live_checks with (security_invoker = true) as
  select * from checks where not training;
create view live_check_lines with (security_invoker = true) as
  select l.* from check_lines l
   where exists (select 1 from checks k where k.venue_id = l.venue_id and k.id = l.check_id and not k.training);
create view live_payments with (security_invoker = true) as
  select * from payments where not training;
grant select on live_checks, live_check_lines, live_payments to app_rw;
