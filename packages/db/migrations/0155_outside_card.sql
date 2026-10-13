-- Paid on an outside card machine (F-10; D126; spec 07 · Outside card machine): staff charge the
-- venue's own non-Stripe machine, then record the amount and tip here. A new payment method, who
-- recorded it (Close the night's by-person total, matched to the machine's batch report), and an
-- optional note of a last 4 or an approval code: never a card number, so any run of 13 or more
-- digits is refused here as well as by the route. No Stripe id, no attempt, no reconciler.
set lock_timeout = '5s';

alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('card_present', 'card_online', 'card_on_file', 'cash', 'external', 'prepaid', 'outside_card')) not valid;
alter table payments validate constraint payments_method_check;

alter table payments add column taken_by uuid references users (id);
alter table payments add column outside_note text
  check (outside_note is null or (char_length(outside_note) between 1 and 40
         and outside_note !~ '[0-9]([ -]?[0-9]){12,}'));
alter table payments add constraint payments_outside_note_method
  check (outside_note is null or method = 'outside_card') not valid;
alter table payments validate constraint payments_outside_note_method;

-- The note stays out of the audit log's copies, like a held card's last 4 (O-08).
set role app_migrator;
insert into audit_redactions values ('payments', 'outside_note');
reset role;
