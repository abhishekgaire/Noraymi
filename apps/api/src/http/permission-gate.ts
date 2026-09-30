import type pg from "pg";
import { permissionFor, type Action, type PermissionOverride, type Role } from "@west4/shared";
import { permissionOverrides, withVenue } from "@west4/db";

/**
 * The role guard (spec 02 · Roles; M1-14): before every write, the caller's
 * role at the venue is checked against role_permissions for the action the
 * route declares. Each container caches a venue's overrides briefly.
 */
export class PermissionGate {
  private readonly cache = new Map<string, { overrides: PermissionOverride[]; at: number }>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly ttlMs = 3000,
  ) {}

  async overridesFor(venueId: string): Promise<PermissionOverride[]> {
    const hit = this.cache.get(venueId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.overrides;
    const overrides = await withVenue(this.pool, { venueId, requestId: "permission-gate" }, (c) =>
      permissionOverrides(c, venueId),
    );
    this.cache.set(venueId, { overrides, at: Date.now() });
    return overrides;
  }

  forget(venueId: string): void {
    this.cache.delete(venueId);
  }

  async allows(venueId: string, role: Role, action: Action): Promise<boolean> {
    return permissionFor(await this.overridesFor(venueId), role, action).allowed;
  }
}
