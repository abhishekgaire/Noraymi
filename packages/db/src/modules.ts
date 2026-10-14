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
  /**
   * The owner chose it before its own needs were in place (D129): it turns on by itself once they
   * are (Kitchen & food's printer and allergy notice), at Finish setup at the latest.
   */
  readonly wanted: boolean;
}

/** Every module's row for a venue; a module with no row is not allowed and off (core modules are always on). */
export async function venueModules(client: Queryable, venueId: string): Promise<VenueModuleRow[]> {
  const r = await client.query<VenueModuleRow>(
    `select module_id, allowed, state, wanted_at is not null as wanted
       from venue_modules where venue_id = $1`,
    [venueId],
  );
  const rows = new Map(r.rows.map((row) => [row.module_id, row]));
  return moduleIds.map((id) => {
    const def = moduleDef(id);
    const row = rows.get(id);
    if (def.core) return { module_id: id, allowed: true, state: "on", wanted: false };
    // Every plan allows it (D126, D129), whatever an older row says.
    if (row) return def.allowedOff ? { ...row, allowed: true } : row;
    // A module split out of another (D124) reads as that one's row until it has its own.
    if (def.inherits) {
      const from = moduleDef(def.inherits);
      const parent = rows.get(def.inherits);
      if (from.core) return { module_id: id, allowed: true, state: "on", wanted: false };
      if (parent)
        return { module_id: id, allowed: parent.allowed, state: parent.state, wanted: false };
    }
    if (def.allowedOff) return { module_id: id, allowed: true, state: "off", wanted: false };
    return { module_id: id, allowed: false, state: "off", wanted: false };
  });
}

/** Whether one module is on at a venue now (inherited rows and core modules included). */
export async function moduleOn(client: Queryable, venueId: string, id: ModuleId): Promise<boolean> {
  const row = (await venueModules(client, venueId)).find((r) => r.module_id === id);
  return row?.state === "on";
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
  // A module's first row keeps what it read as before (an inherited row, D124). Setting a state
  // ends "on once ready" (D129): the owner, or the needs being met, has decided.
  const was = (await venueModules(client, venueId)).find((r) => r.module_id === moduleId);
  await client.query(
    `insert into venue_modules (venue_id, module_id, allowed, state, updated_by)
     values ($1, $2, $5, $3, $4)
     on conflict (venue_id, module_id) do update set state = excluded.state, updated_by = excluded.updated_by, updated_at = now(),
       wanted_at = null`,
    [venueId, moduleId, state, updatedBy ?? null, was?.allowed ?? false],
  );
}

export async function setModuleAllowed(
  client: Queryable,
  venueId: string,
  moduleId: ModuleId,
  allowed: boolean,
  updatedBy: string | undefined,
): Promise<void> {
  const was = (await venueModules(client, venueId)).find((r) => r.module_id === moduleId);
  await client.query(
    `insert into venue_modules (venue_id, module_id, allowed, state, updated_by)
     values ($1, $2, $3, $5, $4)
     on conflict (venue_id, module_id) do update set allowed = excluded.allowed, updated_by = excluded.updated_by, updated_at = now()`,
    [
      venueId,
      moduleId,
      allowed,
      updatedBy ?? null,
      was && !moduleDef(moduleId).core ? was.state : "off",
    ],
  );
}

/**
 * Records that the owner wants a module on once its own needs are in place (D129), or forgets it.
 * The module itself stays off until `switchOnWanted` (the API) finds the needs met.
 */
export async function setModuleWanted(
  client: Queryable,
  venueId: string,
  moduleId: ModuleId,
  wanted: boolean,
  updatedBy: string | undefined,
): Promise<void> {
  const was = (await venueModules(client, venueId)).find((r) => r.module_id === moduleId);
  await client.query(
    `insert into venue_modules (venue_id, module_id, allowed, state, wanted_at, updated_by)
     values ($1, $2, $3, $4, case when $5 then now() end, $6)
     on conflict (venue_id, module_id) do update
       set wanted_at = case when $5 then coalesce(venue_modules.wanted_at, now()) end,
           updated_by = excluded.updated_by, updated_at = now()`,
    [venueId, moduleId, was?.allowed ?? false, was?.state ?? "off", wanted, updatedBy ?? null],
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
