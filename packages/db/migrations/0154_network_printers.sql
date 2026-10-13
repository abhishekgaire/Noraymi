-- Network printers on the venue's LAN (W-04; D127): a printer of protocol 'lan' has a fixed private
-- IPv4 address and a port (9100 by default) and is printed raw by a desktop app computer on the same
-- network. relay_device_ids names the computers that may relay it (null: any bar computer). One
-- relay at a time holds a short lease (relay_host_id until relay_until), renewed every poll, so a
-- ticket is handed to one computer only.
-- Row-level security is unchanged: devices already forces it, and the relays are checked against
-- the venue's own devices by the API.
set lock_timeout = '5s';

alter table devices drop constraint devices_protocol_check;
alter table devices add constraint devices_protocol_check
  check (protocol in ('cloudprnt', 'server_direct', 'usb', 'lan')) not valid;
alter table devices validate constraint devices_protocol_check;

alter table devices add column network_address text;
alter table devices add column network_port integer check (network_port between 1 and 65535);
alter table devices add column relay_device_ids uuid[];
alter table devices add column relay_host_id uuid;
alter table devices add column relay_until timestamptz;

alter table devices add constraint devices_lan_printer_address_check
  check (protocol is distinct from 'lan' or (network_address is not null and network_port is not null)) not valid;
alter table devices validate constraint devices_lan_printer_address_check;
