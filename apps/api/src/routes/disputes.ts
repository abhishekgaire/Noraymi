import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { disputeInbox, setDisputeNote, submitDispute } from "../payments/disputes.js";
import type { S3Settings } from "../s3.js";
import type { StripeClient } from "../stripe/client.js";

/**
 * Disputes (M4-24; spec 08 · Payments; screens N37), for owners and managers in a passkey session:
 *   GET  /v1/venues/{v}/disputes                 the inbox: deadlines, evidence gathered, funds moves
 *   POST /v1/venues/{v}/disputes/{d}/evidence    { note }: adds or replaces staff's note
 *   POST /v1/venues/{v}/disputes/{d}/submit      sends the evidence to Stripe before the deadline
 */
const uuid = z.string().uuid();
const noteBody = z.object({ note: z.string().trim().min(1).max(5000) }).strict();

export function disputeRoutes(
  app: FastifyInstance,
  options: {
    pool: pg.Pool;
    clock: Clock;
    stripe: () => StripeClient;
    s3?: () => S3Settings;
  },
): void {
  const owners = (request: FastifyRequest) => {
    const p = request.principal;
    const role =
      p.kind === "user"
        ? p.memberships.find((m) => m.venueId === request.venueId)?.role
        : undefined;
    if (role !== "owner" && role !== "manager")
      throw new ApiError("forbidden", "disputes are for owners and managers");
    if (p.kind !== "user" || p.session !== "passkey")
      throw new ApiError("forbidden", "disputes need a passkey session");
    return p.userId;
  };
  const read = route({ principals: ["owner_manager"], module: "core" });
  const write = route({ principals: ["owner_manager"], module: "core", idempotency: "optional" });
  const param = (id: string) => {
    if (!uuid.safeParse(id).success) throw new ApiError("not_found", "no such dispute");
    return id;
  };

  app.get("/v1/venues/:venueId/disputes", { config: read }, async (request) => {
    owners(request);
    return { disputes: await request.inVenue((c) => disputeInbox(c, request.venueId!)) };
  });

  app.post<{ Params: { venueId: string; disputeId: string }; Body: unknown }>(
    "/v1/venues/:venueId/disputes/:disputeId/evidence",
    { config: write },
    async (request) => {
      owners(request);
      const id = param(request.params.disputeId);
      const parsed = noteBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { note }");
      await request.inVenue((c) => setDisputeNote(c, request.venueId!, id, parsed.data.note));
      return { saved: true };
    },
  );

  app.post<{ Params: { venueId: string; disputeId: string } }>(
    "/v1/venues/:venueId/disputes/:disputeId/submit",
    { config: write },
    async (request) => {
      const userId = owners(request);
      const id = param(request.params.disputeId);
      return submitDispute(
        {
          pool: options.pool,
          stripe: options.stripe(),
          clock: options.clock,
          ...(options.s3 ? { s3: options.s3 } : {}),
        },
        request.venueId!,
        id,
        userId,
      );
    },
  );
}
