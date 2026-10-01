import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { approvalById, approvalsFor } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { decide } from "../approvals/service.js";

/**
 * Approvals (M2-15; spec 08 · Approvals):
 *   GET  /v1/venues/{v}/approvals?status=pending   what waits for me, and what I asked for
 *   GET  /v1/venues/{v}/approvals/{a}
 *   POST /v1/venues/{v}/approvals/{a}/decide       { decision: approve | decline } from the approver's own phone
 */
const body = z.object({ decision: z.enum(["approve", "decline"]) }).strict();

export function approvalRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  const read = route({ principals: ["owner_manager", "staff"], module: "core" });
  const userOf = (p: { kind: string; userId?: string }) => {
    if (p.kind !== "user" || !p.userId) throw new ApiError("forbidden", "approvals are a person's");
    return p.userId;
  };

  app.get<{ Params: { venueId: string }; Querystring: { status?: string } }>(
    "/v1/venues/:venueId/approvals",
    { config: read },
    async (request) => {
      const userId = userOf(request.principal as never);
      const status = request.query.status ?? null;
      if (status && !["pending", "approved", "declined", "expired"].includes(status))
        throw new ApiError("invalid_request", "unknown status");
      const list = await request.inVenue((c) => approvalsFor(c, request.venueId!, userId, status));
      return {
        waiting_for_me: list.filter((a) => a.routed_to === userId),
        asked_by_me: list.filter((a) => a.requested_by === userId),
      };
    },
  );

  app.get<{ Params: { venueId: string; approvalId: string } }>(
    "/v1/venues/:venueId/approvals/:approvalId",
    { config: read },
    async (request) => {
      const userId = userOf(request.principal as never);
      const a = await request.inVenue((c) =>
        approvalById(c, request.venueId!, request.params.approvalId),
      );
      if (!a || (a.routed_to !== userId && a.requested_by !== userId))
        throw new ApiError("not_found", "no such approval");
      return { approval: a };
    },
  );

  app.post<{ Params: { venueId: string; approvalId: string }; Body: unknown }>(
    "/v1/venues/:venueId/approvals/:approvalId/decide",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "approvals.decide",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { decision: 'approve' | 'decline' }");
      const userId = userOf(request.principal as never);
      if (request.session?.assurance !== "passkey")
        throw new ApiError("forbidden", "approving needs a passkey session");
      // The approver's own phone: a request signed by a staff_phone device that belongs to them.
      const device = request.signedDevice;
      if (!device || device.kind !== "staff_phone" || device.venueId !== request.venueId)
        throw new ApiError("forbidden", "an approval is decided on your own phone");
      return request.inVenue(async (c) => {
        const owner = await c.query<{ user_id: string | null; revoked_at: string | null }>(
          "select user_id, revoked_at::text from devices where venue_id = $1 and id = $2",
          [request.venueId, device.deviceId],
        );
        if (owner.rows[0]?.user_id !== userId || owner.rows[0]?.revoked_at)
          throw new ApiError("forbidden", "an approval is decided on your own phone");
        return {
          approval: await decide(c, request.venueId!, request.params.approvalId, {
            decision: parsed.data.decision,
            userId,
            deviceId: device.deviceId,
            at: options.clock.now(),
          }),
        };
      });
    },
  );
}
