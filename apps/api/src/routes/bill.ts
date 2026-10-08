import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  createPayLink,
  latestAttempt,
  paymentById,
  payTokenHash,
  setPayLinkPayment,
  venueForBookingToken,
  withVenue,
} from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { LINK_DAYS_AFTER } from "../bookings/online.js";
import { ApiError } from "../http/errors.js";
import { payAnotherWay } from "../payments/bill-pay.js";
import { guestBill } from "../rooms/guest-bill.js";
import { createCall } from "../rooms/calls.js";
import type { StripeClient } from "../stripe/client.js";
import { currentGuest } from "./room-orders.js";
import { z } from "zod";
import { chargeNow, guestConfirms } from "../payments/card-on-file.js";
import { screenState } from "../payments/machine.js";
import { businessDate } from "@west4/rules";
import { startMyShare } from "../payments/pay-my-share.js";
import { webReceiptLink, type ReceiptDeps } from "../receipts/send.js";

/**
 * Paying the bill from a guest's own phone (M4-16; screens N5; spec 08 · Guest room, Bookings):
 *   POST /v1/public/room-session/pay-link   "Pay another way": a payment-page link for the amount due
 *   GET  /v1/public/bookings/{token}        the booking link: the booking, and its bill once presented
 *   POST /v1/public/bookings/{token}/pay-link   the same "Pay another way" from the booking link
 *   POST /v1/public/bookings/{token}/cash       "Pay cash to staff" from the booking link
 *   POST /v1/public/room-session/payments/{p}/confirm, /v1/public/bookings/{token}/payments/{p}/confirm
 *                                               "Pay with Amex ··1005": the guest's OK for a card on file (M4-17)
 *   POST /v1/public/room-session/shares          Pay my share { kind: even | items, name? }: the guest's share and its
 *                                               payment-page link; 403 when pay.payShare is off (M4-18)
 * A room tablet reads the bill but never pays from it. "Pay cash to staff" is the room call of kind
 * `check` (POST /room-session/calls on the room page), so staff come with the cash panel.
 */
const notFound = () => new ApiError("not_found", "this link isn't valid");

