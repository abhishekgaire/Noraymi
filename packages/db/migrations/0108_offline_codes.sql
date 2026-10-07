-- Offline codes (M8-04; spec 09 · Offline and queue mode): each desktop
-- computer's secret, set up while online. The computer keeps its copy in the
-- operating system's keychain and checks codes itself when offline; the
-- server keeps one sealed with the API's secret key, so a manager's phone can
-- be handed each computer's upcoming codes, and the printed one-time codes.
-- Asking again replaces the secret. Never audited: the audit log would copy
-- the sealed secret.
set lock_timeout = '5s';

create table device_offline_secrets (
  device_id   uuid primary key,
  venue_id    uuid not null references venues (id),
  secret_enc  text not null check (char_length(secret_enc) <= 400),
  created_at  timestamptz not null default now(),
  foreign key (venue_id, device_id) references devices (venue_id, id)
);
alter table device_offline_secrets enable row level security;
alter table device_offline_secrets force row level security;
create policy venue_isolation on device_offline_secrets to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on device_offline_secrets to app_rw;
