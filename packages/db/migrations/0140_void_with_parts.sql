-- Voiding a meal's or combo's parts with it (K-12; Kitchen and food · Meals, combos and sauces;
-- Money rules 7).
--   * check_lines.part_of_id: a comp or void of a component, written in the same action as the
--     comp or void of the line it came with, points at that line's comp or void. The reports
--     show the pair as one entry, at the whole amount, naming the parts.
-- Row-level security is unchanged: check_lines already forces it. The live view is redefined
-- so it carries the new column (a view's column list is fixed when it's made).
set lock_timeout = '5s';

alter table check_lines add column part_of_id bigint;
alter table check_lines add constraint check_lines_part_of_fkey
  foreign key (venue_id, part_of_id) references check_lines (venue_id, id) not valid;
alter table check_lines validate constraint check_lines_part_of_fkey;

create or replace view live_check_lines with (security_invoker = true) as
  select l.* from check_lines l
   where exists (select 1 from checks k where k.venue_id = l.venue_id and k.id = l.check_id and not k.training);
