-- M1-36 · Rule-pack versions are proposed, approved by two of our staff and
-- signed in the Console. Drafts live here; a published version goes into
-- rule_packs through one definer door, because app_rw may only read packs
-- (0007). Platform tables: no venue.
set lock_timeout = '5s';

create table rule_pack_drafts (
  id           uuid primary key default gen_random_uuid(),
  pack_id      text not null,
  version      text not null,
  effective_on date not null,
  data         jsonb not null,
  created_by   uuid not null references console_staff (id),
  created_at   timestamptz not null default now(),
  approvals    jsonb not null default '[]'::jsonb,   -- [{ "staff_id", "name", "at" }], one entry per person
  published_at timestamptz,
  unique (pack_id, version)
);
grant select, insert, update on rule_pack_drafts to app_rw;

-- The door: inserts the signing key (if new) and the version. The caller
-- signs in the API with the key service's key; the row stays app_rw-proof.
create or replace function publish_rule_pack_version(
  p_pack_id text, p_version text, p_effective_on date, p_data jsonb,
  p_approved_by text[], p_signature text, p_key_id text, p_public_key text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare inserted integer;
begin
  if coalesce(array_length(p_approved_by, 1), 0) < 2 then
    raise exception 'a rule-pack version needs two approvers';
  end if;
  insert into rule_pack_signing_keys (key_id, public_key) values (p_key_id, p_public_key)
    on conflict (key_id) do nothing;
  insert into rule_packs (id, version, effective_on, data, approved_by, signature, key_id)
    values (p_pack_id, p_version, p_effective_on, p_data, p_approved_by, p_signature, p_key_id)
    on conflict (id, version) do nothing;
  get diagnostics inserted = row_count;
  return inserted > 0;
end $$;
-- The door's owner needs its own way in: app_definer writes packs and keys, nobody else but the migrator.
grant select, insert on rule_pack_signing_keys, rule_packs to app_definer;
create policy definer_all on rule_pack_signing_keys to app_definer using (true) with check (true);
create policy definer_all on rule_packs to app_definer using (true) with check (true);
alter function publish_rule_pack_version(text, text, date, jsonb, text[], text, text, text) owner to app_definer;
revoke all on function publish_rule_pack_version(text, text, date, jsonb, text[], text, text, text) from public;
grant execute on function publish_rule_pack_version(text, text, date, jsonb, text[], text, text, text) to app_rw;

-- The Console's venue list now says which pack each venue uses.
drop function console_venues();
create or replace function console_venues()
returns table (id uuid, name text, slug text, time_zone text, rule_pack_id text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select id, name, slug, time_zone, rule_pack_id from venues order by name
$$;
alter function console_venues() owner to app_definer;
revoke all on function console_venues() from public;
grant execute on function console_venues() to app_rw;
