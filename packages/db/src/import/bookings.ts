import { createHash, randomBytes } from "node:crypto";
import { freeRoomsFor, type BlockSpan, type RoomForAssignment } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { addBlock, blocksBetween, RoomNotFree } from "../blocks.js";
import { listRooms } from "../rooms.js";
import { readSetting } from "../settings.js";
import { payTokenHash } from "../pay-links.js";
import type { Queryable } from "../tenancy.js";

/**
 * Imported future bookings (M9-02): a real room by the assignment rules, the
 * old terms as a policy version, the deposit as an `external` payment, and a
 * manage link. Pure helpers and single-booking steps; load.ts runs them inside
 * the import's own transaction as the audited migration role.
 */

/** The old system's statuses that are still to come: these get a room, their deposit and a manage link. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["pending", "confirmed"]);

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The guest's manage link: 128 random bits, kept only as its hash (as for an online booking). */
export function manageToken(): { token: string; hash: string } {
  const token = randomBytes(16).toString("base64url");
  return { token, hash: payTokenHash(token) };
}

/** The refund cut-off the old terms set: their refund window before the start, or none when they name none. */
export function refundCutoff(startsAt: string, refundHours: number | null): string | null {
  if (refundHours === null) return null;
  return Temporal.Instant.from(startsAt)
    .subtract({ minutes: refundHours * 60 })
    .toString();
}

/**
 * The rooms to try, best first: the room the guest booked when it's free and
 * fits, then the assignment rules' order (the smallest free room that fits).
 */
export function roomOrder<R extends RoomForAssignment>(
  rooms: readonly R[],
  blocks: readonly BlockSpan[],
  booking: { party: number; from: Temporal.Instant; to: Temporal.Instant; roomName: string },
): R[] {
  const free = freeRoomsFor(rooms, blocks, booking.party, booking.from, booking.to);
  const named = free.find((r) => r.name.toLowerCase() === booking.roomName.toLowerCase());
  return named ? [named, ...free.filter((r) => r !== named)] : free;
}

/**
 * Writes the booking's block (its time plus the room's cleaning minutes) in
 * the first room that's free, as staff assignment would. Returns null when no
 * room fits: that booking goes on the manager's list.
 */
export async function placeBooking(
  c: Queryable,
  venueId: string,
  booking: {
    id: string;
    party: number;
    from: Temporal.Instant;
    to: Temporal.Instant;
    roomName: string;
    businessDate: string;
  },
): Promise<{ roomId: string; sizeTier: string; moved: boolean } | null> {
  const setting = await readSetting(
    c,
    venueId,
    "rooms",
    Temporal.PlainDate.from(booking.businessDate),
  );
  const cleaningMin = setting?.value.cleaningMin ?? 0;
  const rooms = (await listRooms(c, venueId)).map((r) => ({
    id: r.id,
    name: r.name,
    sizeTier: r.size_tier,
    capacityMin: r.capacity_min,
    capacityMax: r.capacity_max,
    cleaningMin: r.cleaning_min ?? cleaningMin,
    available: r.state !== "out_of_service",
  }));
  const blocks = (
    await blocksBetween(
      c,
      venueId,
      booking.from.subtract({ hours: 24 }),
      booking.to.add({ hours: 24 }),
    )
  ).map((b): BlockSpan => ({
    roomId: b.room_id,
    from: Temporal.Instant.from(b.starts_at),
    to: b.ends_at === null ? null : Temporal.Instant.from(b.ends_at),
  }));
  for (const room of roomOrder(rooms, blocks, booking)) {
    await c.query("savepoint import_place");
    try {
      await addBlock(c, {
        venueId,
        roomId: room.id,
        kind: "booking",
        from: booking.from,
        to: booking.to.add({ minutes: room.cleaningMin }),
        refId: booking.id,
      });
      await c.query("release savepoint import_place");
      return {
        roomId: room.id,
        sizeTier: room.sizeTier,
        moved: room.name.toLowerCase() !== booking.roomName.toLowerCase(),
      };
    } catch (e) {
      await c.query("rollback to savepoint import_place");
      if (!(e instanceof RoomNotFree)) throw e;
    }
  }
  return null;
}

/** The deposit paid through the old system: an `external` payment of the booking, captured, applied at check-in. */
export async function insertLegacyDeposit(
  c: Queryable,
  venueId: string,
  input: { bookingId: string; amountCents: number; businessDate: string },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into payments (venue_id, method, status, business_date, amount_cents, booking_id)
     values ($1, 'external', 'captured', $2, $3, $4) returning id`,
    [venueId, input.businessDate, input.amountCents, input.bookingId],
  );
  const id = r.rows[0]!.id;
  await c.query(
    `insert into payment_events (venue_id, payment_id, from_status, to_status, source)
     values ($1, $2, null, 'captured', 'import')`,
    [venueId, id],
  );
  return id;
}
