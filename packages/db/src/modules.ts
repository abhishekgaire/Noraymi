import {
  moduleDef,
  moduleIds,
  type ModuleId,
  type ModuleState,
  type ModuleStates,
} from "@west4/shared";
import type { Queryable } from "./tenancy.js";

export interface VenueModuleRow {
  readonly module_id: ModuleId;
  readonly allowed: boolean;
  readonly state: ModuleState;
}

/** Every module's row for a venue; a module with no row is not allowed and off (core modules are always on). */
export async function venueModules(client: Queryable, venueId: string): Promise<VenueModuleRow[]> {
  const r = await client.query<VenueModuleRow>(
    "select module_id, allowed, state from venue_modules where venue_id = $1",
    [venueId],
  );
  const rows = new Map(r.rows.map((row) => [row.module_id, row]));
  return moduleIds.map((id) => {
    const def = moduleDef(id);
    const row = rows.get(id);
    if (def.core) return { module_id: id, allowed: true, state: "on" };
    return row ?? { module_id: id, allowed: false, state: "off" };
  });
}

export function statesOf(rows: readonly VenueModuleRow[]): ModuleStates {
  return Object.fromEntries(rows.map((r) => [r.module_id, r.state])) as ModuleStates;
}

export async function setModuleState(
  client: Queryable,
  venueId: string,
  moduleId: ModuleId,
  state: ModuleState,
  updatedBy: string | undefined,
): Promise<void> {
  await client.query(
    `insert into venue_modules (venue_id, module_id, state, updated_by)
     values ($1, $2, $3, $4)
     on conflict (venue_id, module_id) do update set state = excluded.state, updated_by = excluded.updated_by, updated_at = now()`,
    [venueId, moduleId, state, updatedBy ?? null],
  );
}

export async function setModuleAllowed(
  client: Queryable,
  venueId: string,
  moduleId: ModuleId,
  allowed: boolean,
  updatedBy: string | undefined,
): Promise<void> {
  await client.query(
    `insert into venue_modules (venue_id, module_id, allowed, updated_by)
     values ($1, $2, $3, $4)
     on conflict (venue_id, module_id) do update set allowed = excluded.allowed, updated_by = excluded.updated_by, updated_at = now()`,
    [venueId, moduleId, allowed, updatedBy ?? null],
  );
}

export async function venueFlags(
  client: Queryable,
  venueId: string,
): Promise<Record<string, boolean>> {
  const r = await client.query<{ flag: string; on: boolean }>(
    'select flag, "on" from venue_flags where venue_id = $1',
    [venueId],
  );
  return Object.fromEntries(r.rows.map((row) => [row.flag, row.on]));
}

export async function setVenueFlag(
  client: Queryable,
  venueId: string,
  flag: string,
  on: boolean,
  setBy: string,
): Promise<void> {
  await client.query(
    `insert into venue_flags (venue_id, flag, "on", set_by) values ($1, $2, $3, $4)
     on conflict (venue_id, flag) do update set "on" = excluded."on", set_by = excluded.set_by, set_at = now()`,
    [venueId, flag, on, setBy],
  );
}
