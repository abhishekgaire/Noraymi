-- Walkouts and the tab cut-off (M6-16; Payment flows · Bar tab with a growing
-- hold, step 6; Data model · Tabs at the cut-off and at close; API · `POST
-- /nights/{date}/charge-remaining-tabs`; settings tabs.cutOffAt).
--  - Charge the remaining tabs (a manager, after one confirmation) and the
--    4:30 AM cut-off job close an open tab with no tip: a `tab_closings` row
--    with `walkout` set. It captures the balance up to the hold plus Stripe's
--    overcapture allowance; anything left (`rest_cents`) goes on the card
--    saved from the first tap (`rest_payment_id`, an off-session charge), or
--    the tab becomes capture_failed for a manager. The tab ends
--    walkout_captured.
--  - `evidence`: the tab's drinks with the times they went on, kept with the
--    Close as dispute evidence.
--  - The cut-off job has no person: `closed_by` is empty for it.
--  - `tab_cut_off_runs`: one row per business date, so the job runs once a
--    night (the scheduler works its time out per date, in UTC); a run killed
--    midway is picked up again until it's finished.
set lock_timeout = '5s';

alter table tab_closings add column walkout text check (walkout in ('charge_remaining', 'cut_off'));
alter table tab_closings add column rest_cents integer check (rest_cents >= 0);
alter table tab_closings add column rest_payment_id uuid;
alter table tab_closings add constraint tab_closings_rest_payment_fk
  foreign key (venue_id, rest_payment_id) references payments (venue_id, id) not valid;
alter table tab_closings validate constraint tab_closings_rest_payment_fk;
alter table tab_closings add column evidence jsonb;
alter table tab_closings alter column closed_by drop not null;

create table tab_cut_off_runs (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  business_date  date not null,
  due_at         timestamptz not null,
  started_at     timestamptz not null,
  finished_at    timestamptz,
  -- Tabs the run started charging (each once: a tab with a Close under way is never started again).
  tabs_charged   integer not null default 0 check (tabs_charged >= 0),
  unique (venue_id, id),
  unique (venue_id, business_date)
);
alter table tab_cut_off_runs enable row level security;
alter table tab_cut_off_runs force row level security;
create policy venue_isolation on tab_cut_off_runs to app_rw
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on tab_cut_off_runs to app_rw;
grant update (finished_at, tabs_charged) on tab_cut_off_runs to app_rw;
select audit_table('tab_cut_off_runs');
