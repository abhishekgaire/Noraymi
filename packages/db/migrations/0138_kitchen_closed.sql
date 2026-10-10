-- Close the kitchen (K-07; Kitchen and food · 86 and closing the kitchen).
--   * A manager's Close the kitchen stops every food item until the night's end (the next
--     cutover); Reopen the kitchen clears it the same night, and the night close clears it too.
--     It's kept apart from each item's own 86, so reopening never brings back an item that was
--     86'd on its own.
-- Row-level security is unchanged: venues already forces it.
set lock_timeout = '5s';

alter table venues add column kitchen_closed_until timestamptz;
alter table venues add column kitchen_closed_by uuid references users (id);
grant update (kitchen_closed_until, kitchen_closed_by) on venues to app_rw;
