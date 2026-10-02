import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { publicReceipt, sendReceipt, type ReceiptDeps } from "../receipts/send.js";

/**
 * Receipts (M4-19; spec 08 · Checks, Public):
 *   POST /v1/venues/{v}/checks/{c}/receipts   { channel: print | text | email, to? }: Text, Email or Print
 *   GET  /v1/public/receipts/{token}           the receipt page's receipt; a wrong or expired token is not found
 * Printing goes to this screen's receipt printer (the bar's at the bar, the front desk's elsewhere).
 */
const body = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("print") }).strict(),
  z.object({ channel: z.literal("text"), to: z.string().regex(/^\+1[2-9]\d{9}$/) }).strict(),
  z.object({ channel: z.literal("email"), to: z.string().email().max(254) }).strict(),
]);

export function receiptRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; receipts: ReceiptDeps },
): void {
  app.post<{ Params: { venueId: string; checkId: string }; Body: unknown }>(
    "/v1/venues/:venueId/checks/:checkId/receipts",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "core",
        action: "payments.take",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such check");
      const parsed = body.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          'send { channel: "print" } or { channel: "text" | "email", to }',
        );
      const p = request.principal;
      const station = request.signedDevice?.kind === "bar_computer" ? "bar" : "front_desk";
      const sent = await request.inVenue((c) =>
        sendReceipt(c, request.venueId!, options.receipts, {
          checkId: request.params.checkId,
          to:
            parsed.data.channel === "print"
              ? { channel: "print", station }
              : { channel: parsed.data.channel, to: parsed.data.to },
          sentBy: p.kind === "user" ? p.userId : null,
          now: options.clock.now(),
        }),
      );
      return reply.code(201).send({ channel: parsed.data.channel, number: sent.model.number });
    },
  );

  app.get<{ Params: { token: string } }>(
    "/v1/public/receipts/:token",
    {
      config: route({
        principals: ["public"],
        module: "core",
        tokenRoute: true,
        idempotency: "none",
      }),
    },
    async (request) => publicReceipt(options.pool, request.params.token, options.clock.now()),
  );
}
