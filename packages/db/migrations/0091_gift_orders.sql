-- Gift orders (M6-24; spec 11 · Send the singer a drink; spec 04 · orders):
-- "send the singer a drink" is an order with source gift, charged to the
-- sender's check, naming the singer it's for and the singer's check (their
-- bar tab, or none), against which the alcohol checks run. The columns came
-- in M3 without keys; singers and tabs exist now, so they get them, and a
-- gift always names its singer.
set lock_timeout = '5s';

alter table orders add constraint orders_gift_singer_fk
  foreign key (venue_id, gift_for_singer_id) references singers (venue_id, id) not valid;
alter table orders validate constraint orders_gift_singer_fk;
alter table orders add constraint orders_gift_check_fk
  foreign key (venue_id, gift_for_check_id) references checks (venue_id, id) not valid;
alter table orders validate constraint orders_gift_check_fk;
alter table orders add constraint orders_gift_names_singer
  check (source <> 'gift' or gift_for_singer_id is not null) not valid;
alter table orders validate constraint orders_gift_names_singer;
