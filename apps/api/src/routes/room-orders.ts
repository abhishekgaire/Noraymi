import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  emitEvent,
  listOrders,
  orderById,
  withVenue,
  type OrderRow,
  type RoomGuestRow,
} from "@west4/db";
import { ORDER_STATUSES } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { placeRoomOrder, sameAgainRounds } from "../orders/place.js";
import { roomGuestOf } from "../rooms/room-guest.js";
import { withVenueRefusing } from "../orders/alcohol.js";
import { board } from "../rooms/board.js";
import { CALL_KINDS, createCall, type CallKind } from "../rooms/calls.js";
import { newRoomCode } from "../rooms/checkin.js";
import { roomCodeColumns } from "../rooms/room-code.js";
import { stepOrder } from "../orders/pipeline.js";
import { guestBill, type GuestBill } from "../rooms/guest-bill.js";
import { webReceiptLink, type ReceiptDeps } from "../receipts/send.js";

/**
 * Ordering from the room page (M3-09; spec 08 · Guest room):
 *   GET  /v1/public/room-session/orders               the room's orders tonight, as the guest sees them
 *   POST /v1/public/room-session/orders               { client_order_id, lines }: rings at the bar
 *   POST /v1/public/room-session/orders/{o}/cancel    while ringing or asked to wait, by whoever placed it or the host
 *   GET  /v1/public/room-session/same-again           the room's delivered rounds, priced from today's menu (M3-11)
 *   POST /v1/public/room-session/same-again           { order_id, client_order_id }: orders a round again; it rings like any order
 *   GET  /v1/public/room-session/bill                 tonight so far, before tax and gratuity (M3-10);
 *                                                     after Present, `presented` is the bill (M4-16)
 *   POST /v1/public/room-session/calls                { kind: mic | tv | check | other }: staff get it on their phones
 *   POST /v1/public/room-session/lock                 { on }: the host lock, host only; turning it on gives the room a new code
 * Statuses come from the server; the page shows them in the glossary's guest words. A phone whose
 * session moved on must call GET /room-session first, which gives it a fresh token.
 */
const id = z.string().uuid();
const line = z
  .object({
    variant_id: id,
    qty: z.number().int().min(1).max(20),
    option_ids: z.array(id).max(10).optional(),
    notes: z.string().max(200).nullable().optional(),
  })
  .strict();
const orderBody = z
  .object({ client_order_id: z.string().min(8).max(64), lines: z.array(line).min(1).max(30) })
  .strict();

/** The joined guest or tablet, current: the session still open and the token at its version. */
export async function currentGuest(
  request: FastifyRequest,
  pool: pg.Pool,
  clock: Clock,
): Promise<RoomGuestRow & { venueId: string }> {
  const g = await roomGuestOf(request, pool, clock.now());
  if (g.session.ended)
    throw new ApiError("not_found", "this room's session has ended", {
      details: { reason: "ended" },
    });
  if (g.token_version !== g.session.token_version)
    throw new ApiError("session_expired", "the room has a new code; open the room page again", {
      details: { reason: "rotated" },
    });
  return g;
}

/** An order as the guest's phone shows it: no staff ids, whether it's theirs, and whether they may cancel it. */
function guestView(o: OrderRow, me: RoomGuestRow) {
  const mine = o.room_guest_id === me.id;
  return {
    id: o.id,
    status: o.status,
    cancel_reason: o.cancel_reason,
    decline_reason: o.decline_reason,
    placed_at: o.placed_at,
    room_name: o.room_name,
    amount_cents: o.amount_cents,
    items: o.items.map((i) => ({
      qty: i.qty,
      name: i.name_snapshot,
      options: i.options.map((x) => x.name),
    })),
    mine,
    can_cancel: (o.status === "ringing" || o.status === "held") && (mine || me.is_host),
  };
}

