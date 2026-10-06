-- Drops, paid-outs, no-sales and tip-outs at the drawer (M7-06; Money rules
-- 14 and 15; Data model · drawer_moves, staff_banks, approvals paid_out). A
-- tip-out names the person it paid (`paid_to`, expand-only), so the drawer's
-- expected cash and their tips agree. A drawer opens only with a move behind
-- it: a cash payment, a drop, an approved paid-out, a no-sale or a tip-out,
-- never a reprint, and never a job that names nothing real.
set lock_timeout = '5s';

alter table drawer_moves add column paid_to uuid;

create or replace function check_drawer_kick() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_reason text := new.payload ->> 'reason';
  ok boolean;
begin
  if new.kind <> 'drawer' then
    return new;
  end if;
  if new.reprint_of is not null then
    raise exception 'a drawer kick is never reprinted' using errcode = 'W4K01';
  end if;
  if v_reason = 'cash' then
    select exists (
      select 1 from payments p
       where p.venue_id = new.venue_id and p.method = 'cash'
         and p.id::text = new.payload ->> 'payment_id'
    ) into ok;
  elsif v_reason in ('drop', 'paid_out', 'no_sale', 'tip_out') then
    select exists (
      select 1 from drawer_moves m
       where m.venue_id = new.venue_id and m.kind = v_reason
         and m.id::text = new.payload ->> 'move_id'
         and m.drawer_session_id is not null
    ) into ok;
  else
    ok := false;
  end if;
  if not coalesce(ok, false) then
    raise exception 'a drawer opens only for a cash payment, a drop, an approved paid-out, a no-sale or a tip-out'
      using errcode = 'W4K01';
  end if;
  return new;
end;
$$;

create trigger drawer_kick_guard before insert on print_jobs
  for each row execute function check_drawer_kick();
