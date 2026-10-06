import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Clock } from "@west4/shared";
import { postingDate } from "@west4/db";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { askRefund, refundView, refundable } from "../payments/refunds.js";

/**
 * Refunds (M4-21; spec 08 · Payments, Bookings):
 *   POST /v1/venues/{v}/checks/{c}/refunds     { lines?, parts, reason }: 202 approval_pending
 *   POST /v1/venues/{v}/bookings/{b}/refunds   { parts, reason }: a deposit before check-in; 202
 *   GET  /v1/venues/{v}/refunds/{r}            Waiting for Abhishek, Refund pending, Refunded or failed
 * Owners and managers ask (refunds.request), with the passkey again (step-up); each payment's part is
 * capped at what it captured less its earlier refunds (422 over_refundable).
 */
const uuid = z.string().uuid();
const part = z.object({ payment_id: uuid, amount_cents: z.number().int().positive() }).strict();
const line = z
  .object({ line_id: z.number().int().positive(), amount_cents: z.number().int().positive() })
  .strict();
const checkBody = z
  .object({
    lines: z.array(line).max(100).optional(),
    parts: z.array(part).min(1).max(20),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const bookingBody = z
  .object({ parts: z.array(part).min(1).max(5), reason: z.string().trim().min(1).max(500) })
  .strict();

export function refundRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const ask = route({
    principals: ["owner_manager", "staff", "shared_device"],
    module: "core",
    action: "refunds.request",
    idempotency: "optional",
    stepUp: true,
  });
  // Where a refund posts: tonight, or the next open night once tonight has closed (M7-02).
  const night = async (request: FastifyRequest) =>
    request.inVenue((c) => postingDate(c, request.venueId!, options.clock.now()));
  const who = (request: FastifyRequest) => {
    const p = request.principal;
    if (p.kind !== "user") throw new ApiError("forbidden", "asking for a refund is a person's");
    return {
      userId: p.userId,
      deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
    };
  };

  app.post<{ Params: { venueId: string; checkId: string }; Body: unknown }>(
    "/v1/venues/:venueId/checks/:checkId/refunds",
    { config: ask },
    async (request, reply) => {
      if (!uuid.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such check");
      const parsed = checkBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { lines?, parts: [{ payment_id, amount_cents }], reason }",
        );
      const date = await night(request);
      const answer = await request.inVenue((c) =>
        askRefund(c, request.venueId!, {
          checkId: request.params.checkId,
          bookingId: null,
          lines: (parsed.data.lines ?? []).map((l) => ({
            lineId: l.line_id,
            amountCents: l.amount_cents,
          })),
          parts: parsed.data.parts.map((p) => ({
            paymentId: p.payment_id,
            amountCents: p.amount_cents,
          })),
          reason: parsed.data.reason,
          ...who(request),
          businessDate: date,
          now: options.clock.now(),
        }),
      );
      return reply.code(202).send(answer);
    },
  );

  app.post<{ Params: { venueId: string; bookingId: string }; Body: unknown }>(
    "/v1/venues/:venueId/bookings/:bookingId/refunds",
    { config: ask },
    async (request, reply) => {
      if (!uuid.safeParse(request.params.bookingId).success)
        throw new ApiError("not_found", "no such booking");
      const parsed = bookingBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { parts: [{ payment_id, amount_cents }], reason }",
        );
      const date = await night(request);
      const answer = await request.inVenue((c) =>
        askRefund(c, request.venueId!, {
          checkId: null,
          bookingId: request.params.bookingId,
          lines: [],
          parts: parsed.data.parts.map((p) => ({
            paymentId: p.payment_id,
            amountCents: p.amount_cents,
          })),
          reason: parsed.data.reason,
          ...who(request),
          businessDate: date,
          now: options.clock.now(),
        }),
      );
      return reply.code(202).send(answer);
    },
  );

  // What the refund sheet starts from (M4-22): ?check= or ?booking=. Owners and managers only.
  app.get<{ Params: { venueId: string }; Querystring: { check?: string; booking?: string } }>(
    "/v1/venues/:venueId/refundable",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => {
      const p = request.principal;
      const role =
        p.kind === "user"
          ? p.memberships.find((m) => m.venueId === request.venueId)?.role
          : undefined;
      if (role !== "owner" && role !== "manager")
        throw new ApiError("forbidden", "owners and managers ask for refunds");
      const { check, booking } = request.query;
      if (check ? !uuid.safeParse(check).success : !booking || !uuid.safeParse(booking).success)
        throw new ApiError("invalid_request", "send ?check= or ?booking=");
      return request.inVenue((c) =>
        refundable(c, request.venueId!, { checkId: check ?? null, bookingId: booking ?? null }),
      );
    },
  );

  app.get<{ Params: { venueId: string; refundId: string } }>(
    "/v1/venues/:venueId/refunds/:refundId",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => {
      if (!uuid.safeParse(request.params.refundId).success)
        throw new ApiError("not_found", "no such refund");
      return request.inVenue((c) => refundView(c, request.venueId!, request.params.refundId));
    },
  );
}
