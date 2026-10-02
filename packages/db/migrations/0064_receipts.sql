-- Receipts (M4-19; Data model · receipts; Security 9): one row each time a
-- check's receipt is printed, texted, emailed or opened on the web, with a
-- 128-bit link token stored hashed that expires (30 days, the ticket's
-- cautious default). `resolve_receipt` finds the venue from the token's hash,
-- as the other token routes do. Each check has at most one web receipt, the
-- link its guests' phones show once it's paid.
set lock_timeout = '5s';

create table receipts (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues (id),
  check_id    uuid not null,
  payment_id  uuid,
  token_hash  text not null unique,
  channel     text not null check (channel in ('print', 'text', 'email', 'web')),
  sent_at     timestamptz not null,
  expires_at  timestamptz not null,
  sent_by     uuid,
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  check (expires_at > sent_at)
);
create index receipts_check_idx on receipts (venue_id, check_id);
create unique index receipts_one_web on receipts (venue_id, check_id) where channel = 'web';
alter table receipts enable row level security;
alter table receipts force row level security;
create policy venue_isolation on receipts to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on receipts to app_rw;
select audit_table('receipts');

grant select on receipts to app_definer;
create policy definer_read on receipts for select to app_definer using (true);

create or replace function resolve_receipt(p_token_hash text) returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select venue_id from receipts where token_hash = p_token_hash
$$;
alter function resolve_receipt(text) owner to app_definer;
revoke all on function resolve_receipt(text) from public;
grant execute on function resolve_receipt(text) to app_rw;
