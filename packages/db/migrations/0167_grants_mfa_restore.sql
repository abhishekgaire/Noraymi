-- A restore re-inserts admin_section_grants rows as they were (0122_restores.sql): the grant's
-- trigger steps aside for it, as every other trigger does, so the restore copies users' rows
-- as they were rather than recomputing them.
set lock_timeout = '5s';

create or replace function require_mfa_for_grants() returns trigger
language plpgsql
as $$
begin
  if restoring() then return new; end if;
  update users set mfa_required = true
   where mfa_required = false
     and id = (select m.user_id from memberships m
                where m.venue_id = new.venue_id and m.id = new.membership_id);
  return new;
end $$;
