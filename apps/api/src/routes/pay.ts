import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import {
  confirmPayLink,
  openPayLink,
  payLinkMoreTime,
  startPayLink,
} from "../payments/pay-link.js";
import { loadTrustedProxyHops, publicIpOf } from "../router/ip-owner.js";

/**
 * The payment page's API (M4-15; spec 08 · Bookings, POST /v1/public/pay/{token}):
 *   POST /v1/public/pay/{token}           the payment's client secret, the venue's account and the amount
 *   POST /v1/public/pay/{token}/start     the guest pressed Pay: a deposit records the policy accepted (M5-09)
 *   POST /v1/public/pay/{token}/confirm   after the Payment Element confirms: read Stripe now
 *   POST /v1/public/pay/{token}/more-time a deposit's hold: 10 more minutes (M5-09)
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
  options: {
    pool: pg.Pool;
    clock: Clock;
    stripe: () => StripeClient;
    guestAppUrl?: string | null;
  },
): void {
  const deps = () => ({
    pool: options.pool,
    stripe: options.stripe(),
    clock: options.clock,
    guestAppUrl: options.guestAppUrl ?? null,
  });
  const proxyHops = loadTrustedProxyHops();
  const startBody = z.object({ policy_version_id: z.string().uuid().optional() }).strict();
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
  app.post<{ Params: { token: string }; Body: unknown }>(
    "/v1/public/pay/:token/start",
    { config },
    async (request) => {
      const parsed = startBody.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { policy_version_id } for a deposit");
      return startPayLink(deps(), request.params.token, {
        policyVersionId: parsed.data.policy_version_id ?? null,
        ip: publicIpOf(request.ip, request.headers["x-forwarded-for"], proxyHops),
        userAgent: String(request.headers["user-agent"] ?? ""),
      });
    },
  );
  app.post<{ Params: { token: string } }>(
    "/v1/public/pay/:token/more-time",
    { config },
    async (request) => payLinkMoreTime(deps(), request.params.token),
  );
}
