-- Moving a tab into a room, and moving lines between tabs (M6-13; Payment
-- flows · Moving a tab into a room; Money rules 12; API · `POST
-- /tabs/{t}/move-to-room`, `POST /checks/{c}/lines/{l}/move`).
--  - A moved line is a `transfer_out` line on the check it leaves and a
--    `transfer_in` line on the check it joins; `moved_check_id` names the
--    other check, so the room's check reads "Moved from Jess P.'s bar tab"
--    and the tab "Moved to Room 9" in each person's language.
--  - A card tapped for a room (`check_cards`): a SetupIntent through the
--    reader (`process_setup_intent`) saves it without charging, with the
--    guest's consent read out (`policy_versions` kind `room_card_consent`).
--    Once a room has a card, the holds of tabs moved into it are canceled.
--  - `amount_due_beside_holds`: what a check owes with the tab holds on it
--    left out, since a hold is only a guarantee (Money rules 12).
set lock_timeout = '5s';

alter table check_lines add column moved_check_id uuid;
alter table check_lines add constraint check_lines_moved_check_fkey
  foreign key (venue_id, moved_check_id) references checks (venue_id, id) not valid;
alter table check_lines validate constraint check_lines_moved_check_fkey;

alter table policy_versions drop constraint policy_versions_kind_check;
alter table policy_versions add constraint policy_versions_kind_check
  check (kind in ('deposit', 'tab_consent', 'room_card_consent')) not valid;
alter table policy_versions validate constraint policy_versions_kind_check;

create table check_cards (
  id                       uuid primary key default gen_random_uuid(),
  venue_id                 uuid not null references venues (id),
  check_id                 uuid not null,
  reader_device_id         uuid not null,
  stripe_reader_id         text not null,
  -- waiting: the reader is asking for the card; saved: the SetupIntent succeeded; failed: declined or
  -- the reader gave up; canceled: staff cancelled.
  state                    text not null check (state in ('waiting', 'saved', 'failed', 'canceled')),
  stripe_customer_id       text,
  stripe_setup_intent_id   text,
  -- The reusable card the reader generated from the tap (a `card` PaymentMethod on the Customer).
  stripe_payment_method_id text,
  card_brand               text,
  card_last4               text check (card_last4 ~ '^[0-9]{4}$'),
  failure_code             text,
  consent_text_version     uuid not null,
  consent_read_by          uuid not null,
  started_by               uuid not null,
  started_at               timestamptz not null,
  settled_at               timestamptz,
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id),
  foreign key (venue_id, reader_device_id) references devices (venue_id, id),
  foreign key (venue_id, consent_text_version) references policy_versions (venue_id, id)
);
-- One tap at a time per room.
create unique index check_cards_one_waiting on check_cards (venue_id, check_id)
  where state = 'waiting';
create index check_cards_by_check on check_cards (venue_id, check_id);
alter table check_cards enable row level security;
alter table check_cards force row level security;
create policy venue_isolation on check_cards to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert, update on check_cards to app_rw;
select audit_table('check_cards');

-- What a check owes beside the tab holds on it: a bar tab's own hold, or the holds of tabs moved into a
-- room, follow the lines as guarantees and are left out (Money rules 12). Locks the check's row.
create or replace function amount_due_beside_holds(p_check uuid) returns bigint
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_lines bigint;
  v_fixed bigint;
  v_left bigint;
  v_follow record;
begin
  perform 1 from checks where venue_id = app_venue_id() and id = p_check for update;
  if not found then raise exception 'no check % here', p_check; end if;
  select coalesce(sum(amount_cents), 0) into v_lines
    from check_lines where venue_id = app_venue_id() and check_id = p_check;
  select coalesce(sum(a.amount_cents), 0) into v_fixed
    from payment_allocations a
   where a.venue_id = app_venue_id() and a.check_id = p_check and a.state in ('captured', 'in_progress')
     and not a.follows_lines;
  v_left := v_lines - v_fixed;
  for v_follow in
    select a.amount_cents from payment_allocations a
     where a.venue_id = app_venue_id() and a.check_id = p_check and a.state in ('captured', 'in_progress')
       and a.follows_lines
       and not (a.state = 'in_progress' and exists (select 1 from tabs t
                  where t.venue_id = a.venue_id and t.payment_id = a.payment_id))
     order by a.created_at, a.id
  loop
    v_left := v_left - least(v_follow.amount_cents, greatest(v_left, 0));
  end loop;
  return greatest(v_left, 0);
end
$$;
grant execute on function amount_due_beside_holds(uuid) to app_rw;
