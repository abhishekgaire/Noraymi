import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  approvalById,
  approvalPeople,
  approvalsFor,
  type ApprovalRow,
  type Queryable,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { approvalsMode, approverFor, decide } from "../approvals/service.js";
import type pg from "pg";
import { latestAttempt } from "@west4/db";
import { chargeNow } from "../payments/card-on-file.js";
import { claimAndRun } from "../payments/run.js";
import { REFUND_RUN_KIND, runRefund } from "../payments/refunds.js";
import type { StripeClient } from "../stripe/client.js";
import type { ReceiptDeps } from "../receipts/send.js";

/**
 * Approvals (M2-15; spec 08 · Approvals):
 *   GET  /v1/venues/{v}/approvals?status=pending   what waits for me, and what I asked for
 *   GET  /v1/venues/{v}/approvals/approver         who a request from me would wait for now (M4-22)
 *   GET  /v1/venues/{v}/approvals/{a}
 *   POST /v1/venues/{v}/approvals/{a}/decide       { decision: approve | decline } from the approver's own phone
 *   POST /v1/venues/{v}/approvals/{a}/pin          { user_id, pin, decision }: a manager's PIN at the register (D124)
 */
const body = z.object({ decision: z.enum(["approve", "decline"]) }).strict();
const pinBody = z
  .object({
    user_id: z.string().uuid(),
    pin: z.string().regex(/^\d{4,8}$/),
    decision: z.enum(["approve", "decline"]),
  })
  .strict();

export function approvalRoutes(
  app: FastifyInstance,
  options: {
    clock: Clock;
    pool?: pg.Pool;
    stripe?: () => StripeClient;
    payAppUrl?: string | null;
    texts?: { allowList: readonly string[] | null };
    receipts?: ReceiptDeps;
  },
): void {
  const read = route({ principals: ["owner_manager", "staff"], module: "core" });
  const userOf = (p: { kind: string; userId?: string }) => {
    if (p.kind !== "user" || !p.userId) throw new ApiError("forbidden", "approvals are a person's");
    return p.userId;
  };

  /**
   * After a decision has committed: an approved card on file (M4-17) charges now and an approved
   * refund goes to Stripe now (M4-21); the worker runs the same jobs if this process can't.
   */
  const afterDecision = async (
    a: ApprovalRow,
    venueId: string,
    inVenue: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T>,
  ) => {
    // An approved card on file (M4-17) charges now, after the decision has committed; the worker
    // runs the same job if this process can't.
    if (a.kind === "card_on_file" && a.status === "approved" && options.pool && options.stripe) {
      const deps = {
        pool: options.pool,
        stripe: options.stripe(),
        clock: options.clock,
        payAppUrl: options.payAppUrl ?? null,
        texts: options.texts ?? { allowList: null },
        ...(options.receipts ? { receipts: options.receipts } : {}),
      };
      const attempt = await inVenue((c) => latestAttempt(c, venueId, a.target_id));
      if (attempt) await chargeNow(deps, venueId, a.target_id, attempt.attempt_no);
    }
    // An approved refund goes to Stripe now, after the decision has committed (M4-21).
    if (a.kind === "refund" && a.status === "approved" && options.pool && options.stripe) {
      const deps = { pool: options.pool, stripe: options.stripe(), clock: options.clock };
      const ids = ((a.payload as { refund_ids?: string[] }).refund_ids ?? []).filter(Boolean);
      for (const id of ids)
        await claimAndRun(deps, venueId, `${REFUND_RUN_KIND}:${id}`, () =>
          runRefund(deps, venueId, id),
        );
    }
  };

  // Who my request would wait for now, so the button can name them: "[Send to Abhishek]" (M4-22).
  app.get<{ Params: { venueId: string } }>(
    "/v1/venues/:venueId/approvals/approver",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => {
      const userId = userOf(request.principal as never);
      const approver = await request.inVenue((c) =>
        approverFor(c, request.venueId!, userId, options.clock.now()),
      );
      if (!approver) throw new ApiError("not_found", "there's nobody to approve this");
      return approver;
    },
  );

  app.get<{ Params: { venueId: string }; Querystring: { status?: string } }>(
    "/v1/venues/:venueId/approvals",
    { config: read },
    async (request) => {
      const userId = userOf(request.principal as never);
      const status = request.query.status ?? null;
      if (status && !["pending", "approved", "declined", "expired"].includes(status))
        throw new ApiError("invalid_request", "unknown status");
      const { list, mode, people, onClock } = await request.inVenue(async (c) => ({
        list: await approvalsFor(c, request.venueId!, userId, status),
        mode: await approvalsMode(c, request.venueId!),
        people: await approvalPeople(c, request.venueId!),
        // U-08: who is on the clock now, so the register's dialog picks the manager who's here.
        onClock: new Set(
          (
            await c.query<{ user_id: string }>(
              `select m.user_id from shifts s join memberships m on m.venue_id = s.venue_id and m.id = s.membership_id
                where s.venue_id = $1 and s.ended_at is null`,
              [request.venueId!],
            )
          ).rows.map((r) => r.user_id),
        ),
      }));
      return {
        waiting_for_me: list.filter((a) => a.routed_to === userId),
        asked_by_me: list.filter((a) => a.requested_by === userId),
        // How this venue decides (D124), and who may type their PIN at the register.
        mode,
        approvers:
          mode === "pin"
            ? people
                .filter((p) => (p.role === "owner" || p.role === "manager") && p.id !== userId)
                .map((p) => ({ user_id: p.id, name: p.name, on_clock: onClock.has(p.id) }))
            : [],
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
      const answer = await request.inVenue(async (c) => {
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
      await afterDecision(answer.approval, request.venueId!, (fn) => request.inVenue(fn));
      return answer;
    },
  );

  // A manager's PIN at the register (D124): when the venue decides approvals this way, an owner or a
  // manager other than the requester types their PIN on the register that asked, with the PIN
  // sign-in's lockouts; the approver's phone can still decide it too.
  app.post<{ Params: { venueId: string; approvalId: string }; Body: unknown }>(
    "/v1/venues/:venueId/approvals/:approvalId/pin",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const parsed = pinBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          "send { user_id, pin, decision: 'approve' | 'decline' }",
        );
      userOf(request.principal as never);
      const venueId = request.venueId!;
      const deviceId = request.session?.deviceId ?? request.signedDevice?.deviceId;
      if (!deviceId) throw new ApiError("forbidden", "a manager's PIN is typed on a register");
      const approver = await request.inVenue(async (c) => {
        if ((await approvalsMode(c, venueId)) !== "pin")
          throw new ApiError("forbidden", "approvals here are decided on the manager's phone", {
            details: { reason: "approvals_by_phone" },
          });
        const m = await c.query<{ role: string }>(
          `select role from memberships where venue_id = $1 and user_id = $2 and status = 'active'`,
          [venueId, parsed.data.user_id],
        );
        return m.rows[0]?.role ?? null;
      });
      if (approver !== "owner" && approver !== "manager")
        throw new ApiError("forbidden", "only an owner or a manager approves");
      await request.server.checkPinOf(request, venueId, parsed.data.user_id, parsed.data.pin);
      const answer = await request.inVenue(async (c) => ({
        approval: await decide(c, venueId, request.params.approvalId, {
          decision: parsed.data.decision,
          userId: parsed.data.user_id,
          deviceId,
          at: options.clock.now(),
          via: "pin",
        }),
      }));
      await afterDecision(answer.approval, venueId, (fn) => request.inVenue(fn));
      return answer;
    },
  );
}
