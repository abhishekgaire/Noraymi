import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import { confirmPayLink, openPayLink } from "../payments/pay-link.js";

/**
 * The payment page's API (M4-15; spec 08 · Bookings, POST /v1/public/pay/{token}):
 *   POST /v1/public/pay/{token}           the payment's client secret, the venue's account and the amount
 *   POST /v1/public/pay/{token}/confirm   after the Payment Element confirms: read Stripe now
 * Token routes: Referrer-Policy no-referrer and Cache-Control no-store.
 */
const confirmBody = z
  .object({
    test_card: z
      .string()
      .regex(/^pm_card_[a-zA-Z]+$/)
      .optional(),
  })
  .strict();

export function payRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; stripe: () => StripeClient },
): void {
  const deps = () => ({ pool: options.pool, stripe: options.stripe(), clock: options.clock });
  const config = route({
    principals: ["public"],
    module: "core",
    tokenRoute: true,
    idempotency: "optional",
    exemptWhenOff: true,
  });
  app.post<{ Params: { token: string } }>("/v1/public/pay/:token", { config }, async (request) =>
    openPayLink(deps(), request.params.token),
  );
  app.post<{ Params: { token: string }; Body: unknown }>(
    "/v1/public/pay/:token/confirm",
    { config },
    async (request) => {
      const parsed = confirmBody.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError("invalid_request", "send {} (or a test card on the fake Stripe)");
      return confirmPayLink(deps(), request.params.token, parsed.data.test_card);
    },
  );
}
