import type pg from "pg";
import { venueClockSettings, venueSubscription, withVenue } from "@west4/db";
import { planState } from "@west4/rules";
import type { Clock } from "@west4/shared";
import type { RouteSpec } from "./registry.js";

/**
 * Read-only Admin (M8-15; spec 03 · Plan billing): once our plan's payment
 * has failed and its 14 days are up, every Admin write is refused with
 * `403 admin_read_only`. Only Admin is read: a route counts as Admin when
 * its action is `admin.*`, so the board, rooms, bar and payments never read
 * the billing status. Paying our plan stays open (`openWhenReadOnly`).
 */
export function readOnlyApplies(spec: RouteSpec, method: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return (spec.action ?? "").startsWith("admin.") && spec.openWhenReadOnly !== true;
}

export class PlanGate {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock,
  ) {}

  async readOnly(venueId: string): Promise<boolean> {
    const { sub, zone } = await withVenue(
      this.pool,
      { venueId, requestId: "plan-gate" },
      async (c) => ({
        sub: await venueSubscription(c, venueId),
        zone: await venueClockSettings(c, venueId),
      }),
    );
    return planState(sub, this.clock.now(), zone.time_zone, zone.day_cutover).state === "read_only";
  }
}

/**
 * An Admin write that stays open while Admin is read-only (M8-15, D94):
 * paying our plan, erasing a guest or a singer on request (the law doesn't
 * wait on our invoice), and taking access away (a team member, a badge, a
 * device, a support grant), so an unpaid plan never keeps a door open.
 */
export function openWhileReadOnly(config: { route: RouteSpec }): { route: RouteSpec } {
  return { route: { ...config.route, openWhenReadOnly: true } };
}
