import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import {
  confirmPerson,
  goLive,
  refreshMerchantCategory,
  setExpectedCategory,
} from "../payments/go-live.js";
import type { StripeClient } from "../stripe/client.js";

/**
 * The go-live checklist in Admin → Payments (M4-29), the owner's:
 *   GET  /v1/venues/{v}/go-live                       reads the account's merchant category, then the checklist
 *   PUT  /v1/venues/{v}/go-live/merchant-category     { expected }: the category we expect for the venue
 *   POST /v1/venues/{v}/go-live/people/{u}            { check: dashboard_login | tap_to_pay, confirmed }
 */
const uuid = z.string().uuid();
const expectedBody = z
  .object({
    expected: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
  })
  .strict();
const personBody = z
  .object({ check: z.enum(["dashboard_login", "tap_to_pay"]), confirmed: z.boolean() })
  .strict();

export function goLiveRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; stripe: () => StripeClient },
): void {
  const owner = route({
    principals: ["owner_manager"],
    module: "core",
    action: "admin.payments",
    idempotency: "optional",
  });
  // Reads don't run the route's action check, so the owner's checklist says so itself.
  const ownerOnly = (request: { principal: unknown; venueId?: string | undefined }) => {
    const p = request.principal as {
      kind: string;
      memberships?: readonly { venueId: string; role: string }[];
    };
    const role =
      p.kind === "user"
        ? p.memberships?.find((m) => m.venueId === request.venueId)?.role
        : undefined;
    if (role !== "owner") throw new ApiError("forbidden", "the go-live checklist is the owner's");
  };
  app.get("/v1/venues/:venueId/go-live", { config: owner }, async (request) => {
    ownerOnly(request);
    // Stripe's answer is read outside any transaction; a quiet Stripe leaves the last one we had.
    await refreshMerchantCategory(
      { pool: options.pool, stripe: options.stripe() },
      request.venueId!,
    ).catch(() => undefined);
    return request.inVenue((c) => goLive(c, request.venueId!));
  });
  app.put<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/go-live/merchant-category",
    { config: owner },
    async (request) => {
      const parsed = expectedBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { expected: a 4-digit code or null }");
      return request.inVenue(async (c) => {
        await setExpectedCategory(c, request.venueId!, parsed.data.expected);
        return goLive(c, request.venueId!);
      });
    },
  );
  app.post<{ Params: { venueId: string; userId: string }; Body: unknown }>(
    "/v1/venues/:venueId/go-live/people/:userId",
    { config: owner },
    async (request) => {
      if (!uuid.safeParse(request.params.userId).success)
        throw new ApiError("not_found", "no such owner or manager here");
      const parsed = personBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { check, confirmed }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "confirming is the owner's");
      return request.inVenue(async (c) => {
        await confirmPerson(c, request.venueId!, {
          userId: request.params.userId,
          check: parsed.data.check,
          confirmed: parsed.data.confirmed,
          by: p.userId,
          at: options.clock.now().toString(),
        });
        return goLive(c, request.venueId!);
      });
    },
  );
}
