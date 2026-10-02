import type pg from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { listOrders, orderById, withVenue, type OrderRow, type RoomGuestRow } from "@west4/db";
import { ORDER_STATUSES } from "@west4/rules";
import type { Clock } from "@west4/shared";
import { z } from "zod";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { placeRoomOrder } from "../orders/place.js";
import { stepOrder } from "../orders/pipeline.js";

/**
 * Ordering from the room page (M3-09; spec 08 · Guest room):
 *   GET  /v1/public/room-session/orders               the room's orders tonight, as the guest sees them
 *   POST /v1/public/room-session/orders               { client_order_id, lines }: rings at the bar
 *   POST /v1/public/room-session/orders/{o}/cancel    while ringing or asked to wait, by whoever placed it or the host
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

/** The joined guest, current: the session still open and the token at its version. */
function currentGuest(request: FastifyRequest): RoomGuestRow & { venueId: string } {
  const g = request.roomGuest;
  if (!g || request.principal.kind !== "guest")
    throw new ApiError("unauthorized", "join the room first");
  if (g.session.ended)
    throw new ApiError("not_found", "this room's session has ended", {
      details: { reason: "ended" },
    });
  if (g.token_version !== g.session.token_version)
    throw new ApiError("session_expired", "the room has a new code; open the room page again", {
      details: { reason: "rotated" },
    });
  return { ...g, venueId: request.principal.venueId };
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
  options: { pool: pg.Pool; clock: Clock },
): void {
  const guest = route({
    principals: ["guest_room"],
    module: "room_ordering",
    idempotency: "none",
    tokenRoute: true,
  });

  app.get("/v1/public/room-session/orders", { config: guest }, async (request) => {
    const me = currentGuest(request);
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
      const me = currentGuest(request);
      const order = await withVenue(
        options.pool,
        { venueId: me.venueId, requestId: request.requestId },
        (c) =>
          placeRoomOrder(c, me.venueId, {
            sessionId: me.session_id,
            roomGuestId: me.id,
            roomId: me.session.room_id,
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
      const me = currentGuest(request);
      if (!id.safeParse(request.params.orderId).success)
        throw new ApiError("not_found", "no such order");
      return withVenue(
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
}
