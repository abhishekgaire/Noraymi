-- Send to kitchen (K-05; Kitchen and food · Ordering food, D99).
--   * order_items stays append-only except for Send to kitchen: the API may set when a food line
--     was sent and by whom, and the note and allergy confirmed at Send, nothing else.
-- Row-level security is unchanged: order_items already forces it.
set lock_timeout = '5s';

grant update (kitchen_sent_at, kitchen_sent_by, kitchen_note, kitchen_note_allergy) on order_items to app_rw;
