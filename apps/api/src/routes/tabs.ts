import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { listTabs } from "../tabs/tabs.js";
import { repeatRound } from "../tabs/repeat.js";
import {
  backToTheSale,
  quickSaleNumber,
  quickSaleView,
  startQuickSale,
} from "../tabs/quick-sale.js";
import { inVenueRefusing } from "../orders/alcohol.js";

/**
 * Bar tabs (M6-02; API · Bar tabs):
 *   GET /v1/venues/{v}/tabs?state=   open tabs in the order opened and tonight's closed ones;
 *                                    ?state=awaiting_tip (and other states, comma-separated) filters
 *   POST /v1/venues/{v}/tabs/{t}/repeat-round   the last round into the caller's unsent drinks (M6-03)
 *   POST /v1/venues/{v}/quick-sales             { client_order_id, lines }: a quick check with the round, ready to pay (M6-05)
 *   GET  /v1/venues/{v}/quick-sales/{c}         the sale and the reader's tip choices
 *   POST /v1/venues/{v}/quick-sales/{c}/void    Back to the sale: voided, number kept, drinks back in the round
 * Opening, closing and the rest of the tab routes come with M6-06 onwards.
 */
const STATES =
  /^(open|tipping|awaiting_tip|captured|walkout_captured|capture_failed|closed)(,(open|tipping|awaiting_tip|captured|walkout_captured|capture_failed|closed))*$/;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tabRoutes(app: FastifyInstance, options: { clock: Clock; pool: pg.Pool }): void {
  app.get<{ Params: { venueId: string }; Querystring: { state?: string } }>(
    "/v1/venues/:venueId/tabs",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
      }),
    },
    async (request) => {
      if (request.query.state !== undefined && !STATES.test(request.query.state))
        throw new ApiError("invalid_request", "state is one of the tab states");
      const p = request.principal;
      const membershipId =
        p.kind === "user"
          ? (p.memberships.find((m) => m.venueId === request.venueId)?.membershipId ?? null)
          : null;
      const tabs = await request.inVenue((c) =>
        listTabs(c, request.venueId!, options.clock.now(), {
          state: request.query.state,
          membershipId,
        }),
      );
      return { tabs };
    },
  );

  // Repeat round (M6-03): the last round, into the caller's unsent drinks; Send still sends it.
  app.post<{ Params: { venueId: string; t: string } }>(
    "/v1/venues/:venueId/tabs/:t/repeat-round",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
        idempotency: "optional",
      }),
    },
    async (request) => {
      if (!uuid.test(request.params.t)) throw new ApiError("not_found", "no such tab");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (!m) throw new ApiError("forbidden", "not a member of this venue");
      return request.inVenue((c) =>
        repeatRound(
          c,
          request.venueId!,
          request.params.t,
          {
            membershipId: m.membershipId,
            userId: p.userId,
            deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
          },
          options.clock.now(),
        ),
      );
    },
  );

  const id = z.string().uuid();
  const quickBody = z
    .object({
      client_order_id: z.string().min(8).max(64),
      lines: z
        .array(
          z
            .object({
              variant_id: id,
              qty: z.number().int().min(1).max(99),
              option_ids: z.array(id).max(10).optional(),
              notes: z.string().max(200).nullable().optional(),
            })
            .strict(),
        )
        .max(50),
    })
    .strict();
  const sell = route({
    principals: ["owner_manager", "staff"],
    module: "bar_tabs",
    action: "pos.use",
    idempotency: "optional",
  });

  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/quick-sales",
    { config: sell },
    async (request, reply) => {
      const parsed = quickBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { client_order_id, lines }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (!m) throw new ApiError("forbidden", "not a member of this venue");
      const number = await quickSaleNumber(options.pool, request.venueId!);
      const sale = await inVenueRefusing(request, (c) =>
        startQuickSale(c, request.venueId!, {
          number,
          lines: parsed.data.lines,
          clientOrderId: parsed.data.client_order_id,
          userId: p.userId,
          membershipId: m.membershipId,
          deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send(sale);
    },
  );

  app.get<{ Params: { venueId: string; checkId: string } }>(
    "/v1/venues/:venueId/quick-sales/:checkId",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "bar_tabs",
        action: "pos.use",
      }),
    },
    async (request) => {
      if (!id.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such sale");
      return request.inVenue(async (c) => {
        const k = await c.query(
          "select 1 from checks where venue_id = $1 and id = $2 and kind = 'quick'",
          [request.venueId, request.params.checkId],
        );
        if (k.rowCount === 0) throw new ApiError("not_found", "no such sale");
        return quickSaleView(c, request.venueId!, request.params.checkId, options.clock.now());
      });
    },
  );

  app.post<{ Params: { venueId: string; checkId: string } }>(
    "/v1/venues/:venueId/quick-sales/:checkId/void",
    { config: sell },
    async (request) => {
      if (!id.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such sale");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
      const m = p.memberships.find((x) => x.venueId === request.venueId);
      if (!m) throw new ApiError("forbidden", "not a member of this venue");
      return request.inVenue((c) =>
        backToTheSale(c, request.venueId!, request.params.checkId, {
          userId: p.userId,
          membershipId: m.membershipId,
          deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
          now: options.clock.now(),
        }),
      );
    },
  );
}
