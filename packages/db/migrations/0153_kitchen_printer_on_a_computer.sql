-- The kitchen printer can be cabled to a bar computer (W-03; D127, replacing D105's cloud-only rule):
-- a USB printer on a desktop app host may have station kitchen, chosen in Admin → Printers & devices,
-- so the database no longer refuses it. Row-level security is unchanged: devices already forces it.
set lock_timeout = '5s';

alter table devices drop constraint devices_kitchen_network_printer_check;
