import type pg from "pg";
import {
  PIN_AGAIN_DEFAULTS,
  isGrantableAdminSection,
  permissionFor,
  type Action,
  type GrantableAdminSection,
  type PermissionOverride,
  type PinAgainAction,
  type Role,
} from "@west4/shared";
import { latestSetting, permissionOverrides, withVenue, type Queryable } from "@west4/db";

/**
 * The role guard (spec 02 · Roles; M1-14): before every write, the caller's
 * role at the venue is checked against role_permissions for the action the
 * route declares. Each container caches a venue's overrides briefly. It also
 * answers a person's Can also open grants and the venue's Ask for the PIN
 * again list (P-10), cached the same way.
 */
export class PermissionGate {
  private readonly cache = new Map<string, { overrides: PermissionOverride[]; at: number }>();
  private readonly grants = new Map<string, { sections: GrantableAdminSection[]; at: number }>();
  private readonly pins = new Map<string, { actions: PinAgainAction[]; at: number }>();

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
    this.pins.delete(venueId);
    for (const key of this.grants.keys())
      if (key.startsWith(`${venueId}:`)) this.grants.delete(key);
  }

  async allows(venueId: string, role: Role, action: Action): Promise<boolean> {
    return permissionFor(await this.overridesFor(venueId), role, action).allowed;
  }

  /** The Admin sections the owner gave this person on top of their role (P-10), live grants only. */
  async grantsFor(venueId: string, membershipId: string): Promise<GrantableAdminSection[]> {
    const key = `${venueId}:${membershipId}`;
    const hit = this.grants.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.sections;
    const sections = await withVenue(this.pool, { venueId, requestId: "permission-gate" }, (c) =>
      liveGrants(c, venueId, membershipId),
    );
    this.grants.set(key, { sections, at: Date.now() });
    return sections;
  }

  /** The actions this venue asks the PIN again for (P-10): its `pinAgain` setting, or the default. */
  async pinAgainFor(venueId: string): Promise<PinAgainAction[]> {
    const hit = this.pins.get(venueId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.actions;
    const actions = await withVenue(
      this.pool,
      { venueId, requestId: "permission-gate" },
      async (c) => (await latestSetting(c, venueId, "pinAgain"))?.value.actions,
    );
    const list = [...(actions ?? PIN_AGAIN_DEFAULTS.actions)];
    this.pins.set(venueId, { actions: list, at: Date.now() });
    return list;
  }
}

/** A person's live Can also open grants (P-10). */
export async function liveGrants(
  c: Queryable,
  venueId: string,
  membershipId: string,
): Promise<GrantableAdminSection[]> {
  const r = await c.query<{ section: string }>(
    `select section from admin_section_grants
      where venue_id = $1 and membership_id = $2 and revoked_at is null
      order by section`,
    [venueId, membershipId],
  );
  return r.rows.map((x) => x.section).filter(isGrantableAdminSection);
}
