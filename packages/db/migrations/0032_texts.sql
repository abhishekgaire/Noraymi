-- M2-09 · Texts through each venue's own Twilio subaccount (spec 11; spec 04 ·
-- integrations, conversations, messages, message_templates, webhook_events).
-- A subaccount's auth token is stored encrypted in config (secret_enc).
set lock_timeout = '5s';

create table integrations (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues (id),
  kind         text not null check (kind in ('twilio', 'google', 'quickbooks', 'email', 'song_system')),
  status       text not null default 'pending' check (status in ('pending', 'connected', 'disconnected', 'error')),
  external_id  text,                    -- Twilio: the subaccount's SID
  config       jsonb not null default '{}',
  connected_at timestamptz,
  unique (venue_id, id),
  unique (venue_id, kind)
);
create unique index integrations_twilio_number_idx on integrations ((config ->> 'phone_e164')) where kind = 'twilio';
create unique index integrations_twilio_account_idx on integrations (external_id) where kind = 'twilio';
alter table integrations enable row level security;
alter table integrations force row level security;
create policy venue_isolation on integrations to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on integrations to app_rw;
grant select on integrations to app_definer;
create policy definer_read on integrations for select to app_definer using (true);
select audit_table('integrations');

-- Inbound texts and Twilio's callbacks arrive without a venue: two narrow doors map a number, or a
-- subaccount, to the venue that owns it (spec 02 · Requests that arrive without a venue). Ids only.
create or replace function resolve_sms_number(p_number text) returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select venue_id from integrations where kind = 'twilio' and config ->> 'phone_e164' = p_number
$$;
alter function resolve_sms_number(text) owner to app_definer;
revoke all on function resolve_sms_number(text) from public;
grant execute on function resolve_sms_number(text) to app_rw;

create or replace function resolve_twilio_account(p_account_sid text) returns uuid
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select venue_id from integrations where kind = 'twilio' and external_id = p_account_sid
$$;
alter function resolve_twilio_account(text) owner to app_definer;
revoke all on function resolve_twilio_account(text) from public;
grant execute on function resolve_twilio_account(text) to app_rw;

create table message_templates (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues (id),
  key        text not null,
  position   integer not null,          -- the spec's order, 1 to 14
  category   text not null check (category in ('service', 'marketing')),
  body       text not null,
  "on"       boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (venue_id, id),
  unique (venue_id, key)
);
alter table message_templates enable row level security;
alter table message_templates force row level security;
create policy venue_isolation on message_templates to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on message_templates to app_rw;
select audit_table('message_templates');

create table conversations (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  guest_id        uuid,
  phone_e164      text not null,
  context_kind    text check (context_kind in ('booking', 'waitlist', 'session')),
  context_id      uuid,
  unread          integer not null default 0,
  assigned_to     uuid,
  last_inbound_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, guest_id) references guests (venue_id, id)
);
create index conversations_phone_idx on conversations (venue_id, phone_e164);
alter table conversations enable row level security;
alter table conversations force row level security;
create policy venue_isolation on conversations to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on conversations to app_rw;
select audit_table('conversations');

create table messages (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  conversation_id uuid not null,
  direction       text not null check (direction in ('outbound', 'inbound')),
  template_id     uuid,
  category        text not null check (category in ('service', 'marketing', 'reply')),
  body            text not null,
  sent_by         uuid,
  provider_sid    text,
  status          text not null check (status in ('sending', 'sent', 'delivered', 'failed', 'received')),
  attempted_at    timestamptz,           -- the one send attempt; set in its own transaction before Twilio is called
  read_at         timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, conversation_id) references conversations (venue_id, id),
  foreign key (venue_id, template_id) references message_templates (venue_id, id)
);
create unique index messages_provider_sid_idx on messages (provider_sid) where provider_sid is not null;
create index messages_conversation_idx on messages (venue_id, conversation_id, created_at);
alter table messages enable row level security;
alter table messages force row level security;
create policy venue_isolation on messages to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on messages to app_rw;
select audit_table('messages');

create table webhook_events (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues (id),
  provider     text not null check (provider in ('stripe', 'twilio')),
  event_id     text not null,
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  payload      jsonb not null default '{}',
  unique (venue_id, id),
  unique (provider, event_id)
);
alter table webhook_events enable row level security;
alter table webhook_events force row level security;
create policy venue_isolation on webhook_events to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on webhook_events to app_rw;
