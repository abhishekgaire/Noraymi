-- Consents and opt-outs (M2-23; spec 04 · consents; spec 11 · Consent and timing).
-- Proof of every opt-in and opt-out. STOP, and opt-outs written any other
-- reasonable way, are honored at once: every send checks for one first. An
-- opt-out is kept by number too, since a number can text STOP before it's a
-- guest's.
set lock_timeout = '5s';

create table consents (
  id            uuid primary key default gen_random_uuid(),
  venue_id      uuid not null references venues (id),
  guest_id      uuid,
  phone_e164    text,                     -- the number an SMS consent covers
  channel       text not null check (channel in ('sms', 'email')),
  kind          text not null check (kind in ('texts', 'marketing')),
  given_at      timestamptz,              -- empty for an opt-out with no opt-in before it (service texts need none)
  source        text,                     -- where it was given: the form, a keyword, staff
  text_version  text,                     -- the wording the guest agreed to
  ip            inet,
  revoked_at    timestamptz,
  revoked_via   text check (revoked_via in ('keyword', 'staff', 'guest_page')),
  unique (venue_id, id),
  foreign key (venue_id, guest_id) references guests (venue_id, id),
  check (guest_id is not null or phone_e164 is not null),
  check ((revoked_at is null) = (revoked_via is null)),
  check (given_at is not null or revoked_at is not null)
);
create index consents_phone_idx on consents (venue_id, phone_e164) where revoked_at is not null;
alter table consents enable row level security;
alter table consents force row level security;
create policy venue_isolation on consents to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on consents to app_rw;
grant update (revoked_at, revoked_via) on consents to app_rw;
select audit_table('consents');
-- The redaction list is configuration the audited migration role writes (as in 0015).
set role app_migrator;
insert into audit_redactions values ('consents', 'phone_e164'), ('consents', 'ip');
reset role;

-- A text an opt-out stopped before it went: "stopped", never "failed".
alter table messages drop constraint messages_status_check;
alter table messages add constraint messages_status_check
  check (status in ('sending', 'sent', 'delivered', 'failed', 'received', 'stopped')) not valid;
alter table messages validate constraint messages_status_check;
-- The one confirmation a STOP gets goes even though the number has just opted out.
alter table messages add column stop_confirmation boolean not null default false;
