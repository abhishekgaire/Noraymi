import type { FastifyInstance, FastifyRequest } from "fastify";
import { emitEvent } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal, type Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { inVenueRefusing } from "../orders/alcohol.js";
import {
  reasonOf,
  recordFailed,
  replayedBefore,
  replayRound,
  type QueuedRound,
  type ReplayAnswer,
} from "../orders/replay.js";
import { takeCash } from "../payments/cash.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * Replay and Review after outage (M8-05; spec 09 · Replay, Review after outage; screens N29, Night note 8):
 *   POST /v1/venues/{v}/offline-orders/replay        the bar computer, signed as itself: { orders: [queued rounds] }
 *        each round checked again and answered { order_id, outcome: held | failed, reason }; the same
 *        order id is answered the same every time after, so an upload sent twice lands each round once
 *   GET  /v1/venues/{v}/offline-orders?business_date=  managers: every round taken offline on that night
 *        (queued or replayed on it), failed replays first, with its order and check now, plus the
 *        break-glass card payments still waiting in Unmatched payments
 *   POST /v1/venues/{v}/offline-orders/{replayId}/cash  { amount_cents, pin? }: a manager posts a round's
 *        offline cash as a cash payment on its check, into the drawer at their screen, with the PIN again
 */
const DESKTOPS = ["bar_computer", "front_desk"] as const;
const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const round = z.object({
  order_id: uuid,
  queued_at: z.string().refine((s) => {
    try {
      Temporal.Instant.from(s);
      return true;
    } catch {
      return false;
    }
  }),
  tab_id: z.string().min(1).max(64),
  check_id: uuid,
  tab_name: text(120),
  staff: z.object({ membership_id: text(64), name: text(120) }),
  lines: z
    .array(
      z.object({
        variant_id: uuid,
        name: text(200),
        qty: z.number().int().min(1).max(99),
        unit_cents: z.number().int().min(0).max(1_000_000),
        alcohol: z.boolean(),
      }),
    )
    .min(1)
    .max(50),
  cash_note: z.string().trim().max(200).nullable(),
});
const replayBody = z.object({ orders: z.array(round).min(1).max(100) }).strict();
const cashBody = z
  .object({
    amount_cents: z.number().int().min(1).max(10_000_000),
    pin: z
      .string()
      .regex(/^\d{4,6}$/)
      .optional(),
  })
  .strict();

/** A second upload racing the first: the unique order id answers which one landed. */
const isDuplicate = (e: unknown) => (e as { code?: string })?.code === "23505";

