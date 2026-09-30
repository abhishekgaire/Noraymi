import type pg from "pg";
import { isModuleId, stateOf, type ModuleId, type ModuleStates } from "@west4/shared";
import { statesOf, venueModules, withVenue } from "@west4/db";

/**
 * The module gate (spec 03 · Modules; M1-13): every route of a module that's
 * off answers 404 module_off, from the route registry. Each container keeps
 * a short cache of each venue's states, cleared when a state changes here
 * and refreshed every few seconds otherwise.
 */
export class ModuleGate {
  private readonly cache = new Map<string, { states: ModuleStates; at: number }>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlMs = 3000,
  ) {}

  async statesFor(venueId: string): Promise<ModuleStates> {
    const hit = this.cache.get(venueId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.states;
    const rows = await withVenue(this.pool, { venueId, requestId: "module-gate" }, (c) =>
      venueModules(c, venueId),
    );
    const states = statesOf(rows);
    this.cache.set(venueId, { states, at: Date.now() });
    return states;
  }

  forget(venueId: string): void {
    this.cache.delete(venueId);
  }

  /** "off" answers module_off on every route; "stopping" only on routes that create new work. */
  async blocks(venueId: string, module: string, createsNewWork: boolean): Promise<boolean> {
    if (module === "core" || !isModuleId(module)) return false;
    const state = stateOf(await this.statesFor(venueId), module as ModuleId);
    if (state === "off") return true;
    return state === "stopping" && createsNewWork;
  }
}
