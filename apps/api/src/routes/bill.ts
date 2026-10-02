import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { payTokenHash, venueForBookingToken, withVenue } from "@west4/db";
import type { Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { payAnotherWay } from "../payments/bill-pay.js";
import { guestBill } from "../rooms/guest-bill.js";
import { createCall } from "../rooms/calls.js";
import type { StripeClient } from "../stripe/client.js";
import { currentGuest } from "./room-orders.js";

/**
 * Paying the bill from a guest's own phone (M4-16; screens N5; spec 08 · Guest room, Bookings):
 *   POST /v1/public/room-session/pay-link   "Pay another way": a payment-page link for the amount due
 *   GET  /v1/public/bookings/{token}        the booking link: the booking, and its bill once presented
 *   POST /v1/public/bookings/{token}/pay-link   the same "Pay another way" from the booking link
 *   POST /v1/public/bookings/{token}/cash       "Pay cash to staff" from the booking link
 * A room tablet reads the bill but never pays from it. "Pay cash to staff" is the room call of kind
 * `check` (POST /room-session/calls on the room page), so staff come with the cash panel.
 */
const notFound = () => new ApiError("not_found", "this link isn't valid");

export function billRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; stripe: () => StripeClient; payAppUrl: string | null },
): void {
  const deps = () => ({ pool: options.pool, stripe: options.stripe(), clock: options.clock });

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

  /** The booking behind a link token, inside its venue, or not found. */
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
            where b.venue_id = $1 and b.manage_token_hash = $2`,
          [venueId, hash],
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
      const { booking: b, bill } = await booking(request.params.token);
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