export function offlineOrderRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.post<{ Params: { venueId: string }; Body: unknown }>(
    "/v1/venues/:venueId/offline-orders/replay",
    { config: route({ principals: ["shared_device"], module: "core", idempotency: "optional" }) },
    async (request) => {
      const device = request.signedDevice;
      if (!device || device.venueId !== request.venueId)
        throw new ApiError("forbidden", "a computer replays its own queue");
      if (!(DESKTOPS as readonly string[]).includes(device.kind))
        throw new ApiError("forbidden", "only the bar and front-desk computers queue offline");
      const parsed = replayBody.safeParse(request.body ?? {});
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { orders: [queued rounds] }");
      const venueId = request.venueId!;
      const results: ReplayAnswer[] = [];
      for (const r of parsed.data.orders as QueuedRound[]) {
        const answer = { ...r, order_id: r.order_id.toLowerCase() };
        const now = options.clock.now();
        const input = { deviceId: device.deviceId, now };
        const before = await request.inVenue((c) => replayedBefore(c, venueId, answer.order_id));
        if (before) {
          results.push(before);
          continue;
        }
        try {
          results.push(
            await inVenueRefusing(request, (c) => replayRound(c, venueId, answer, input)),
          );
        } catch (e) {
          const reason = isDuplicate(e) ? null : reasonOf(e);
          if (!reason && !isDuplicate(e)) throw e;
          try {
            results.push(
              reason
                ? await request.inVenue((c) =>
                    recordFailed(c, venueId, answer, { ...input, reason }),
                  )
                : (await request.inVenue((c) => replayedBefore(c, venueId, answer.order_id)))!,
            );
          } catch (again) {
            if (!isDuplicate(again)) throw again;
            results.push(
              (await request.inVenue((c) => replayedBefore(c, venueId, answer.order_id)))!,
            );
          }
        }
      }
      return { results };
    },
  );

  const managers = route({ principals: ["owner_manager"], module: "core" });

  app.get<{ Params: { venueId: string }; Querystring: { business_date?: string } }>(
    "/v1/venues/:venueId/offline-orders",
    { config: managers },
    async (request) =>
      request.inVenue(async (c) => {
        const venueId = request.venueId!;
        const asked = request.query.business_date;
        let date: string;
        if (asked) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(asked))
            throw new ApiError("invalid_request", "business_date is YYYY-MM-DD");
          date = asked;
        } else {
          const clock = await venueClock(c, venueId);
          date = businessDate(
            options.clock.now(),
            clock.timeZone,
            clock.dayCutover,
          ).businessDate.toString();
        }
        const replays = await c.query(
          `select r.id, r.client_order_id as order_id, r.queued_on::text, r.replayed_on::text,
                  to_json(r.queued_at) #>> '{}' as queued_at, to_json(r.replayed_at) #>> '{}' as replayed_at,
                  r.tab_name, r.staff_name, r.lines, r.total_cents, r.cash_note, r.outcome, r.reason,
                  o.status as order_status, coalesce(o.check_id, r.check_id) as check_id, k.status as check_status,
                  case when r.cash_payment_id is null then null else json_build_object(
                    'amount_cents', (select p.amount_cents::int from payments p
                                      where p.venue_id = r.venue_id and p.id = r.cash_payment_id),
                    'at', to_json(r.cash_posted_at) #>> '{}',
                    'by', (select u.name from users u where u.id = r.cash_posted_by)) end as cash_posted
             from offline_replays r
             left join orders o on o.venue_id = r.venue_id and o.id = r.order_id
             left join checks k on k.venue_id = r.venue_id and k.id = coalesce(o.check_id, r.check_id)
            where r.venue_id = $1 and (r.queued_on = $2::date or r.replayed_on = $2::date)
            order by (r.outcome = 'failed') desc, r.queued_at, r.id`,
          [venueId, date],
        );
        // Break-glass card payments (Tap to Pay in Stripe's Dashboard app) still waiting for a check.
        const unmatched = await c.query(
          `select p.id, p.amount_cents::int as amount_cents, p.card_brand, p.card_last4,
                  to_json(p.created_at) #>> '{}' as at
             from live_payments p
            where p.venue_id = $1 and p.method = 'external' and p.status = 'captured'
              and not exists (select 1 from payment_allocations a where a.venue_id = p.venue_id and a.payment_id = p.id)
            order by p.created_at`,
          [venueId],
        );
        const p = request.principal;
        return {
          business_date: date,
          orders: replays.rows,
          unmatched: unmatched.rows,
          // Posting offline cash asks for the PIN again at a shared screen.
          pin_again: p.kind === "user" && (p.session === "pin" || p.session === "badge"),
        };
      }),
  );

  app.post<{ Params: { venueId: string; replayId: string }; Body: unknown }>(
    "/v1/venues/:venueId/offline-orders/:replayId/cash",
    {
      config: route({
        principals: ["owner_manager"],
        module: "core",
        action: "payments.take",
        idempotency: "required",
      }),
    },
    async (request: FastifyRequest<{ Params: { venueId: string; replayId: string } }>, reply) => {
      if (!uuid.safeParse(request.params.replayId).success)
        throw new ApiError("not_found", "no such offline order");
      const parsed = cashBody.safeParse(request.body ?? {});
      if (!parsed.success) throw new ApiError("invalid_request", "send { amount_cents, pin? }");
      const p = request.principal;
      if (p.kind !== "user") throw new ApiError("forbidden", "posting cash is a person's work");
      // The PIN again, in a PIN or badge session at a shared screen (spec 02 · Badges).
      if (p.session === "pin" || p.session === "badge") {
        if (!parsed.data.pin)
          throw new ApiError("invalid_request", "this asks for your PIN again", {
            details: { reason: "pin" },
          });
        await request.server.checkPinAgain(request, parsed.data.pin);
      }
      const venueId = request.venueId!;
      const deviceId = request.signedDevice?.deviceId ?? request.session?.deviceId ?? null;
      const now = options.clock.now();
      const amount = parsed.data.amount_cents;
      const taken = await request.inVenue(async (c) => {
        const r = await c.query<{
          cash_note: string | null;
          cash_payment_id: string | null;
          check_id: string;
          check_status: string | null;
          due: number | null;
        }>(
          `select r.cash_note, r.cash_payment_id, coalesce(o.check_id, r.check_id) as check_id, k.status as check_status,
                  case when k.id is null then null else amount_due(k.id)::int end as due
             from offline_replays r
             left join orders o on o.venue_id = r.venue_id and o.id = r.order_id
             left join checks k on k.venue_id = r.venue_id and k.id = coalesce(o.check_id, r.check_id)
            where r.venue_id = $1 and r.id = $2
            for update of r`,
          [venueId, request.params.replayId],
        );
        const row = r.rows[0];
        if (!row) throw new ApiError("not_found", "no such offline order");
        if (!row.cash_note)
          throw new ApiError("invalid_request", "no cash was noted on this round", {
            details: { reason: "no_cash_note" },
          });
        if (row.cash_payment_id)
          throw new ApiError("version_conflict", "this cash is posted already", {
            details: { reason: "posted" },
          });
        if (!row.check_status || row.check_status === "paid" || row.check_status === "void")
          throw new ApiError("invalid_request", `this check is ${row.check_status ?? "gone"}`, {
            details: { reason: "check_closed" },
          });
        if ((row.due ?? 0) < amount)
          throw new ApiError("over_amount_due", "that's more than the check owes", {
            details: { amount_due_cents: row.due ?? 0 },
          });
        const clock = await venueClock(c, venueId);
        const cash = await takeCash(c, venueId, {
          checkId: row.check_id,
          amountCents: amount,
          tenderedCents: amount,
          tipCents: 0,
          userId: p.userId,
          deviceId,
          businessDate: businessDate(now, clock.timeZone, clock.dayCutover).businessDate.toString(),
          now,
        });
        await c.query(
          `update offline_replays set cash_payment_id = $3, cash_posted_by = $4, cash_posted_at = $5
            where venue_id = $1 and id = $2`,
          [venueId, request.params.replayId, cash.paymentId, p.userId, now.toString()],
        );
        await emitEvent(c, {
          venueId,
          type: "check.updated",
          entityId: row.check_id,
          entityVersion: 0,
        });
        return cash;
      });
      reply.code(201);
      return {
        payment_id: taken.paymentId,
        logged_to: taken.loggedTo,
        check_status: taken.settled.status,
      };
    },
  );
}
