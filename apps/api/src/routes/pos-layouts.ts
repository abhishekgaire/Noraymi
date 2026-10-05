import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { readSetting } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { venueClock } from "../rooms/assignment.js";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { layoutsView, publishLayout, saveLayoutDraft } from "../pos/layouts.js";

/**
 * Bar POS layouts (M6-01; API · Bar POS):
 *   GET  /v1/venues/{v}/pos/layouts?station=bar      tonight's layout, the next one, the draft, every version
 *   POST /v1/venues/{v}/pos/layouts                  { station, sections }: save the station's draft
 *   POST /v1/venues/{v}/pos/layouts/{l}/publish      the draft goes live at the next business date
 *   GET  /v1/venues/{v}/pos/terminal                 the idle and wipe locks, and whether the caller is on a break (M6-04)
 */
const station = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

export function posLayoutRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({
    principals: ["owner_manager", "staff", "shared_device"],
    module: "bar_tabs",
    action: "pos.use",
  });
  const admin = route({
    principals: ["owner_manager"],
    module: "bar_tabs",
    action: "admin.access",
    idempotency: "optional",
  });
  const userOf = (request: FastifyRequest) =>
    request.principal.kind === "user" ? request.principal.userId : null;

  app.get<{ Params: { venueId: string }; Querystring: { station?: string } }>(
    "/v1/venues/:venueId/pos/layouts",
    { config: read },
    async (request) => {
      const s = station.safeParse(request.query.station ?? "bar");
      if (!s.success) throw new ApiError("invalid_request", "station is a lowercase name");
      return request.inVenue((c) => layoutsView(c, request.venueId!, s.data, options.clock.now()));
    },
  );

  // The bar POS terminal (M6-04): its locks, and whether the person signed in is on a break.
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/pos/terminal",
    { config: read },
    async (request) =>
      request.inVenue(async (c) => {
        const venue = await venueClock(c, request.venueId!);
        const today = businessDate(
          options.clock.now(),
          venue.timeZone,
          venue.dayCutover,
        ).businessDate;
        const pos = await readSetting(c, request.venueId!, "pos", today);
        const p = request.principal;
        const membershipId =
          p.kind === "user"
            ? (p.memberships.find((m) => m.venueId === request.venueId)?.membershipId ?? null)
            : null;
        // On a break: her last punch is a break that hasn't ended.
        const last = membershipId
          ? (
              await c.query<{ kind: string }>(
                `select kind from time_punches where venue_id = $1 and membership_id = $2
                  order by at desc, created_at desc limit 1`,
                [request.venueId, membershipId],
              )
            ).rows[0]
          : undefined;
        return {
          idle_lock_min: pos?.value.idleLockMin ?? 3,
          wipe_lock_sec: pos?.value.wipeLockSec ?? 10,
          on_break: last?.kind === "break_start",
        };
      }),
  );

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/pos/layouts",
    { config: admin },
    async (request, reply) => {
      const body = z.object({ station, sections: z.unknown() }).strict().safeParse(request.body);
      if (!body.success) throw new ApiError("invalid_request", "send { station, sections }");
      const view = await request.inVenue(async (c) => {
        await saveLayoutDraft(c, request.venueId!, {
          station: body.data.station,
          sections: body.data.sections,
          userId: userOf(request),
        });
        return layoutsView(c, request.venueId!, body.data.station, options.clock.now());
      });
      return reply.code(201).send(view);
    },
  );

  app.post<{ Params: { venueId: string; l: string } }>(
    "/v1/venues/:venueId/pos/layouts/:l/publish",
    { config: admin },
    async (request) => {
      if (!z.string().uuid().safeParse(request.params.l).success)
        throw new ApiError("not_found", "no draft layout with that id");
      return request.inVenue(async (c) => {
        const published = await publishLayout(c, request.venueId!, request.params.l, {
          userId: userOf(request),
          now: options.clock.now(),
        });
        return {
          published,
          layouts: await layoutsView(c, request.venueId!, published.station, options.clock.now()),
        };
      });
    },
  );
}
