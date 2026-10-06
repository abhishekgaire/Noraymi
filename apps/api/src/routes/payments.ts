import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { latestAttempt, paymentById, readerByStripeId, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import type { StripeClient } from "../stripe/client.js";
import "../payments/webhooks.js";
import { fixChange, takeCash } from "../payments/cash.js";
import { declinedOnTab, startTabPayment } from "../tabs/pay.js";
import { screenState, type Applied } from "../payments/machine.js";
import {
  NoSuchReader,
  ReaderQuiet,
  cancelPayment,
  cancelReplacedHold,
  checkNow,
  runNow,
  writeRetap,
  writeTap,
  type PaymentDeps,
} from "../payments/run.js";
import { askGuest, askManager, savedCardFor } from "../payments/card-on-file.js";

/**
 * Payments (M4-05; spec 08 · Payments; Payment flows · What staff see):
 *   POST /v1/venues/{v}/checks/{c}/payments        { method: "tap", amount_cents, reader_id, share_id? }
 *   POST /v1/venues/{v}/payments/{p}/tap           { reader_id }: tap again after a decline, as attempt n + 1
 *   GET  /v1/venues/{v}/payments/{p}
 *   POST /v1/venues/{v}/payments/{p}/check-status  read Stripe now, through the same state machine
 *   POST /v1/venues/{v}/payments/{p}/cancel
 * Money routes need an Idempotency-Key. A tap that can't be known yet answers
 * 202 payment_unknown ("Checking with Stripe · don't retry"); a reader that's
 * offline 503 reader_offline, one that's busy 409 reader_busy. Cash came with
 * M4-13. Card on file (M4-17): `{ method: "card_on_file", amount_cents }` waits
 * for the guest; `POST /payments/{p}/approval { reason }` asks a manager
 * instead (202 approval_pending).
 */
const tapBody = z
  .object({
    method: z.literal("tap"),
    amount_cents: z.number().int().positive(),
    reader_id: z.string().uuid(),
    share_id: z.string().uuid().nullable().optional(),
    /** "Additional tip (optional)", entered before the tap: added to what the reader charges (M4-11). */
    tip_cents: z.number().int().min(0).optional(),
  })
  .strict();
/** Cash (M4-13): the amount, what was handed over, and any cash tip. */
const cashBody = z
  .object({
    method: z.literal("cash"),
    amount_cents: z.number().int().positive(),
    tendered_cents: z.number().int().positive(),
    tip_cents: z.number().int().min(0).optional(),
    share_id: z.string().uuid().nullable().optional(),
  })
  .strict();
/** Card on file (M4-17): staff ask, and the payment waits for the guest's OK or a manager's. */
const onFileBody = z
  .object({
    method: z.literal("card_on_file"),
    amount_cents: z.number().int().positive(),
    /** The guest has left: ask a manager at once, with this reason (202 approval_pending). */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const approvalBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const changeBody = z.object({ tendered_cents: z.number().int().positive() }).strict();
const retapBody = z.object({ reader_id: z.string().uuid() }).strict();
const uuid = z.string().uuid();

export function paymentView(
  a: Pick<Applied, "payment" | "attempt"> & {
    reader?: { id: string; label: string; station: string } | null;
    on_file?: { brand: string; last4: string; guest_name: string | null } | null;
    approval?: { id: string; status: string; waiting_for: string } | null;
  },
) {
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
    reader: a.reader ?? null,
    ...(payment.method === "card_on_file"
      ? { on_file: a.on_file ?? null, approval: a.approval ?? null }
      : {}),
  };
}

/** A card-on-file payment's card and guest ("Waiting for Marcus"), and its manager's approval if asked. */
async function onFileDetails(c: Queryable, venueId: string, paymentId: string) {
  const check = (
    await c.query<{ check_id: string }>(
      "select check_id from payment_allocations where venue_id = $1 and payment_id = $2 limit 1",
      [venueId, paymentId],
    )
  ).rows[0];
  const card = check ? await savedCardFor(c, venueId, check.check_id) : null;
  const approval = (
    await c.query<{ id: string; status: string; waiting_for: string }>(
      `select a.id, a.status, u.name as waiting_for from approvals a join users u on u.id = a.routed_to
        where a.venue_id = $1 and a.kind = 'card_on_file' and a.target_id = $2
        order by a.requested_at desc limit 1`,
      [venueId, paymentId],
    )
  ).rows[0];
  return {
    on_file: card
      ? { brand: card.brand, last4: card.last4, guest_name: card.guest_first_name }
      : null,
    approval: approval ?? null,
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
  options: {
    pool: pg.Pool;
    clock: Clock;
    stripe: () => StripeClient;
    payAppUrl?: string | null;
    texts?: { allowList: readonly string[] | null };
  },
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
      if (!payment) return null;
      const attempt = await latestAttempt(c, venueId, paymentId);
      return {
        payment,
        attempt,
        reader: attempt?.reader_id ? await readerByStripeId(c, venueId, attempt.reader_id) : null,
        ...(payment.method === "card_on_file" ? await onFileDetails(c, venueId, paymentId) : {}),
      };
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
      if (!uuid.safeParse(request.params.checkId).success)
        throw new ApiError("not_found", "no such check");
      const venueId = request.venueId!;
      const cash = cashBody.safeParse(request.body);
      if (cash.success) {
        const p = request.principal;
        if (p.kind !== "user") throw new ApiError("forbidden", "taking cash is a person's work");
        const deviceId = request.signedDevice?.deviceId ?? request.session?.deviceId ?? null;
        const taken = await request.inVenue(async (c) => {
          const check = await c.query<{ status: string }>(
            "select status from checks where venue_id = $1 and id = $2",
            [venueId, request.params.checkId],
          );
          if (!check.rows[0]) throw new ApiError("not_found", "no such check");
          if (["paid", "void"].includes(check.rows[0].status))
            throw new ApiError("invalid_request", `this check is ${check.rows[0].status}`);
          return takeCash(c, venueId, {
            checkId: request.params.checkId,
            amountCents: cash.data.amount_cents,
            tenderedCents: cash.data.tendered_cents,
            tipCents: cash.data.tip_cents ?? 0,
            shareId: cash.data.share_id ?? null,
            userId: p.userId,
            deviceId,
            businessDate: await night(c, venueId),
            now: options.clock.now(),
          });
        });
        reply.code(201);
        return {
          ...paymentView(await current(request, taken.paymentId)),
          change_cents: taken.changeCents,
          logged_to: taken.loggedTo,
          check_status: taken.settled.status,
          room: taken.settled.room,
        };
      }
      const onFile = onFileBody.safeParse(request.body);
      if (onFile.success) {
        const asked = await request.inVenue(async (c) => {
          const check = await c.query<{ status: string }>(
            "select status from checks where venue_id = $1 and id = $2",
            [venueId, request.params.checkId],
          );
          if (!check.rows[0]) throw new ApiError("not_found", "no such check");
          if (["paid", "void"].includes(check.rows[0].status))
            throw new ApiError("invalid_request", `this check is ${check.rows[0].status}`);
          const made = await askGuest(c, venueId, {
            checkId: request.params.checkId,
            amountCents: onFile.data.amount_cents,
            businessDate: await night(c, venueId),
          });
          const p = request.principal;
          const pending =
            onFile.data.reason && p.kind === "user"
              ? await askManager(c, venueId, {
                  paymentId: made.paymentId,
                  reason: onFile.data.reason,
                  userId: p.userId,
                  deviceId: request.signedDevice?.deviceId ?? request.session?.deviceId ?? null,
                  now: options.clock.now(),
                })
              : null;
          return { ...made, pending };
        });
        if (asked.pending)
          return reply.code(202).send({ ...asked.pending, payment_id: asked.paymentId });
        reply.code(201);
        return paymentView(await current(request, asked.paymentId));
      }
      const parsed = tapBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          'send { method: "tap", "cash" or "card_on_file", amount_cents, … }',
        );
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
            tipCents: parsed.data.tip_cents ?? 0,
            businessDate: await night(c, venueId),
            now: options.clock.now(),
          });
        });
      } catch (e) {
        if (e instanceof NoSuchReader) throw new ApiError("not_found", "no such reader");
        if (e instanceof ReaderQuiet)
          throw new ApiError(
            "reader_offline",
            "the reader is offline: use the other reader, or take cash",
            {
              details: { reader_id: parsed.data.reader_id },
            },
          );
        throw e;
      }
      await runNow(deps(), venueId, written.paymentId, written.attemptNo);
      const view = paymentView(await current(request, written.paymentId));
      reply.code(201);
      return answer(view);
    },
  );

  // Pay a tab another way (M6-11): another card (the tip on the reader) or cash, for the tab's balance.
  // The hold is canceled only once this payment has succeeded; a declined card leaves it standing.
  const tabPay = route({
    principals: ["owner_manager", "staff"],
    module: "bar_tabs",
    action: "payments.take",
    idempotency: "required",
  });
  const tabTapBody = tapBody.omit({ share_id: true, tip_cents: true }).strict();
  const tabCashBody = cashBody.omit({ share_id: true }).strict();
  app.post<{ Params: { venueId: string; t: string }; Body: unknown }>(
    "/v1/venues/:venueId/tabs/:t/pay",
    { config: tabPay },
    async (request, reply) => {
      if (!uuid.safeParse(request.params.t).success) throw new ApiError("not_found", "no such tab");
      const tabId = request.params.t;
      const venueId = request.venueId!;
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "taking payment is a person's work");
      const cash = tabCashBody.safeParse(request.body);
      const tap = cash.success ? null : tabTapBody.safeParse(request.body);
      if (!cash.success && !tap?.success)
        throw new ApiError(
          "invalid_request",
          'send { method: "tap", amount_cents, reader_id } or { method: "cash", amount_cents, tendered_cents, tip_cents? }',
        );
      // A new card that was declined is set aside first (outside any transaction): nothing was charged.
      const declined = await request.inVenue((c) => declinedOnTab(c, venueId, tabId));
      for (const id of declined) await cancelPayment(deps(), venueId, id, "api");
      const now = options.clock.now();
      if (cash.success) {
        const deviceId = request.signedDevice?.deviceId ?? request.session?.deviceId ?? null;
        const taken = await request.inVenue(async (c) => {
          const started = await startTabPayment(c, venueId, tabId, {
            userId: p.userId,
            amountCents: cash.data.amount_cents,
            now,
          });
          return takeCash(c, venueId, {
            checkId: started.checkId,
            amountCents: started.balanceCents,
            tenderedCents: cash.data.tendered_cents,
            tipCents: cash.data.tip_cents ?? 0,
            leaveOut: started.holdId,
            userId: p.userId,
            deviceId,
            businessDate: await night(c, venueId),
            now,
          });
        });
        // The cash has replaced the hold: cancel it now (the job written with the cash, and the
        // reconciler, are there if this doesn't get through).
        if (taken.replaced?.holdId)
          await cancelReplacedHold(deps(), venueId, taken.replaced.holdId, "api").catch(
            () => undefined,
          );
        reply.code(201);
        return {
          ...paymentView(await current(request, taken.paymentId)),
          change_cents: taken.changeCents,
          logged_to: taken.loggedTo,
          check_status: taken.settled.status,
          tab_state: taken.replaced ? "closed" : "open",
        };
      }
      let written;
      try {
        written = await request.inVenue(async (c) => {
          const started = await startTabPayment(c, venueId, tabId, {
            userId: p.userId,
            amountCents: tap!.data!.amount_cents,
            now,
          });
          return writeTap(c, venueId, {
            checkId: started.checkId,
            amountCents: started.balanceCents,
            readerDeviceId: tap!.data!.reader_id,
            leaveOut: started.holdId,
            businessDate: await night(c, venueId),
            now,
          });
        });
      } catch (e) {
        if (e instanceof NoSuchReader) throw new ApiError("not_found", "no such reader");
        if (e instanceof ReaderQuiet)
          throw new ApiError(
            "reader_offline",
            "the reader is offline: use the other reader, or take cash",
            {
              details: { reader_id: tap!.data!.reader_id },
            },
          );
        throw e;
      }
      await runNow(deps(), venueId, written.paymentId, written.attemptNo);
      const view = paymentView(await current(request, written.paymentId));
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
      await runNow(deps(), venueId, paymentId, attemptNo);
      return answer(paymentView(await current(request, paymentId)));
    },
  );

  // "Wrong amount? Fix the change" (M4-13): the cash payment stays; the corrected figures are recorded.
  app.post<{ Params: { venueId: string; paymentId: string }; Body: unknown }>(
    "/v1/venues/:venueId/payments/:paymentId/change",
    { config: take },
    async (request) => {
      const paymentId = paymentParam(request);
      const parsed = changeBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { tendered_cents }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "a person fixes the change");
      const fixed = await request.inVenue((c) =>
        fixChange(c, request.venueId!, {
          paymentId,
          tenderedCents: parsed.data.tendered_cents,
          userId: p.userId,
          at: options.clock.now().toString(),
        }),
      );
      return { change_cents: fixed.changeCents };
    },
  );

  // "Ask a manager to approve" (M4-17): the guest has left; the charge runs when the manager approves.
  app.post<{ Params: { venueId: string; paymentId: string }; Body: unknown }>(
    "/v1/venues/:venueId/payments/:paymentId/approval",
    { config: take },
    async (request, reply) => {
      const paymentId = paymentParam(request);
      const parsed = approvalBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { reason }");
      const p = request.principal;
      if (p.kind !== "user")
        throw new ApiError("forbidden", "asking for an approval is a person's");
      const deviceId = request.signedDevice?.deviceId ?? request.session?.deviceId ?? null;
      const pending = await request.inVenue((c) =>
        askManager(c, request.venueId!, {
          paymentId,
          reason: parsed.data.reason,
          userId: p.userId,
          deviceId,
          now: options.clock.now(),
        }),
      );
      return reply.code(202).send(pending);
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
      await checkNow(deps(), request.venueId!, paymentId, "api");
      return paymentView(await current(request, paymentId));
    },
  );

  app.post<{ Params: { venueId: string; paymentId: string } }>(
    "/v1/venues/:venueId/payments/:paymentId/cancel",
    { config: take },
    async (request) => {
      const paymentId = paymentParam(request);
      await current(request, paymentId);
      await cancelPayment(deps(), request.venueId!, paymentId, "api");
      return paymentView(await current(request, paymentId));
    },
  );
}
