-- M8-15 · Our plan billing on Stripe Billing (spec 03 · Plan billing; spec 06
-- · 6 and 7; spec 04 · venue_subscriptions, organizations.billing_customer_id).
-- One subscription per venue on our own platform account: the plan's price
-- plus a per-room item whose quantity counts every room that isn't archived.
-- Its state comes only from our own account's billing events, read again from
-- Stripe; a failed plan payment shows a banner in Admin, and Admin turns
-- read-only from the first business-date cutover 14 days after it.
set lock_timeout = '5s';

create table venue_subscriptions (
  venue_id                uuid primary key references venues (id),
  plan                    text not null check (plan in ('bar', 'rooms', 'rooms_kitchen')),
  stripe_subscription_id  text not null unique check (char_length(stripe_subscription_id) <= 255),
  -- The subscription item that carries the room count (none on the Bar plan).
  room_item_id            text check (char_length(room_item_id) <= 255),
  room_quantity           integer not null default 0 check (room_quantity >= 0),
  -- Stripe's subscription status, as last read from Stripe.
  status                  text not null check (status in ('incomplete', 'incomplete_expired', 'trialing',
                            'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  -- When our clock first saw the plan payment fail; null once it's paid.
  payment_failed_at       timestamptz,
  failed_invoice_id       text check (char_length(failed_invoice_id) <= 255),
  updated_at              timestamptz not null default now()
);
alter table venue_subscriptions enable row level security;
alter table venue_subscriptions force row level security;
create policy venue_isolation on venue_subscriptions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on venue_subscriptions to app_rw;
grant update (room_item_id, room_quantity, status, payment_failed_at, failed_invoice_id, updated_at)
  on venue_subscriptions to app_rw;
select audit_table('venue_subscriptions');

-- Our own account's billing events carry no `account`: the venue is the one
-- whose subscription the event names (never metadata, which anyone with our
-- Dashboard could edit).
create policy definer_read on venue_subscriptions for select to app_definer using (true);
grant select on venue_subscriptions to app_definer;

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
  if p_endpoint = 'platform' then
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