export function roomOrderRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; clock: Clock; receipts?: ReceiptDeps },
): void {
  const guest = route({
    principals: ["guest_room", "room_tablet"],
    module: "room_ordering",
    idempotency: "none",
    tokenRoute: true,
  });

  app.get("/v1/public/room-session/orders", { config: guest }, async (request) => {
    const me = await currentGuest(request, options.pool, options.clock);
    const orders = await withVenue(
      options.pool,
      { venueId: me.venueId, requestId: request.requestId },
      (c) => listOrders(c, me.venueId, ORDER_STATUSES, { sessionId: me.session_id }),
    );
    return { orders: orders.map((o) => guestView(o, me)).reverse() };
  });

  app.post<{ Body: unknown }>(
    "/v1/public/room-session/orders",
    { config: guest },
    async (request, reply) => {
      const parsed = orderBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError(
          "invalid_request",
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      const me = await currentGuest(request, options.pool, options.clock);
      const order = await withVenueRefusing(
        options.pool,
        { venueId: me.venueId, requestId: request.requestId },
        (c) =>
          placeRoomOrder(c, me.venueId, {
            sessionId: me.session_id,
            roomGuestId: me.id,
            roomId: me.session.room_id,
            isHost: me.is_host,
            lines: parsed.data.lines,
            clientOrderId: parsed.data.client_order_id,
            now: options.clock.now(),
          }),
      );
      return reply.code(201).send({ order: guestView(order, me) });
    },
  );

  app.post<{ Params: { orderId: string } }>(
    "/v1/public/room-session/orders/:orderId/cancel",
    { config: guest },
    async (request) => {
      const me = await currentGuest(request, options.pool, options.clock);
      if (!id.safeParse(request.params.orderId).success)
        throw new ApiError("not_found", "no such order");
      return withVenueRefusing(
        options.pool,
        { venueId: me.venueId, requestId: request.requestId },
        async (c) => {
          const o = await orderById(c, me.venueId, request.params.orderId);
          if (!o || o.session_id !== me.session_id)
            throw new ApiError("not_found", "no such order");
          if (o.room_guest_id !== me.id && !me.is_host)
            throw new ApiError("forbidden", "only whoever ordered it, or the host, can cancel it");
          const done = await stepOrder(c, me.venueId, o.id, "cancel", {
            userId: null,
            now: options.clock.now(),
            cancelledFor: "guest",
          });
          if (done.status !== "done") throw new ApiError("internal", "a cancel didn't finish");
          return { order: guestView(done.order, me) };
        },
      );
    },
  );

  /**
   * Tonight so far (M3-10): the room's tile from the board, so the phone and staff read one number:
   * room time with its minutes, drinks on the tab, the tab so far before tax and gratuity, the rate
   * a minute, the deposit, and the stay or wrap-up line. The next party is never named to the room.
   */
  /** A paid bill carries its receipt link (M4-19). */
  const withReceiptLink = async (venueId: string, bill: GuestBill) => {
    if (bill.status !== "paid" || !options.receipts) return bill;
    const deps = options.receipts;
    const link = await withVenue(options.pool, { venueId, requestId: "receipt-link" }, (c) =>
      webReceiptLink(c, venueId, bill.check_id, deps, options.clock.now()),
    );
    return { ...bill, receipt_url: link };
  };

  app.get("/v1/public/room-session/bill", { config: guest }, async (request) => {
    // A paid room goes to cleaning and its session ends (M4-12); its phones still read the paid bill
    // and its receipt link (M4-16), and nothing else.
    const joined = await roomGuestOf(request, options.pool, options.clock.now());
    if (joined.session.ended && joined.token_version === joined.session.token_version) {
      const checkId = joined.session.check_id;
      const paid = checkId
        ? await withVenue(
            options.pool,
            { venueId: joined.venueId, requestId: request.requestId },
            (c) => guestBill(c, joined.venueId, checkId),
          )
        : null;
      if (paid?.status === "paid")
        return { ended: true, presented: await withReceiptLink(joined.venueId, paid) };
    }
    const me = await currentGuest(request, options.pool, options.clock);
    const now = options.clock.now();
    const [tiles, venue, presented] = await withVenue(
      options.pool,
      { venueId: me.venueId, requestId: request.requestId },
      async (c) => {
        const read = await Promise.all([
          board(c, me.venueId, now),
          c.query<{ time_zone: string }>("select time_zone from venues where id = $1", [
            me.venueId,
          ]),
        ]);
        // One query at a time on the connection: the bill reads after the board.
        const bill = me.session.check_id
          ? await guestBill(c, me.venueId, me.session.check_id)
          : null;
        return [...read, bill] as const;
      },
    );
    const tile = tiles.rooms.find((r) => r.room_id === me.session.room_id);
    const s = tile?.session;
    if (!tile || !s)
      throw new ApiError("not_found", "this room's session has ended", {
        details: { reason: "ended" },
      });
    return {
      minutes: s.minutes,
      room_time_cents: s.room_time_cents,
      drinks_cents: s.tab_so_far_cents - s.room_time_cents,
      tab_so_far_cents: s.tab_so_far_cents,
      per_minute_cents: Math.round(s.hourly_cents / 60),
      party_size: s.party_size,
      deposit_cents: s.deposit_cents,
      stay_on_until: s.stay_on_offer ? s.close : null,
      wrap_up_at: s.wrap_up && tile.next ? tile.next.at : null,
      time_zone: venue.rows[0]?.time_zone ?? "America/New_York",
      // Once staff Present the check (M4-16): the bill itself. A tablet shows it with no ways to pay.
      presented: presented ? await withReceiptLink(me.venueId, presented) : null,
    };
  });

  const callBody = z.object({ kind: z.enum(CALL_KINDS as [CallKind, ...CallKind[]]) }).strict();
  app.post<{ Body: unknown }>(
    "/v1/public/room-session/calls",
    { config: guest },
    async (request, reply) => {
      const parsed = callBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", `kind is one of ${CALL_KINDS.join(", ")}`);
      const me = await currentGuest(request, options.pool, options.clock);
      const call = await withVenue(
        options.pool,
        { venueId: me.venueId, requestId: request.requestId },
        (c) =>
          createCall(c, me.venueId, {
            sessionId: me.session_id,
            kind: parsed.data.kind,
            now: options.clock.now(),
          }),
      );
      return reply.code(201).send({ call: { id: call.id, kind: call.kind } });
    },
  );

  const lockBody = z.object({ on: z.boolean() }).strict();
  app.post<{ Body: unknown }>(
    "/v1/public/room-session/lock",
    { config: guest },
    async (request) => {
      const parsed = lockBody.safeParse(request.body);
      if (!parsed.success) throw new ApiError("invalid_request", "send { on }");
      const me = await currentGuest(request, options.pool, options.clock);
      if (!me.is_host) throw new ApiError("forbidden", "only the host can lock ordering");
      await withVenue(
        options.pool,
        { venueId: me.venueId, requestId: request.requestId },
        async (c) => {
          if (parsed.data.on && !me.session.host_lock) {
            // Locking gives the room a new code, so a code passed around stops working; joined phones
            // get a fresh token and the new code on their next call (M3-08).
            const cols = roomCodeColumns(me.venueId, newRoomCode(me.session.room_name));
            await c.query(
              `update room_sessions set host_lock = true, room_code_hash = $3, room_code_enc = $4,
                  token_version = token_version + 1, wrong_codes = 0
            where venue_id = $1 and id = $2`,
              [me.venueId, me.session_id, cols.hash, cols.sealed],
            );
            // The host's own phone keeps working without a rejoin.
            await c.query(
              "update room_guests set token_version = token_version + 1 where venue_id = $1 and id = $2",
              [me.venueId, me.id],
            );
          } else if (!parsed.data.on) {
            await c.query(
              "update room_sessions set host_lock = false where venue_id = $1 and id = $2",
              [me.venueId, me.session_id],
            );
          }
          await emitEvent(c, {
            venueId: me.venueId,
            type: "session.updated",
            entityId: me.session_id,
            entityVersion: 0,
            roomId: me.session.room_id,
          });
        },
      );
      return { host_lock: parsed.data.on };
    },
  );

  app.get("/v1/public/room-session/same-again", { config: guest }, async (request) => {
    const me = await currentGuest(request, options.pool, options.clock);
    const rounds = await withVenue(
      options.pool,
      { venueId: me.venueId, requestId: request.requestId },
      (c) => sameAgainRounds(c, me.venueId, me.session_id, options.clock.now(), me.id),
    );
    return { rounds };
  });

  const againBody = z.object({ order_id: id, client_order_id: z.string().min(8).max(64) }).strict();
  app.post<{ Body: unknown }>(
    "/v1/public/room-session/same-again",
    { config: guest },
    async (request, reply) => {
      const parsed = againBody.safeParse(request.body);
      if (!parsed.success)
        throw new ApiError("invalid_request", "send { order_id, client_order_id }");
      const me = await currentGuest(request, options.pool, options.clock);
      const now = options.clock.now();
      const order = await withVenueRefusing(
        options.pool,
        { venueId: me.venueId, requestId: request.requestId },
        async (c) => {
          const round = (
            await sameAgainRounds(c, me.venueId, me.session_id, now, me.id, false)
          ).find((r) => r.order_id === parsed.data.order_id);
          if (!round) throw new ApiError("not_found", "that round can't be ordered again");
          return placeRoomOrder(c, me.venueId, {
            sessionId: me.session_id,
            roomGuestId: me.id,
            roomId: me.session.room_id,
            isHost: me.is_host,
            lines: round.lines.map((l) => ({
              variant_id: l.variant_id,
              qty: l.qty,
              option_ids: l.option_ids,
            })),
            clientOrderId: parsed.data.client_order_id,
            sameAgainOf: round.order_id,
            now,
          });
        },
      );
      return reply
        .code(201)
        .send({ order: { ...guestView(order, me), same_again_of: order.same_again_of } });
    },
  );
}
