import type { FastifyInstance, FastifyRequest } from "fastify";
import { draftFor, emitEvent, saveDraft } from "@west4/db";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type pg from "pg";
import { sendRound, type SendAnswer } from "../tabs/hold.js";
import { runNow } from "../payments/run.js";
import type { StripeClient } from "../stripe/client.js";
import { inVenueRefusing } from "../orders/alcohol.js";

/**
 * Staff orders and unsent drinks (M3-07; spec 08 · Orders, Bar POS):
 *   POST /v1/venues/{v}/checks/{c}/orders   { client_order_id?, lines: [{ variant_id, qty, option_ids?, notes? }] }
 *        a staff order, accepted as it's placed: 201 with the order
 *   GET  /v1/venues/{v}/drafts/{key}        the caller's unsent drinks for a tab (a check id) or "quick"
 *   PUT  /v1/venues/{v}/drafts/{key}        { lines, version }: 409 version_conflict when another screen saved first
 * A save sends draft.updated to the person alone, so their other screens follow.
 */
const id = z.string().uuid();
const line = z
  .object({
    variant_id: id,
    qty: z.number().int().min(1).max(99),
    option_ids: z.array(id).max(10).optional(),
    notes: z.string().max(200).nullable().optional(),
  })
  .strict();
const orderBody = z
  .object({
    client_order_id: z.string().min(8).max(64).optional(),
    lines: z.array(line).min(1).max(50),
  })
  .strict();
const draftBody = z
  .object({ lines: z.array(line).max(50), version: z.number().int().min(0) })
  .strict();

const person = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
  const m = p.memberships.find((x) => x.venueId === request.venueId);
  if (!m) throw new ApiError("forbidden", "not a member of this venue");
  return {
    userId: p.userId,
    membershipId: m.membershipId,
    deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
  };
};

/** "quick" is the quick sale's draft; anything else must be a check id. */
const checkOf = (key: string) => {
  if (key === "quick") return null;
  if (!id.safeParse(key).success)
    throw new ApiError("not_found", "a draft's key is a check id or quick");
  return key;
};

export function draftRoutes(
  app: FastifyInstance,
  options: { clock: Clock; pool: pg.Pool; stripe: () => StripeClient },
): void {
  app.post<{ Params: { venueId: string; checkId: string }; Body: unknown }>(
    "/v1/venues/:venueId/checks/:checkId/orders",
    {
      config: route({
        principals: ["owner_manager", "staff"],
        module: "core",
        action: "orders.accept",
        idempotency: "optional",
      }),
    },
    async (request, reply) => {
      const parsed = orderBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      if (!id.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such check");
      const me = person(request);
      const venueId = request.venueId!;
      const input = {
        checkId: request.params.checkId,
        lines: parsed.data.lines,
        clientOrderId: parsed.data.client_order_id ?? null,
        ...me,
      };
      // A round on a tab with a hold (M6-07): the hold grows first when the round would pass it.
      let answer: SendAnswer = await inVenueRefusing(request, (c) =>
        sendRound(c, venueId, { ...input, now: options.clock.now() }),
      );
      if (answer.kind === "raise") {
        const deps = { pool: options.pool, stripe: options.stripe(), clock: options.clock };
        await runNow(deps, venueId, answer.paymentId, answer.attemptNo);
        answer = await inVenueRefusing(request, (c) =>
          sendRound(c, venueId, { ...input, now: options.clock.now(), raised: true }),
        );
      }
      if (answer.kind === "approval") return reply.code(202).send(answer.pending);
      if (answer.kind === "checking" || answer.kind === "raise")
        throw new ApiError("payment_unknown", "Checking with Stripe · don't retry", {
          details: { reason: "hold_checking", payment_id: answer.paymentId },
        });
      return reply.code(201).send({ order: answer.order });
    },
  );

  const draftRoute = route({
    principals: ["owner_manager", "staff"],
    module: "core",
    action: "orders.accept",
    idempotency: "optional",
  });

  app.get<{ Params: { venueId: string; draftKey: string } }>(
    "/v1/venues/:venueId/drafts/:draftKey",
    { config: route({ principals: ["owner_manager", "staff"], module: "core" }) },
    async (request) => {
      const checkId = checkOf(request.params.draftKey);
      const me = person(request);
      const d = await request.inVenue(async (c) => {
        if (checkId) {
          const k = await c.query("select 1 from checks where venue_id = $1 and id = $2", [
            request.venueId,
            checkId,
          ]);
          if (k.rowCount === 0) throw new ApiError("not_found", "no such check");
        }
        return draftFor(c, request.venueId!, me.membershipId, checkId);
      });
      return {
        key: request.params.draftKey,
        lines: d?.lines ?? [],
        version: d?.version ?? 0,
        updated_at: d?.updated_at ?? null,
      };
    },
  );

  app.put<{ Params: { venueId: string; draftKey: string }; Body: unknown }>(
    "/v1/venues/:venueId/drafts/:draftKey",
    { config: draftRoute },
    async (request) => {
      const parsed = draftBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { lines, version }");
      const checkId = checkOf(request.params.draftKey);
      const me = person(request);
      const venueId = request.venueId!;
      return request.inVenue(async (c) => {
        if (checkId) {
          const k = await c.query("select 1 from checks where venue_id = $1 and id = $2", [
            venueId,
            checkId,
          ]);
          if (k.rowCount === 0) throw new ApiError("not_found", "no such check");
        }
        const version = await saveDraft(c, venueId, {
          membershipId: me.membershipId,
          checkId,
          deviceId: me.deviceId,
          lines: parsed.data.lines,
          version: parsed.data.version,
          at: options.clock.now().toString(),
        });
        if (version === null) {
          const now = await draftFor(c, venueId, me.membershipId, checkId);
          throw new ApiError("version_conflict", "another screen saved these drinks first", {
            details: { lines: now?.lines ?? [], version: now?.version ?? 0 },
          });
        }
        await emitEvent(c, {
          venueId,
          type: "draft.updated",
          entityId: request.params.draftKey,
          entityVersion: version,
          audience: "user",
          userId: me.userId,
        });
        return { key: request.params.draftKey, lines: parsed.data.lines, version };
      });
    },
  );
}
