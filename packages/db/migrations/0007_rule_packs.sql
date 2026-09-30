-- 0007 · rule packs (spec 03 · Rule packs; spec 04 · rule_packs; spec 12 · 11; M1-10).
-- Venues read, never write. Versions are signed and need two approvers.
set lock_timeout = '5s';

create table rule_pack_signing_keys (
  key_id     text primary key,
  public_key text not null,                    -- Ed25519 public key, PEM (SPKI)
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

create table rule_packs (
  id           text not null,
  version      text not null,
  effective_on date not null,                  -- applies from this business date
  data         jsonb not null,
  approved_by  text[] not null,                -- two named people on our side
  signature    text not null,                  -- Ed25519 over the canonical JSON of data, base64
  key_id       text not null references rule_pack_signing_keys (key_id),
  published_at timestamptz not null default now(),
  primary key (id, version)
);

alter table rule_pack_signing_keys enable row level security;
alter table rule_pack_signing_keys force row level security;
create policy read_all on rule_pack_signing_keys for select to app_rw using (true);
alter table rule_packs enable row level security;
alter table rule_packs force row level security;
create policy read_all on rule_packs for select to app_rw using (true);
grant select on rule_pack_signing_keys, rule_packs to app_rw;
