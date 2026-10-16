-- Tax-exempt checks (P-15; Money rules 8; module tax_exempt). A check marked tax exempt names the
-- organization and its exemption certificate number, both required; it's written once a manager
-- approves per the venue's approval setting (phone, PIN or none). Each finalize then taxes only the
-- categories in `still_taxed`, the venue's `taxExempt.stillTaxed` as it stood when it was given
-- (drinks by default, the accountant's to change), so the money audit works it out the same way
-- later. One stands on a check at a time; removing it is allowed while the check is open, before
-- payment; the row stays for the audit log, the Z report, the tax quarter and the money audit.
set lock_timeout = '5s';

create table check_tax_exemptions (
  id             uuid primary key default gen_random_uuid(),
  venue_id       uuid not null references venues (id),
  check_id       uuid not null,
  business_date  date not null,
  organization   text not null check (char_length(btrim(organization)) between 1 and 200),
  certificate_no text not null check (char_length(btrim(certificate_no)) between 1 and 60),
  still_taxed    text[] not null default '{}'
                   check (still_taxed <@ array['room_time', 'drink', 'food', 'song', 'damage', 'fee',
                                               'surcharge']::text[]),
  added_by       uuid not null references users (id),
  added_at       timestamptz not null,
  approved_by    uuid references users (id),
  removed_by     uuid references users (id),
  removed_at     timestamptz,
  check ((removed_by is null) = (removed_at is null)),
  unique (venue_id, id),
  foreign key (venue_id, check_id) references checks (venue_id, id)
);
-- One exemption stands on a check at a time.
create unique index check_tax_exemptions_one_standing on check_tax_exemptions (venue_id, check_id)
  where removed_at is null;
-- A closed night takes no new exemption (M7's guard, as on every table with a business date).
create trigger closed_night_guard before insert or update of business_date on check_tax_exemptions
  for each row execute function refuse_closed_night();
alter table check_tax_exemptions enable row level security;
alter table check_tax_exemptions force row level security;
create policy venue_isolation on check_tax_exemptions to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on check_tax_exemptions to app_rw;
grant update (removed_by, removed_at) on check_tax_exemptions to app_rw;
-- A one-venue restore (M8-20) needs the wall and the grants every venue table has.
create policy restore_wall on check_tax_exemptions to app_migrator
  using (venue_id = app_venue_id()) with check (venue_id = app_venue_id());
grant select, insert on check_tax_exemptions to app_migrator;
select audit_table('check_tax_exemptions');

-- Making a check tax exempt waits for a manager's approval, per the venue's setting.
alter table approvals drop constraint approvals_kind_check;
alter table approvals add constraint approvals_kind_check
  check (kind in ('comp', 'void', 'refund', 'clock_pause', 'tip_review', 'paid_out', 'party_size_down',
                  'card_on_file', 'over_hold', 'drawer_handover', 'discount', 'tip_change',
                  'tax_exempt')) not valid;
alter table approvals validate constraint approvals_kind_check;
