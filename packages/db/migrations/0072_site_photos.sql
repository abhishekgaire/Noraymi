-- Photos on the guest site (M5-02; Settings · website; Security and data
-- retention 14): Admin → Website uploads them through POST /files as their own
-- kind, each saved with alt text in the site_versions content.
set lock_timeout = '5s';

alter table files drop constraint files_kind_check;
alter table files add constraint files_kind_check
  check (kind in ('damage_photo', 'slip_photo', 'paid_out_photo', 'lost_item_photo', 'license_copy', 'songbook',
                  'dispute_evidence', 'menu_pdf', 'receipt_pdf', 'site_photo')) not valid;
alter table files validate constraint files_kind_check;

-- Publishing gives the draft the next version number, so the newest published
-- version is always the highest one, republished versions included.
grant update (version) on site_versions to app_rw;
