-- How the manager on duty was told of an order still ringing at the last level (F-02; D124): by a
-- text from the venue's own number, or by a push to their phone when texts aren't live or the
-- order-waiting text is switched off. The board's alert reads it, so it never says "texted" for a push.
set lock_timeout = '5s';

alter table orders add column manager_told text check (manager_told in ('text', 'push'));
