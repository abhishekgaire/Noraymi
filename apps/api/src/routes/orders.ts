import type { FastifyInstance, FastifyRequest } from "fastify";
import { listOrders, readSetting } from "@west4/db";
import { businessDate, ORDER_STATUSES } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { stepOrder, type StepInput } from "../orders/pipeline.js";
import { inVenueRefusing } from "../orders/alcohol.js";
import { DEFAULT_AGING } from "../orders/escalation.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Orders (M3-06; spec 08 · Orders):
 *   GET  /v1/venues/{v}/orders?status=ringing,held     the bar's Waiting list; ready,on_the_way is the Runs;
 *                                                      &business_date= keeps one night (the bar's Delivered tonight)
 *   POST /v1/venues/{v}/orders/{o}/accept | hold | ready | claim | deliver
 *   POST /v1/venues/{v}/orders/{o}/cancel   { for?: "guest" | "staff" }
 *   POST /v1/venues/{v}/orders/{o}/decline  { reason }                 the guest sees the reason
 *   POST /v1/venues/{v}/orders/{o}/return   { reason: no_id | too_drunk | nobody_there | other, note? }
 *   POST /v1/venues/{v}/orders/{o}/resolve  { resolution: void_not_made | void_made | remake }
 * A step from the wrong status answers 409 version_conflict with the order's status. A void over
 * the reason-only limit answers 202 approval_pending. Staff orders (`POST /checks/{c}/orders`) are M3-07.
 */
const who = (request: FastifyRequest) => {
  const p = request.principal;
  if (p.kind !== "user") throw new ApiError("forbidden", "this is a person's work");
  return {
    userId: p.userId,
    deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
  };
};

const BODIES = {
  accept: z.object({}).strict(),
  hold: z.object({}).strict(),
  ready: z.object({}).strict(),
  claim: z.object({}).strict(),
  deliver: z.object({}).strict(),
  cancel: z.object({ for: z.enum(["guest", "staff"]).optional() }).strict(),
  decline: z.object({ reason: z.string().max(200) }).strict(),
  return: z
    .object({
      reason: z.enum(["no_id", "too_drunk", "nobody_there", "other"]),
      note: z.string().max(300).nullable().optional(),
    })
    .strict(),
  resolve: z.object({ resolution: z.enum(["void_not_made", "void_made", "remake"]) }).strict(),
} as const;
type Step = keyof typeof BODIES;

/** Who may take each step: the bar's steps need orders.accept, a runner's need runs.carry. */
const ACTION: Record<Step, string> = {
  accept: "orders.accept",
  hold: "orders.accept",
  ready: "orders.accept",
  cancel: "orders.accept",
  decline: "orders.accept",
  resolve: "orders.accept",
  claim: "runs.carry",
  deliver: "runs.carry",
  return: "runs.carry",
};

export function orderRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{
    Params: { venueId: string };
    Querystring: { status?: string; session_id?: string; business_date?: string };
  }>(
    "/v1/venues/:venueId/orders",
    { config: route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" }) },
    async (request) => {
      const statuses = (request.query.status ?? "ringing,held").split(",").map((s) => s.trim());
      if (statuses.some((s) => !(ORDER_STATUSES as readonly string[]).includes(s)))
        throw new ApiError("invalid_request", `status is a list of ${ORDER_STATUSES.join(", ")}`);
      const sessionId = request.query.session_id;
      if (sessionId !== undefined && !z.string().uuid().safeParse(sessionId).success)
        throw new ApiError("invalid_request", "session_id must be an id");
      const date = request.query.business_date;
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new ApiError("invalid_request", "business_date is YYYY-MM-DD");
      return request.inVenue(async (c) => {
        const orders = await listOrders(c, request.venueId!, statuses, {
          sessionId,
          businessDate: date,
          training: request.training,
        });
        // The bar screens color and chime by the venue's aging, so a change in Admin → Bar POS shows at once (M6-25).
        const now = options.clock.now();
        const clock = await venueClock(c, request.venueId!);
        const today = businessDate(now, clock.timeZone, clock.dayCutover).businessDate;
        const pos = (await readSetting(c, request.venueId!, "pos", today))?.value;
        const a = pos?.orderAging ?? DEFAULT_AGING;
        return {
          orders,
          aging: {
            phones_sec: a.phonesSec,
            amber_sec: a.amberSec,
            pink_sec: a.pinkSec,
            call_sec: a.callSec,
            chime: pos?.chime ?? true,
            mute_sec: pos?.muteSec ?? 60,
          },
        };
      });
    },
  );

  for (const step of Object.keys(BODIES) as Step[]) {
    app.post<{ Params: { venueId: string; orderId: string }; Body: unknown }>(
      `/v1/venues/:venueId/orders/:orderId/${step}`,
      {
        config: route({
          principals: ["owner_manager", "staff"],
          module: "core",
          action: ACTION[step],
          idempotency: "optional",
        }),
      },
      async (request, reply) => {
        const parsed = BODIES[step].safeParse(request.body ?? {});
        if (!parsed.success)
          throw new ApiError(
            "invalid_request",
            parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          );
        if (!z.string().uuid().safeParse(request.params.orderId).success)
          throw new ApiError("not_found", "no such order");
        const me = who(request);
        const body = parsed.data as Record<string, unknown>;
        const input: StepInput = {
          userId: me.userId,
          deviceId: me.deviceId,
          now: options.clock.now(),
          ...(step === "decline" ? { reason: String(body["reason"] ?? "") } : {}),
          ...(step === "cancel" && body["for"]
            ? { cancelledFor: body["for"] as "guest" | "staff" }
            : {}),
          ...(step === "return"
            ? {
                returnedReason: body["reason"] as StepInput["returnedReason"],
                note: (body["note"] as string | null | undefined) ?? null,
              }
            : {}),
          ...(step === "resolve"
            ? { resolution: body["resolution"] as StepInput["resolution"] }
            : {}),
        };
        const answer = await inVenueRefusing(request, (c) =>
          stepOrder(c, request.venueId!, request.params.orderId, step, input),
        );
        return answer.status === "done" ? answer : reply.code(202).send(answer);
      },
    );
  }
}
