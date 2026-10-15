import type { FastifyInstance } from "fastify";
import {
  permissionOverrides,
  postingDate,
  statesOf,
  venueModules,
  type Queryable,
} from "@west4/db";
import { permissionFor, stateOf, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { principalIs } from "../http/principal.js";
import { nightReport } from "../nights/report.js";

/**
 * Today at a glance (P-12; spec 10 · The board and staff phones):
 *   GET /v1/venues/{v}/glance   for owners and managers, the top of Rooms (the board): sales so far (the
 *                               running X report's net sales), open checks, rooms in use and who's on the
 *                               clock, all for tonight's posting date.
 * Sales so far is null for anyone who couldn't open the X report itself: the role needs Reports
 * (`reports.view`) and the session must be a passkey or authenticator one, as the report's own route
 * asks (a PIN or badge session on a shared screen never sees it). On the clock is null while Team,
 * time clock & tips is off. Practice (training) rooms and tabs aren't counted, as the X report leaves
 * them out.
 */
export interface Glance {
  readonly business_date: string;
  readonly sales_cents: number | null;
  readonly open_checks: number;
  readonly rooms_in_use: number;
  readonly on_the_clock: number | null;
}

const one = async (c: Queryable, sql: string, venueId: string) =>
  Number((await c.query<{ n: string }>(sql, [venueId])).rows[0]?.n ?? 0);

/** The counts behind the glance, the same ones Close the night lists as still open. */
export async function glanceCounts(c: Queryable, venueId: string) {
  const roomsInUse = await one(
    c,
    "select count(*)::text as n from room_sessions where venue_id = $1 and ended_at is null and not training",
    venueId,
  );
  const openTabs = await one(
    c,
    `select count(*)::text as n from tabs t join checks k on k.venue_id = t.venue_id and k.id = t.check_id
      where t.venue_id = $1 and t.state in ('open', 'tipping') and not k.training`,
    venueId,
  );
  const teamOff = stateOf(statesOf(await venueModules(c, venueId)), "team") === "off";
  const onTheClock = teamOff
    ? null
    : await one(
        c,
        "select count(*)::text as n from shifts where venue_id = $1 and ended_at is null",
        venueId,
      );
  return { rooms_in_use: roomsInUse, open_checks: roomsInUse + openTabs, on_the_clock: onTheClock };
}

export function glanceRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/glance",
    { config: route({ principals: ["owner_manager", "staff"], module: "core" }) },
    async (request): Promise<Glance> => {
      const venueId = request.venueId!;
      const p = request.principal;
      const role =
        p.kind === "user" ? p.memberships.find((m) => m.venueId === venueId)?.role : undefined;
      if (role !== "owner" && role !== "manager")
        throw new ApiError("forbidden", "the glance is for owners and managers");
      const now = options.clock.now();
      return request.inVenue(async (c) => {
        const date = await postingDate(c, venueId, now);
        const seesSales =
          principalIs(p, "owner_manager", venueId) &&
          permissionFor(await permissionOverrides(c, venueId), role, "reports.view").allowed;
        const sales = seesSales ? (await nightReport(c, venueId, date, now)).sales.net_cents : null;
        return { business_date: date, sales_cents: sales, ...(await glanceCounts(c, venueId)) };
      });
    },
  );
}
