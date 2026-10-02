import { emitEvent, insertOrder, orderById, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { venueClock } from "./assignment.js";

/**
 * Cutting off a room or one guest (M3-21; screens N16; Money rules 5). It
 * records who, why and when, and logs a refusal. A room's cut-off stops every
 * alcohol order for the room (the room page, the host, staff, its tablet);
 * a guest's stops only theirs. Their alcohol orders still ringing or asked to
 * wait are cancelled as `cut_off`; an order with other items too keeps
 * ringing with just those, as a new order in its place. Singing is still fine.
 * There's no lifting a cut-off: the spec has none (flagged).
 */
/**
 * Cancels alcohol orders still ringing or asked to wait, for a session (and one guest), or the whole
 * venue (the 4 AM stop, M3-22). Order items are never deleted, so an order with other items too is
 * cancelled and its other items placed again as a new ringing order: both stay on the record.
 */
export async function cancelAlcohol(
  c: Queryable,
  venueId: string,
  where: { sessionId: string | null; roomGuestId: string | null },
  userId: string | null,
  now: Temporal.Instant,
  reason: "cut_off" | "alcohol_closed" = "cut_off",
): Promise<number> {
  const open = await c.query<{ id: string }>(
    `select o.id from orders o
      where o.venue_id = $1 and ($2::uuid is null or o.session_id = $2) and o.status in ('ringing', 'held')
        and ($3::uuid is null or o.room_guest_id = $3)
        and exists (select 1 from order_items i where i.venue_id = o.venue_id and i.order_id = o.id and i.alcohol)`,
    [venueId, where.sessionId, where.roomGuestId],
  );
  for (const { id } of open.rows) {
    const o = (await orderById(c, venueId, id))!;
    await c.query(
      `update orders set status = 'cancelled', cancel_reason = $5, cancelled_by = $3, cancelled_at = $4,
              version = version + 1
        where venue_id = $1 and id = $2 and status in ('ringing', 'held')`,
      [venueId, id, userId, now.toString(), reason],
    );
    await emitEvent(c, {
      venueId,
      type: "order.cancelled",
      entityId: id,
      entityVersion: o.version + 1,
      roomId: o.room_id ?? undefined,
    });
    const rest = o.items.filter((i) => !i.alcohol);
    if (rest.length > 0) {
      // The rest of the order keeps ringing, as placed.
      const kept = await insertOrder(c, venueId, {
        checkId: o.check_id,
        sessionId: o.session_id,
        roomGuestId: o.room_guest_id,
        source: o.source as "room" | "staff" | "gift" | "offline",
        placedBy: o.placed_by,
        placedAt: o.placed_at,
        businessDate: o.business_date,
        items: rest.map((i) => ({
          variantId: i.variant_id,
          itemId: i.item_id,
          options: i.options,
          qty: i.qty,
          unitCents: i.unit_cents,
          name: i.name_snapshot,
          alcohol: false,
          taxCategory: i.tax_category,
          station: i.station,
          notes: i.notes,
        })),
      });
      await emitEvent(c, {
        venueId,
        type: "order.ringing",
        entityId: kept,
        entityVersion: 0,
        roomId: o.room_id ?? undefined,
      });
    }
  }
  return open.rows.length;
}

async function logCutOff(
  c: Queryable,
  venueId: string,
  r: { sessionId: string; roomGuestId: string | null; userId: string; now: Temporal.Instant },
) {
  const v = await venueClock(c, venueId);
  await c.query(
    `insert into alcohol_refusals (venue_id, session_id, room_guest_id, reason, refused_by, at, business_date)
     values ($1, $2, $3, 'cut_off', $4, $5, $6)`,
    [
      venueId,
      r.sessionId,
      r.roomGuestId,
      r.userId,
      r.now.toString(),
      businessDate(r.now, v.timeZone, v.dayCutover).businessDate.toString(),
    ],
  );
}

export async function cutOffRoom(
  c: Queryable,
  venueId: string,
  input: { sessionId: string; userId: string; reason: string; now: Temporal.Instant },
): Promise<{ cancelled: number }> {
  const s = await c.query<{ room_id: string; ended: boolean; cut: boolean }>(
    `select room_id, ended_at is not null as ended, alcohol_cut_off_at is not null as cut
       from room_sessions where venue_id = $1 and id = $2`,
    [venueId, input.sessionId],
  );
  const session = s.rows[0];
  if (!session || session.ended) throw new ApiError("not_found", "no such session");
  if (session.cut) throw new ApiError("version_conflict", "this room is already cut off");
  await c.query(
    `update room_sessions set alcohol_cut_off_at = $3, alcohol_cut_off_by = $4, alcohol_cut_off_reason = $5
      where venue_id = $1 and id = $2`,
    [venueId, input.sessionId, input.now.toString(), input.userId, input.reason],
  );
  await logCutOff(c, venueId, {
    sessionId: input.sessionId,
    roomGuestId: null,
    userId: input.userId,
    now: input.now,
  });
  const cancelled = await cancelAlcohol(
    c,
    venueId,
    { sessionId: input.sessionId, roomGuestId: null },
    input.userId,
    input.now,
  );
  for (const type of ["session.updated", "room.updated"])
    await emitEvent(c, {
      venueId,
      type,
      entityId: input.sessionId,
      entityVersion: 0,
      roomId: session.room_id,
    });
  return { cancelled };
}

export async function cutOffGuest(
  c: Queryable,
  venueId: string,
  input: {
    sessionId: string;
    roomGuestId: string;
    userId: string;
    reason: string;
    now: Temporal.Instant;
  },
): Promise<{ cancelled: number }> {
  const g = await c.query<{ room_id: string; cut: boolean }>(
    `select g.room_id, g.alcohol_cut_off_at is not null as cut from room_guests g
       join room_sessions s on s.venue_id = g.venue_id and s.id = g.session_id
      where g.venue_id = $1 and g.id = $2 and g.session_id = $3 and s.ended_at is null`,
    [venueId, input.roomGuestId, input.sessionId],
  );
  const guest = g.rows[0];
  if (!guest) throw new ApiError("not_found", "no such guest in this room");
  if (guest.cut) throw new ApiError("version_conflict", "this guest is already cut off");
  await c.query(
    `update room_guests set alcohol_cut_off_at = $3, alcohol_cut_off_by = $4, alcohol_cut_off_reason = $5
      where venue_id = $1 and id = $2`,
    [venueId, input.roomGuestId, input.now.toString(), input.userId, input.reason],
  );
  await logCutOff(c, venueId, {
    sessionId: input.sessionId,
    roomGuestId: input.roomGuestId,
    userId: input.userId,
    now: input.now,
  });
  const cancelled = await cancelAlcohol(
    c,
    venueId,
    { sessionId: input.sessionId, roomGuestId: input.roomGuestId },
    input.userId,
    input.now,
  );
  await emitEvent(c, {
    venueId,
    type: "session.updated",
    entityId: input.sessionId,
    entityVersion: 0,
    roomId: guest.room_id,
  });
  return { cancelled };
}

/** The phones and tablets joined to a session, for cutting off one of them. */
export async function sessionGuests(c: Queryable, venueId: string, sessionId: string) {
  const r = await c.query<{
    id: string;
    name: string | null;
    is_host: boolean;
    joined_at: string;
    cut_off_at: string | null;
    cut_off_by: string | null;
  }>(
    `select g.id, g.name, g.is_host, to_json(g.joined_at) #>> '{}' as joined_at,
            to_json(g.alcohol_cut_off_at) #>> '{}' as cut_off_at,
            (select split_part(u.name, ' ', 1) from users u where u.id = g.alcohol_cut_off_by) as cut_off_by
       from room_guests g where g.venue_id = $1 and g.session_id = $2 and g.left_at is null order by g.joined_at, g.id`,
    [venueId, sessionId],
  );
  return r.rows;
}
