-- M1-30 · Peripherals a host computer reports.
-- A USB NFC reader (later a printer) is a device of its own kind, known by
-- its serial on the host computer that sees it, so the host's heartbeats can
-- list it as attached and the Console can show it under its host.
set lock_timeout = '5s';

alter table devices
  add column host_device_id uuid,
  add column serial         text,
  add constraint devices_host_fkey foreign key (venue_id, host_device_id) references devices (venue_id, id);
-- No index: a venue has a few dozen devices, and the lookup is by host and serial on that handful.
