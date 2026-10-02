-- Stripe webhooks (M4-03; Stripe setup 6; Tenancy and access · tables
-- without venue_id): each event is stored once by its id, through
-- `ingest_stripe_event`, before any job runs. The function resolves the
-- venue from `event.account` (the first venue of the organization that holds
-- the account); an event with no venue (our own account's billing events, or
-- an account we don't know) is kept with venue_id null, which app_rw never
-- sees. The endpoint and the account are kept beside the payload.
set lock_timeout = '5s';

alter table webhook_events alter column venue_id drop not null;
alter table webhook_events add column endpoint text;
alter table webhook_events add column account text;

grant select, insert on webhook_events to app_definer;
create policy definer_ingest on webhook_events for insert to app_definer with check (provider = 'stripe');
create policy definer_read on webhook_events for select to app_definer using (true);

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
   where p_account is not null and o.stripe_account_id = p_account
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
