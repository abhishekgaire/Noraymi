import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ClosureExists,
  closureOn,
  createClosure,
  emitEvent,
  listClosures,
  readSetting,
} from "@west4/db";
import { businessDate, hoursFor, openNow } from "@west4/rules";
import { formatInZone, Temporal, type Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { page, parseListQuery } from "../http/paging.js";

interface VenueParams {
  venueId: string;
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const closureBody = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(["closed", "special"]),
    opens: time.nullable().optional(),
    closes: time.nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();

/**
 * Closures and each business date's hours (M1-12):
 *   GET  /v1/venues/{v}/closures?from=&to=&after=   special and closed dates, in date order
 *   POST /v1/venues/{v}/closures                   { date, kind, opens?, closes?, note? }
 *   GET  /v1/venues/{v}/hours?business_date=        opens, closes, last call as instants, and open_now
 * GET /hours isn't in the API table; screens and jobs read "open now" from it (flagged in the ticket).
 */
export function closuresRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({
    principals: ["owner_manager", "staff", "shared_device"],
    module: "core",
    action: "admin.access",
  });
  const write = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.access",
    idempotency: "optional",
  });

  const venueOf = (request: FastifyRequest) =>
    request.inVenue(async (c) => {
      const r = await c.query<{ time_zone: string; day_cutover: string }>(
        "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
        [request.venueId],
      );
      if (!r.rows[0]) throw new ApiError("not_found", "no such venue");
      return r.rows[0];
    });

  app.get<{ Params: VenueParams; Querystring: Record<string, string> }>(
    "/v1/venues/:venueId/closures",
    { config: read },
    async (request) => {
      const q = parseListQuery(request.query);
      const rows = await request.inVenue((c) =>
        listClosures(c, request.venueId!, {
          after: q.after,
          from: request.query["from"],
          to: request.query["to"],
          limit: q.limit,
        }),
      );
      return page(rows, q.limit, (r) => r.date);
    },
  );

  app.post<{ Params: VenueParams; Body: unknown }>(
    "/v1/venues/:venueId/closures",
    { config: write },
    async (request, reply) => {
      const parsed = closureBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      const body = parsed.data;
      if (body.kind === "special" && body.opens == null && body.closes == null)
        throw new ApiError("invalid_request", "a special date needs an opening or a close");
      try {
        const created = await request.inVenue(async (c) => {
          const row = await createClosure(c, {
            venueId: request.venueId!,
            date: body.date,
            kind: body.kind,
            opens: body.opens ?? null,
            closes: body.closes ?? null,
            note: body.note ?? null,
            createdBy: request.principal.kind === "user" ? request.principal.userId : undefined,
          });
          await emitEvent(c, {
            venueId: request.venueId!,
            type: "settings.changed",
            entityId: "closures",
            entityVersion: 0,
          });
          return row;
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (error instanceof ClosureExists)
          throw new ApiError(
            "invalid_request",
            `${body.date} already has a closure; there is one row per date`,
          );
        throw error;
      }
    },
  );

  app.get<{ Params: VenueParams; Querystring: { business_date?: string } }>(
    "/v1/venues/:venueId/hours",
    { config: read },
    async (request) => {
      const venue = await venueOf(request);
      const now = options.clock.now();
      const date =
        request.query.business_date !== undefined
          ? Temporal.PlainDate.from(request.query.business_date)
          : businessDate(now, venue.time_zone, venue.day_cutover).businessDate;
      const [hours, closure] = await request.inVenue(async (c) =>
        Promise.all([
          readSetting(c, request.venueId!, "hours", date),
          closureOn(c, request.venueId!, date.toString()),
        ]),
      );
      if (!hours) throw new ApiError("not_found", '"hours" isn\'t set yet for this venue');
      const h = hoursFor(
        { timeZone: venue.time_zone, dayCutover: venue.day_cutover },
        date,
        hours.value,
        closure,
      );
      const fmt = (i: Temporal.Instant | null) =>
        i === null ? null : formatInZone(i, venue.time_zone);
      return {
        business_date: h.businessDate,
        closed: h.closed,
        opens: fmt(h.opens),
        closes: fmt(h.closes),
        last_call: fmt(h.lastCall),
        source: h.source,
        open_now: openNow(h, now),
      };
    },
  );
}
