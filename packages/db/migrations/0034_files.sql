-- M2-13 · Files (spec 04 · files): uploaded straight to storage through a
-- presigned POST that fixes each kind's type and size. A file counts once a
-- row that needs it attaches it; unattached uploads are removed after 24
-- hours (the object from storage, and the row marked, since app_rw never deletes).
set lock_timeout = '5s';

create table files (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues (id),
  kind         text not null check (kind in ('damage_photo', 'slip_photo', 'paid_out_photo', 'lost_item_photo',
                                             'license_copy', 'songbook', 'dispute_evidence', 'menu_pdf', 'receipt_pdf')),
  storage_key  text not null unique,
  content_type text not null,
  bytes        bigint not null check (bytes > 0),
  sha256       text,
  uploaded_by  uuid,
  uploaded_at  timestamptz not null,
  attached_at  timestamptz,
  removed_at   timestamptz,
  unique (venue_id, id)
);
create index files_unattached_idx on files (uploaded_at) where attached_at is null and removed_at is null;
alter table files enable row level security;
alter table files force row level security;
create policy venue_isolation on files to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on files to app_rw;
grant update (attached_at, removed_at, sha256) on files to app_rw;
select audit_table('files');
