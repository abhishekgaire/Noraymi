-- Practice payments go only to Stripe's sandbox (M7-04; Security and data
-- retention 15; Stripe setup 4, 6 and 7). Each organization has a second,
-- sandbox connected account, each venue a sandbox Terminal Location, and its
-- simulated readers are devices marked sandbox. A practice payment may name
-- only a sandbox reader, and a live payment only a live one. Events from the
-- sandbox arrive at their own endpoint ('training') and resolve their venue
-- through the sandbox account only.
set lock_timeout = '5s';

alter table organizations add column stripe_training_account_id text;
alter table venues add column stripe_training_location_id text;
alter table venues add column stripe_training_terminal_config_id text;
grant update (stripe_training_location_id, stripe_training_terminal_config_id) on venues to app_rw;

-- A simulated reader in Stripe's sandbox, for training mode only.
alter table devices add column sandbox boolean not null default false;

-- The sandbox account's venues, for the training webhook job.
create or replace function resolve_stripe_training_account(p_account text) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select v.id from venues v join organizations o on o.id = v.org_id
   where p_account is not null and o.stripe_training_account_id = p_account
$$;
alter function resolve_stripe_training_account(text) owner to app_definer;
revoke all on function resolve_stripe_training_account(text) from public;
grant execute on function resolve_stripe_training_account(text) to app_rw;

-- The training endpoint's events resolve through the sandbox account; every
-- other endpoint's through the live one. A sandbox event naming a live
-- account (or the other way round) finds no venue and is never applied.
create or replace function ingest_stripe_event(
  p_event_id text, p_type text, p_endpoint text, p_account text, p_payload jsonb
) returns table (id uuid, venue_id uuid, first boolean, processed boolean)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_venue uuid;
  v_id uuid;
begin
  select v.id into v_venue
    from venues v join organizations o on o.id = v.org_id
   where p_account is not null
     and case when p_endpoint = 'training' then o.stripe_training_account_id
              else o.stripe_account_id end = p_account
   order by v.created_at, v.id limit 1;
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

-- A payment on a practice check is practice, whatever path wrote it (a saved
-- card on a reopened tab, a walkout, a share), so its card calls go to the
-- sandbox; one payment never covers a practice check and a live one, and
-- real money already at Stripe never lands on a practice check.
create or replace function payment_allocation_training() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_check boolean;
  v_payment boolean;
begin
  if new.check_id is null then return new; end if;
  select k.training into v_check from checks k where k.venue_id = new.venue_id and k.id = new.check_id;
  select p.training into v_payment from payments p where p.venue_id = new.venue_id and p.id = new.payment_id;
  if coalesce(v_check, false) = coalesce(v_payment, false) then return new; end if;
  -- Only a payment that hasn't reached Stripe yet turns practice: real money never leaves the books.
  if coalesce(v_check, false) and exists (
    select 1 from payments p where p.venue_id = new.venue_id and p.id = new.payment_id
       and p.status = 'pending' and p.stripe_pi_id is null
  ) and not exists (
    select 1 from payment_allocations a join checks k on k.venue_id = a.venue_id and k.id = a.check_id
     where a.venue_id = new.venue_id and a.payment_id = new.payment_id and not k.training
  ) then
    update payments set training = true where venue_id = new.venue_id and id = new.payment_id;
    return new;
  end if;
  raise exception 'a payment never covers a practice check and a live one'
    using errcode = 'check_violation';
end;
$$;
create trigger payment_allocation_training before insert on payment_allocations
  for each row execute function payment_allocation_training();
