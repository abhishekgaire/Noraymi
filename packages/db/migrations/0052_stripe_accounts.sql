-- Stripe accounts (M4-01; Stripe setup 1, 2 and 7; Tenancy and access):
-- the Stripe row in `integrations` that Admin → Payments and
-- Connections read (card payments enabled, what Stripe still needs); and
-- `resolve_stripe_account`, the definer function a webhook job uses to find
-- the venues of `event.account`. One organization per account is checked by
-- the ops command that stores it (stripe:create-account).
set lock_timeout = '5s';

alter table integrations drop constraint integrations_kind_check;
alter table integrations add constraint integrations_kind_check
  check (kind in ('twilio', 'google', 'quickbooks', 'email', 'song_system', 'stripe')) not valid;
alter table integrations validate constraint integrations_kind_check;

create policy definer_read on organizations for select to app_definer using (true);

create or replace function resolve_stripe_account(p_account text) returns setof uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select v.id from venues v join organizations o on o.id = v.org_id
   where p_account is not null and o.stripe_account_id = p_account
$$;
alter function resolve_stripe_account(text) owner to app_definer;
revoke all on function resolve_stripe_account(text) from public;
grant execute on function resolve_stripe_account(text) to app_rw;
