-- Private-party enquiries from the website (M5-04; Data model · enquiries;
-- API · Enquiries). Each one opens its own conversation, so it lands in
-- Messages as an unread thread staff answer by text.
set lock_timeout = '5s';

create table enquiries (
  id              uuid primary key default gen_random_uuid(),
  venue_id        uuid not null references venues (id),
  guest_id        uuid not null,
  party_size      int not null check (party_size between 1 and 500),
  date            date not null,
  message         text check (length(message) <= 1000),
  status          text not null default 'new' check (status in ('new', 'answered', 'closed')),
  conversation_id uuid not null,
  created_at      timestamptz not null default now(),
  unique (venue_id, id),
  foreign key (venue_id, guest_id) references guests (venue_id, id),
  foreign key (venue_id, conversation_id) references conversations (venue_id, id)
);
create index enquiries_by_venue on enquiries (venue_id, created_at desc);
alter table enquiries enable row level security;
alter table enquiries force row level security;
create policy venue_isolation on enquiries to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on enquiries to app_rw;
grant update (status) on enquiries to app_rw;
select audit_table('enquiries');

-- An enquiry is a conversation's context, like a booking or a waitlist spot.
alter table conversations drop constraint conversations_context_kind_check;
alter table conversations add constraint conversations_context_kind_check
  check (context_kind in ('booking', 'waitlist', 'session', 'enquiry')) not valid;
alter table conversations validate constraint conversations_context_kind_check;
