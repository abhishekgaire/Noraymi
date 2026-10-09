-- Kitchen tickets (K-03; Kitchen and food · Stations, Kitchen tickets).
--   * The kitchen has no computer, so its printer is a network printer (Star
--     CloudPRNT or Epson Server Direct Print): a device with station kitchen
--     can't be a USB printer on a desktop-app host.
-- Row-level security is unchanged: devices already forces it.
set lock_timeout = '5s';

alter table devices add constraint devices_kitchen_network_printer_check
  check (station is distinct from 'kitchen' or protocol in ('cloudprnt', 'server_direct')) not valid;
alter table devices validate constraint devices_kitchen_network_printer_check;
