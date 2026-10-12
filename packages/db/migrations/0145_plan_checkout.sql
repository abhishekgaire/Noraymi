-- Set up your venue's step 2, Your plan (O-04; spec 17 · Step details 2; D114).
-- The owner starts the venue's plan through a Stripe Checkout Session on our
-- own account. Each Start plan is a plan_subscribe_attempts row (M8-15), whose
-- id keys the Checkout call; the session it made is kept on the row, so the
-- session's events find their venue by it (never by metadata), and the
-- reconciler can read a session left open. The promotion code is the Stripe
-- id the owner's code resolved to when it was checked; no code is ours.
set lock_timeout = '5s';

alter table plan_subscribe_attempts
  add column checkout_session_id text unique check (char_length(checkout_session_id) <= 255),
  add column promotion_code_id   text check (char_length(promotion_code_id) <= 255);
grant update (checkout_session_id) on plan_subscribe_attempts to app_rw;

-- The plan follows the subscription's Prices when the owner changes it in
-- Stripe's portal (customer.subscription.updated); a venue whose plan ended
-- starts a new subscription on its row.
grant update (plan, stripe_subscription_id) on venue_subscriptions to app_rw;
-- Start plan makes the organization's billing Customer the first time, as the owner.
grant update (billing_customer_id) on organizations to app_rw;

-- The session's events carry no venue: ingest_stripe_event finds it by the session id.
create policy definer_read on plan_subscribe_attempts for select to app_definer using (true);
grant select on plan_subscribe_attempts to app_definer;

create or replace function ingest_stripe_event(
  p_event_id text, p_type text, p_endpoint text, p_account text, p_payload jsonb
) returns table (id uuid, venue_id uuid, first boolean, processed boolean)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_venue uuid;
  v_id uuid;
  v_sub text;
begin
  if p_endpoint = 'platform' and p_type like 'checkout.session.%' then
    select a.venue_id into v_venue from plan_subscribe_attempts a
     where a.checkout_session_id = p_payload #>> '{data,object,id}';
  elsif p_endpoint = 'platform' then
    v_sub := case
      when p_type like 'customer.subscription.%' then p_payload #>> '{data,object,id}'
      else coalesce(p_payload #>> '{data,object,parent,subscription_details,subscription}',
                    p_payload #>> '{data,object,subscription}')
    end;
    select s.venue_id into v_venue from venue_subscriptions s
     where v_sub is not null and s.stripe_subscription_id = v_sub;
  else
    select v.id into v_venue
      from venues v join organizations o on o.id = v.org_id
     where p_account is not null
       and case when p_endpoint = 'training' then o.stripe_training_account_id
                else o.stripe_account_id end = p_account
     order by v.created_at, v.id limit 1;
  end if;
  insert into webhook_events (venue_id, provider, event_id, type, endpoint, account, payload)
  values (v_venue, 'stripe', p_event_id, p_type, p_endpoint, p_account, p_payload)
  on conflict (provider, event_id) do nothing
  returning webhook_events.id into v_id;
  if v_id is not null then
    return query select v_id, v_venue, true, false;
  else
    return query select w.id, w.venue_id, false, w.processed_at is not null
      from webhook_events w where w.provider = 'stripe' and w.event_id = p_event_id;
  end if;
end
$$;
alter function ingest_stripe_event(text, text, text, text, jsonb) owner to app_definer;
revoke all on function ingest_stripe_event(text, text, text, text, jsonb) from public;
grant execute on function ingest_stripe_event(text, text, text, text, jsonb) to app_rw;
