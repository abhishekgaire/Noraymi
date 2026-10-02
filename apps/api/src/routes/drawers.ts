import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  emitEvent,
  openDrawerSession,
  readSetting,
  venueDrawers,
  withVenue,
  type Queryable,
  type Sweep,
} from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { type Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { managerOnDutyAt } from "../approvals/service.js";

/**
 * Cash drawers (M4-13; Money rules 15; spec 08 · Drawer):
 *   GET  /v1/venues/{v}/drawers            each drawer, its printer and its open session
 *   POST /v1/venues/{v}/drawers/{d}/open   open the drawer's session by hand, with the starting bank
 * The `drawers.open` sweep opens every drawer's session as the business date
 * starts, with `drawer.startingBankCents` and the model from the `drawer`
 * setting, so cash always has somewhere to go. Counts, handovers and closing
 * come in M7.
 */
async function openFor(c: Queryable, venueId: string, drawerId: string, now: Temporal.Instant) {
  const v = (
    await c.query<{ time_zone: string; day_cutover: string }>(
      "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
      [venueId],
    )
  ).rows[0]!;
  const date = businessDate(now, v.time_zone, v.day_cutover).businessDate;
  const setting = await readSetting(c, venueId, "drawer", date);
  const model = setting?.value.drawer === "perPerson" ? "per_person" : "house";
  return openDrawerSession(c, venueId, {
    drawerId,
    model,
    responsibleId: model === "house" ? await managerOnDutyAt(c, venueId, now) : null,
    businessDate: date.toString(),
    openingCents: setting?.value.startingBankCents ?? 0,
    at: now.toString(),
  });
}

export function drawerRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/drawers",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => ({
      drawers: (await request.inVenue((c) => venueDrawers(c, request.venueId!))).map((d) => ({
        id: d.id,
        name: d.name,
        station: d.station,
        printer: d.printer_name,
        open: d.session_id !== null,
        opening_cents: d.opening_cents,
      })),
    }),
  );

  app.post<{ Params: { venueId: string; d: string } }>(
    "/v1/venues/:venueId/drawers/:d/open",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "core",
        action: "drawer.count",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.d).success)
        throw new ApiError("not_found", "no such drawer");
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        const found = await c.query("select 1 from cash_drawers where venue_id = $1 and id = $2", [
          venueId,
          request.params.d,
        ]);
        if (found.rowCount === 0) throw new ApiError("not_found", "no such drawer");
        const s = await openFor(c, venueId, request.params.d, options.clock.now());
        if (s.opened)
          await emitEvent(c, { venueId, type: "drawer.updated", entityId: request.params.d });
        return { session_id: s.id, opened: s.opened };
      });
    },
  );
}

/** Opens every drawer's session for the business date that has started, if it isn't open yet. */
export async function sweepDrawers(pool: pg.Pool, now: Temporal.Instant): Promise<number> {
  const venues = await pool.query<{ id: string }>("select id from venues_for_scheduler()");
  let opened = 0;
  for (const v of venues.rows)
    opened += await withVenue(pool, { venueId: v.id, requestId: "drawers-open" }, async (c) => {
      let n = 0;
      for (const d of await venueDrawers(c, v.id))
        if (!d.session_id && (await openFor(c, v.id, d.id, now)).opened) n += 1;
      return n;
    });
  return opened;
}

export function drawerSweep(pool: pg.Pool): Sweep {
  return {
    name: "drawers.open",
    everyMs: 5 * 60_000,
    run: async (now) => void (await sweepDrawers(pool, now)),
  };
}
