import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { latestAttempt, paymentById, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import "../payments/webhooks.js";
import { screenState, type Applied } from "../payments/machine.js";
import {
  NoSuchReader,
  cancelPayment,
  checkNow,
  runNow,
  writeRetap,
  writeTap,
  type PaymentDeps,
} from "../payments/run.js";

/**
 * Payments (M4-05; spec 08 · Payments; Payment flows · What staff see):
 *   POST /v1/venues/{v}/checks/{c}/payments        { method: "tap", amount_cents, reader_id, share_id? }
 *   POST /v1/venues/{v}/payments/{p}/tap           { reader_id }: tap again after a decline, as attempt n + 1
 *   GET  /v1/venues/{v}/payments/{p}
 *   POST /v1/venues/{v}/payments/{p}/check-status  read Stripe now, through the same state machine
 *   POST /v1/venues/{v}/payments/{p}/cancel
 * Money routes need an Idempotency-Key. A tap that can't be known yet answers
 * 202 payment_unknown ("Checking with Stripe · don't retry"); a reader that's
 * offline 503 reader_offline, one that's busy 409 reader_busy. Cash and card
 * on file come with M4-13 and M4-17.
 */
const tapBody = z
  .object({
    method: z.literal("tap"),
    amount_cents: z.number().int().positive(),
    reader_id: z.string().uuid(),
    share_id: z.string().uuid().nullable().optional(),
  })
  .strict();
const retapBody = z.object({ reader_id: z.string().uuid() }).strict();
const uuid = z.string().uuid();

export function paymentView(a: Pick<Applied, "payment" | "attempt">) {
  const { payment, attempt } = a;
  return {
    id: payment.id,
    method: payment.method,
    status: payment.status,
    state: screenState(payment, attempt),
    amount_cents: payment.amount_cents,
    tip_cents: payment.tip_cents,
    card_brand: payment.card_brand,
    card_last4: payment.card_last4,
    attempt: attempt
      ? {
          no: attempt.attempt_no,
          state: attempt.state,
          decline_code: attempt.decline_code,
          amount_cents: attempt.amount_cents,
          check_id: attempt.check_id,
        }
      : null,
  };
}

/** The answer for a run: Stripe's refusals as the spec's codes, unknown as 202. */
function answer(view: ReturnType<typeof paymentView>) {
  const code = view.attempt?.state === "failed" ? view.attempt.decline_code : null;
  if (code === "terminal_reader_offline")
    throw new ApiError(
      "reader_offline",
      "the reader is offline: use the other reader, or take cash",
      { details: { payment: view } },
    );
  if (code === "terminal_reader_busy")
    throw new ApiError("reader_busy", "another payment is on that reader", {
      details: { payment: view },
    });
  if (view.state === "unknown")
    throw new ApiError("payment_unknown", "Checking with Stripe · don't retry", {
      details: { payment: view },
    });
  return view;
}

export function paymentRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; stripe: () => StripeClient },
): void {
  const deps = (): PaymentDeps => ({
    pool: options.pool,
    stripe: options.stripe(),
    clock: options.clock,
  });
  const take = route({
    principals: ["owner_manager", "staff", "shared_device"],
    module: "core",
    action: "payments.take",
    idempotency: "required",
  });
  const read = route({ principals: ["owner_manager", "staff", "shared_device"], module: "core" });

  const night = async (c: Queryable, venueId: string) => {
    const v = (
      await c.query<{ time_zone: string; day_cutover: string }>(
        "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
        [venueId],
      )
    ).rows[0]!;
    return businessDate(options.clock.now(), v.time_zone, v.day_cutover).businessDate.toString();
  };
  const current = async (request: FastifyRequest, paymentId: string) => {
    const venueId = request.venueId!;
    const found = await request.inVenue(async (c) => {
      const payment = await paymentById(c, venueId, paymentId);
      return payment ? { payment, attempt: await latestAttempt(c, venueId, paymentId) } : null;
    });
    if (!found) throw new ApiError("not_found", "no such payment");
    return found;
  };
  const paymentParam = (request: FastifyRequest<{ Params: { paymentId: string } }>) => {
    if (!uuid.safeParse(request.params.paymentId).success)
      throw new ApiError("not_found", "no such payment");
    return request.params.paymentId;
  };

  app.post<{ Params: { venueId: string; checkId: string }; Body: unknown }>(
    "/v1/venues/:venueId/checks/:checkId/payments",
    { config: take },
    async (request, reply) => {
      const parsed = tapBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", 'send { method: "tap", amount_cents, reader_id }');
      if (!uuid.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such check");
      const venueId = request.venueId!;
      let written;
      try {
        written = await request.inVenue(async (c) => {
          const check = await c.query<{ status: string }>(
            "select status from checks where venue_id = $1 and id = $2",
            [venueId, request.params.checkId],
          );
          if (!check.rows[0]) throw new ApiError("not_found", "no such check");
          if (["paid", "void"].includes(check.rows[0].status))
            throw new ApiError("invalid_request", `this check is ${check.rows[0].status}`);
          return writeTap(c, venueId, {
            checkId: request.params.checkId,
            amountCents: parsed.data.amount_cents,
            readerDeviceId: parsed.data.reader_id,
            shareId: parsed.data.share_id ?? null,
            businessDate: await night(c, venueId),
            now: options.clock.now(),
          });
        });
      } catch (e) {
        if (e instanceof NoSuchReader) throw new ApiError("not_found", "no such reader");
        throw e;
      }
      const ran = await runNow(deps(), venueId, written.paymentId, written.attemptNo);
      const view = paymentView(ran ?? (await current(request, written.paymentId)));
      reply.code(201);
      return answer(view);
    },
  );

  app.post<{ Params: { venueId: string; paymentId: string }; Body: unknown }>(
    "/v1/venues/:venueId/payments/:paymentId/tap",
    { config: take },
    async (request) => {
      const paymentId = paymentParam(request);
      const parsed = retapBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { reader_id }");
      const venueId = request.venueId!;
      let attemptNo: number;
      try {
        ({ attemptNo } = await request.inVenue((c) =>
          writeRetap(c, venueId, {
            paymentId,
            readerDeviceId: parsed.data.reader_id,
            now: options.clock.now(),
          }),
        ));
      } catch (e) {
        if (e instanceof NoSuchReader) throw new ApiError("not_found", "no such reader");
        if (e instanceof Error && e.name === "Error")
          throw new ApiError("invalid_request", e.message);
        throw e;
      }
      const ran = await runNow(deps(), venueId, paymentId, attemptNo);
      return answer(paymentView(ran ?? (await current(request, paymentId))));
    },
  );

  app.get<{ Params: { venueId: string; paymentId: string } }>(
    "/v1/venues/:venueId/payments/:paymentId",
    { config: read },
    async (request) => paymentView(await current(request, paymentParam(request))),
  );

  app.post<{ Params: { venueId: string; paymentId: string } }>(
    "/v1/venues/:venueId/payments/:paymentId/check-status",
    {
      config: route({
        principals: ["owner_manager", "staff", "shared_device"],
        module: "core",
        idempotency: "optional",
      }),
    },
    async (request) => {
      const paymentId = paymentParam(request);
      await current(request, paymentId);
      const applied = await checkNow(deps(), request.venueId!, paymentId, "api");
      return paymentView(applied ?? (await current(request, paymentId)));
    },
  );

  app.post<{ Params: { venueId: string; paymentId: string } }>(
    "/v1/venues/:venueId/payments/:paymentId/cancel",
    { config: take },
    async (request) => {
      const paymentId = paymentParam(request);
      await current(request, paymentId);
      const applied = await cancelPayment(deps(), request.venueId!, paymentId, "api");
      return paymentView(applied ?? (await current(request, paymentId)));
    },
  );
}
