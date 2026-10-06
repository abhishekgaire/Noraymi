-- Blind drawer counts and the house drawers' handover (M7-05; Money rules 15;
-- Data model · cash_drawers, drawer_sessions, drawer_moves; spec 08 · Drawer).
-- When the manager on duty changes, the outgoing manager counts each house
-- drawer blind; its session closes with the count and the next opens with the
-- same cash, answered for by the incoming manager. They accept on their own
-- phone (an approval of kind drawer_handover), which makes them the manager
-- on duty: their open Manager shift's on_duty_since is set, and the manager
-- on duty is the Manager shift that took over last.
set lock_timeout = '5s';

create table drawer_handovers (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references venues (id),
  business_date       date not null,
  from_user_id        uuid not null,
  to_user_id          uuid not null,
  requested_at        timestamptz not null,
  requested_device_id uuid,
  approval_id         uuid,
  state               text not null default 'pending' check (state in ('pending', 'accepted', 'declined')),
  decided_at          timestamptz,
  unique (venue_id, id),
  check (from_user_id <> to_user_id)
);
-- one handover waiting at a time
create unique index drawer_handovers_one_pending on drawer_handovers (venue_id) where state = 'pending';
alter table drawer_handovers enable row level security;
alter table drawer_handovers force row level security;
create policy venue_isolation on drawer_handovers to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on drawer_handovers to app_rw;
grant update (approval_id, state, decided_at) on drawer_handovers to app_rw;
select audit_table('drawer_handovers');

-- The handover a session was opened by (null: opened at the business date's start).
alter table drawer_sessions add column handover_id uuid;
alter table drawer_sessions add constraint drawer_sessions_handover_fk
  foreign key (venue_id, handover_id) references drawer_handovers (venue_id, id) not valid;
alter table drawer_sessions validate constraint drawer_sessions_handover_fk;

-- When an accepted handover made this Manager shift the one on duty.
alter table shifts add column on_duty_since timestamptz;
grant update (on_duty_since) on shifts to app_rw;

alter table approvals drop constraint approvals_kind_check;
alter table approvals add constraint approvals_kind_check
  check (kind in ('comp', 'void', 'refund', 'clock_pause', 'tip_review', 'paid_out', 'party_size_down',
                  'card_on_file', 'over_hold', 'drawer_handover')) not valid;
alter table approvals validate constraint approvals_kind_check;

-- A handover has a business date: once the night is closed, none is dated to it (M7-02).
create trigger closed_night_guard before insert or update of business_date on drawer_handovers
  for each row execute function refuse_closed_night();
