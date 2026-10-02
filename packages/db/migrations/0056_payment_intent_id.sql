-- A payment's PaymentIntent id (M4-05): the payment is written first and its
-- one PaymentIntent is made after the commit (key <payment_id>:create), so the
-- id arrives later. The money core grants no update on stripe_pi_id; this
-- definer function sets it once, inside the caller's venue, and refuses to
-- change it.
set lock_timeout = '5s';

grant update (stripe_pi_id) on payments to app_definer;

create or replace function set_payment_intent(p_payment uuid, p_pi text) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_current text;
begin
  select stripe_pi_id into v_current from payments
   where venue_id = app_venue_id() and id = p_payment for update;
  if not found then raise exception 'no payment % here', p_payment; end if;
  if v_current is null then
    update payments set stripe_pi_id = p_pi where venue_id = app_venue_id() and id = p_payment;
  elsif v_current <> p_pi then
    raise exception 'payment % already has PaymentIntent %', p_payment, v_current;
  end if;
end
$$;
alter function set_payment_intent(uuid, text) owner to app_definer;
revoke all on function set_payment_intent(uuid, text) from public;
grant execute on function set_payment_intent(uuid, text) to app_rw;
