-- What a check still owes, read without locking it (M8: the smoke run's
-- deadlocks, and M8-21's load test). amount_due() locks the check row so two
-- payments can't both fit; that's right inside a payment, but a list that
-- calls it for every owing check (the Unmatched payments picker) took a row
-- lock on each check in its own order, and two such reads, or one beside a
-- payment or the seed's reload, could deadlock. amount_due_read() is the same
-- sum without the lock, for screens that only show the amount; anything that
-- takes money still calls amount_due().
set lock_timeout = '5s';

create or replace function amount_due_read(p_check uuid, p_leave_out uuid default null) returns bigint
language plpgsql stable
set search_path = pg_catalog, public
as $$
declare
  v_lines bigint;
  v_fixed bigint;
  v_left bigint;
  v_follow record;
begin
  select coalesce(sum(amount_cents), 0) into v_lines
    from check_lines where venue_id = app_venue_id() and check_id = p_check;
  select coalesce(sum(amount_cents), 0) into v_fixed
    from payment_allocations
   where venue_id = app_venue_id() and check_id = p_check and state in ('captured', 'in_progress')
     and not follows_lines and payment_id is distinct from p_leave_out;
  v_left := v_lines - v_fixed;
  for v_follow in
    select amount_cents from payment_allocations
     where venue_id = app_venue_id() and check_id = p_check and state in ('captured', 'in_progress')
       and follows_lines and payment_id is distinct from p_leave_out
     order by created_at, id
  loop
    v_left := v_left - least(v_follow.amount_cents, greatest(v_left, 0));
  end loop;
  return greatest(v_left, 0);
end
$$;
grant execute on function amount_due_read(uuid, uuid) to app_rw;
