-- Cash quick sales while offline (U-16; D133; spec 09 · Cash quick sales while offline). With the
-- venue's "Take cash quick sales while offline" on, the bar computer's queue also holds cash quick
-- sales; each replays once, by the order id it made, into offline_replays beside the rounds:
--   kind      'round' (a round on a tab, M8-05) or 'cash_sale' (a quick sale paid in cash offline)
--   outcome   'sold' for a cash sale the replay made: its order and its cash payment are named here;
--             'failed' for one the server refused (no check is made, so check_id stays null)
--   cash_cents, tendered_cents  what the computer took and what the guest handed over
--   seen_by, seen_at  a refused cash sale shows under Confirm replayed orders until someone taps OK
set lock_timeout = '5s';

alter table offline_replays
  add column kind text not null default 'round' check (kind in ('round', 'cash_sale')),
  add column cash_cents integer check (cash_cents >= 0),
  add column tendered_cents integer check (tendered_cents >= 0),
  add column seen_by uuid references users (id),
  add column seen_at timestamptz;

alter table offline_replays alter column check_id drop not null;
alter table offline_replays add constraint offline_replays_round_check_id
  check (kind <> 'round' or check_id is not null) not valid;
alter table offline_replays validate constraint offline_replays_round_check_id;
alter table offline_replays add constraint offline_replays_cash_sale_cents
  check (kind <> 'cash_sale' or (cash_cents is not null and tendered_cents is not null)) not valid;
alter table offline_replays validate constraint offline_replays_cash_sale_cents;

alter table offline_replays drop constraint offline_replays_outcome_check;
alter table offline_replays add constraint offline_replays_outcome_check
  check (outcome in ('held', 'failed', 'sold')) not valid;
alter table offline_replays validate constraint offline_replays_outcome_check;

-- A sold cash sale names its order, as a held round does.
alter table offline_replays drop constraint offline_replays_check1;
alter table offline_replays add constraint offline_replays_check1
  check ((outcome in ('held', 'sold')) = (order_id is not null)) not valid;
alter table offline_replays validate constraint offline_replays_check1;
alter table offline_replays add constraint offline_replays_sold_cash_sale
  check (outcome <> 'sold' or kind = 'cash_sale') not valid;
alter table offline_replays validate constraint offline_replays_sold_cash_sale;

-- A cash sale's own refusals: the switch was off for that night, the price the computer took
-- isn't the server's, the person who rang it isn't on the team, or the cash couldn't be taken.
alter table offline_replays drop constraint offline_replays_reason_check;
alter table offline_replays add constraint offline_replays_reason_check
  check (reason in ('earlier_night', 'no_check', 'tab_closed', 'check_paid', 'check_closed',
                    'alcohol_closed', 'cut_off', 'not_on_menu', 'out_tonight',
                    'switched_off', 'price_changed', 'no_staff', 'cash_refused')) not valid;
alter table offline_replays validate constraint offline_replays_reason_check;
