-- A printer's command set (W-02; D127): what a desktop app host sends it raw. ESC/POS for most
-- receipt printers (the Epson TM-T88V, the Rongta RP326); Star raster for the Star TSP100III, which
-- prints images only. Null is ESC/POS, as every printer was before. Cloud printers ignore it.
-- Row-level security is unchanged: devices already forces it.
set lock_timeout = '5s';

alter table devices add column command_set text check (command_set in ('escpos', 'star_raster'));