export function billRoutes(
  app: FastifyInstance,
  options: {
    pool: pg.Pool;
    clock: Clock;
    stripe: () => StripeClient;
    payAppUrl: string | null;
    texts?: { allowList: readonly string[] | null };
    receipts?: ReceiptDeps;
  },
): void {
  const deps = () => ({ pool: options.pool, stripe: options.stripe(), clock: options.clock });

  /** "Pay with Amex ··1005" (M4-17): the guest's OK; the charge runs now. */
  async function confirmOnFile(venueId: string, checkId: string, paymentId: string) {
    if (!z.string().uuid().safeParse(paymentId).success)
      throw new ApiError("not_found", "no such payment");
    const attemptNo = await withVenue(
      options.pool,
      { venueId, requestId: `payment:${paymentId}:guest-ok` },
      (c) => guestConfirms(c, venueId, { paymentId, checkId, now: options.clock.now() }),
    );
    await chargeNow(
      {
        ...deps(),
        payAppUrl: options.payAppUrl,
        texts: options.texts ?? { allowList: null },
        ...(options.receipts ? { receipts: options.receipts } : {}),
      },
      venueId,
      paymentId,
      attemptNo,
    );
    return withVenue(
      options.pool,
      { venueId, requestId: `payment:${paymentId}:read` },
      async (c) => {
        const payment = (await paymentById(c, venueId, paymentId))!;
        const state = screenState(payment, await latestAttempt(c, venueId, paymentId));
        return {
          status:
            state === "paid" ? "paid" : state === "declined" ? "declined" : ("checking" as const),
          bill: await guestBill(c, venueId, checkId),
        };
      },
    );
  }

  app.post<{ Params: { paymentId: string } }>(
    "/v1/public/room-session/payments/:paymentId/confirm",
    {
      config: route({
        principals: ["guest_room"],
        module: "room_ordering",
        idempotency: "none",
        tokenRoute: true,
      }),
    },
    async (request) => {
      const me = await currentGuest(request, options.pool, options.clock);
      if (!me.session.check_id) throw new ApiError("not_found", "no such payment");
      return confirmOnFile(me.venueId, me.session.check_id, request.params.paymentId);
    },
  );

  app.post(
    "/v1/public/room-session/pay-link",
    {
      config: route({
        principals: ["guest_room"],
        module: "room_ordering",
        idempotency: "none",
        tokenRoute: true,
      }),
    },
    async (request, reply) => {
      const me = await currentGuest(request, options.pool, options.clock);
      if (!me.session.check_id) throw new ApiError("invalid_request", "the bill isn't ready yet");
      const link = await payAnotherWay(deps(), me.venueId, me.session.check_id, options.payAppUrl);
      return reply.code(201).send(link);
    },
  );

  // Pay my share (M4-18): the guest's own share, and a payment-page link for it.
  const shareBody = z
    .object({
      kind: z.enum(["even", "items"]),
      name: z.string().trim().min(1).max(40).nullable().optional(),
    })
    .strict();
  app.post<{ Body: unknown }>(
    "/v1/public/room-session/shares",
    {
      config: route({
        principals: ["guest_room"],
        module: "room_ordering",
        idempotency: "none",
        tokenRoute: true,
      }),
    },
    async (request, reply) => {
      const parsed = shareBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", 'send { kind: "even" | "items" }');
      const me = await currentGuest(request, options.pool, options.clock);
      const checkId = me.session.check_id;
      if (!checkId) throw new ApiError("invalid_request", "the bill isn't ready yet");
      if (!options.payAppUrl)
        throw new ApiError("invalid_request", "the payment page has no address here yet");
      const now = options.clock.now();
      const answer = await withVenue(
        options.pool,
        { venueId: me.venueId, requestId: request.requestId },
        async (c) => {
          const v = (
            await c.query<{ time_zone: string; day_cutover: string }>(
              "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
              [me.venueId],
            )
          ).rows[0]!;
          const share = await startMyShare(c, me.venueId, {
            checkId,
            roomGuestId: me.id,
            partySize: me.session.party_size,
            kind: parsed.data.kind,
            name: parsed.data.name ?? null,
            businessDate: businessDate(now, v.time_zone, v.day_cutover).businessDate.toString(),
            now,
          });
          if (!share?.payment_id) return { share, url: null };
          const link = await createPayLink(c, me.venueId, {
            checkId,
            amountCents: share.amount_cents,
            expiresAt: now.add({ minutes: 60 }).toString(),
            purpose: "link",
          });
          await setPayLinkPayment(c, me.venueId, link.id, share.payment_id);
          return { share, url: `${options.payAppUrl}/pay/${link.token}` };
        },
      );
      return reply.code(answer.url ? 201 : 200).send({
        share: answer.share,
        url: answer.url,
        nothing_left: !answer.url,
      });
    },
  );

  /** The booking behind a link token (the one the guest booked with, or a text's), inside its venue, or not found. */
  async function booking(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound();
    const hash = payTokenHash(token);
    const venueId = await venueForBookingToken(options.pool, hash);
    if (!venueId) throw notFound();
    return withVenue(options.pool, { venueId, requestId: "booking-link" }, async (c) => {
      const b = (
        await c.query<{
          id: string;
          status: string;
          party_size: number;
          starts_at: string;
          venue_name: string;
          guest_name: string | null;
          check_id: string | null;
        }>(
          `select b.id, b.status, b.party_size, to_json(b.starts_at) #>> '{}' as starts_at, v.name as venue_name,
                  split_part(g.name, ' ', 1) as guest_name,
                  (select k.id from checks k where k.venue_id = b.venue_id and k.booking_id = b.id and k.kind = 'room'
                    order by k.opened_at desc limit 1) as check_id
             from bookings b join venues v on v.id = b.venue_id
             left join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
            where b.venue_id = $1
              and (b.manage_token_hash = $2
                   or b.id in (select l.booking_id from booking_links l where l.venue_id = $1 and l.token_hash = $2))
              -- A manage link expires a day after the booking ends (M5-10; Security 9).
              and b.ends_at + interval '${LINK_DAYS_AFTER} days' > $3`,
          [venueId, hash, options.clock.now().toString()],
        )
      ).rows[0];
      if (!b) throw notFound();
      return {
        venueId,
        booking: b,
        bill: b.check_id ? await guestBill(c, venueId, b.check_id) : null,
      };
    });
  }

  const tokenConfig = route({
    principals: ["public"],
    module: "core",
    tokenRoute: true,
    idempotency: "none",
  });
  app.get<{ Params: { token: string } }>(
    "/v1/public/bookings/:token",
    { config: tokenConfig },
    async (request) => {
      const { venueId, booking: b, bill: found } = await booking(request.params.token);
      const receipts = options.receipts;
      const bill =
        found?.status === "paid" && receipts
          ? {
              ...found,
              receipt_url: await withVenue(
                options.pool,
                { venueId, requestId: "receipt-link" },
                (c) => webReceiptLink(c, venueId, found.check_id, receipts, options.clock.now()),
              ),
            }
          : found;
      return {
        venue_name: b.venue_name,
        guest_name: b.guest_name,
        party_size: b.party_size,
        starts_at: b.starts_at,
        status: b.status,
        bill,
      };
    },
  );
  app.post<{ Params: { token: string } }>(
    "/v1/public/bookings/:token/pay-link",
    { config: tokenConfig },
    async (request, reply) => {
      const { venueId, bill } = await booking(request.params.token);
      if (!bill) throw new ApiError("invalid_request", "the bill isn't ready yet");
      const link = await payAnotherWay(deps(), venueId, bill.check_id, options.payAppUrl);
      return reply.code(201).send(link);
    },
  );
  app.post<{ Params: { token: string; paymentId: string } }>(
    "/v1/public/bookings/:token/payments/:paymentId/confirm",
    { config: tokenConfig },
    async (request) => {
      const { venueId, bill } = await booking(request.params.token);
      if (!bill) throw new ApiError("not_found", "no such payment");
      return confirmOnFile(venueId, bill.check_id, request.params.paymentId);
    },
  );
  app.post<{ Params: { token: string } }>(
    "/v1/public/bookings/:token/cash",
    { config: tokenConfig },
    async (request, reply) => {
      const { venueId, bill } = await booking(request.params.token);
      if (!bill) throw new ApiError("invalid_request", "the bill isn't ready yet");
      const call = await withVenue(
        options.pool,
        { venueId, requestId: request.requestId },
        async (c) => {
          const s = (
            await c.query<{ session_id: string }>(
              `select k.room_session_id as session_id from checks k join room_sessions s
                  on s.venue_id = k.venue_id and s.id = k.room_session_id
                where k.venue_id = $1 and k.id = $2 and s.ended_at is null`,
              [venueId, bill.check_id],
            )
          ).rows[0];
          if (!s) throw new ApiError("invalid_request", "this room's session has ended");
          return createCall(c, venueId, {
            sessionId: s.session_id,
            kind: "check",
            now: options.clock.now(),
          });
        },
      );
      return reply.code(201).send({ call: { id: call.id, kind: call.kind } });
    },
  );
}
