import { Temporal } from "@west4/shared";

/**
 * Room assignment (M2-05; spec 04 · Room assignment). Pure: rooms and their
 * blocks in, a choice out. The smallest free room that fits the party; a room
 * fits when the party is no bigger than its capacity_max, and capacity_min
 * only orders the choice. A bigger tier is taken only when no smaller fitting
 * room is free; when several bookings are placed at once (a room switched
 * off), the largest parties go first so none is left without a room it needs.
 */
export interface RoomForAssignment {
  readonly id: string;
  readonly name: string;
  readonly capacityMin: number;
  readonly capacityMax: number;
  /** The room's own cleaning minutes, or the venue's. */
  readonly cleaningMin: number;
  readonly available: boolean;
}

export interface BlockSpan {
  readonly roomId: string;
  readonly from: Temporal.Instant;
  /** null: open-ended (cleaning or out of service until staff end it). */
  readonly to: Temporal.Instant | null;
}

const overlaps = (
  a: { from: Temporal.Instant; to: Temporal.Instant | null },
  b: { from: Temporal.Instant; to: Temporal.Instant | null },
): boolean =>
  (a.to === null || Temporal.Instant.compare(b.from, a.to) < 0) &&
  (b.to === null || Temporal.Instant.compare(a.from, b.to) < 0);

/** The order assignment tries rooms in: smallest capacity first, then the smaller minimum, then the name. */
export function assignmentOrder<R extends RoomForAssignment>(rooms: readonly R[]): R[] {
  return [...rooms].sort(
    (a, b) =>
      a.capacityMax - b.capacityMax ||
      a.capacityMin - b.capacityMin ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

/** A booking's block: its time plus the room's cleaning minutes. */
export function bookingSpan(
  room: RoomForAssignment,
  from: Temporal.Instant,
  to: Temporal.Instant,
): { from: Temporal.Instant; to: Temporal.Instant } {
  return { from, to: to.add({ minutes: room.cleaningMin }) };
}

/** Rooms that fit the party and are free for [from, to) plus cleaning, in assignment order. */
export function freeRoomsFor<R extends RoomForAssignment>(
  rooms: readonly R[],
  blocks: readonly BlockSpan[],
  party: number,
  from: Temporal.Instant,
  to: Temporal.Instant,
): R[] {
  return assignmentOrder(rooms).filter((room) => {
    if (!room.available || party > room.capacityMax) return false;
    const span = bookingSpan(room, from, to);
    return !blocks.some((b) => b.roomId === room.id && overlaps(span, b));
  });
}

export type AssignmentRefusal = "past_close" | "no_room";

/** The room a booking gets, or why none. A booking must end by the night's close. */
export function chooseRoom<R extends RoomForAssignment>(
  rooms: readonly R[],
  blocks: readonly BlockSpan[],
  party: number,
  from: Temporal.Instant,
  to: Temporal.Instant,
  close: Temporal.Instant | null,
): { room: R } | { refused: AssignmentRefusal } {
  if (close !== null && Temporal.Instant.compare(to, close) > 0) return { refused: "past_close" };
  const room = freeRoomsFor(rooms, blocks, party, from, to)[0];
  return room ? { room } : { refused: "no_room" };
}

/**
 * When a room is free until: the start of its next block after `at`, or null
 * when nothing more is booked tonight (free all night up to the close). A
 * room with a block covering `at` isn't free; its answer says until when it's
 * busy instead.
 */
export function freeUntil(
  roomId: string,
  blocks: readonly BlockSpan[],
  at: Temporal.Instant,
): { freeNow: boolean; until: Temporal.Instant | null } {
  const mine = blocks
    .filter((b) => b.roomId === roomId)
    .sort((a, b) => Temporal.Instant.compare(a.from, b.from));
  const current = mine.find(
    (b) =>
      Temporal.Instant.compare(b.from, at) <= 0 &&
      (b.to === null || Temporal.Instant.compare(at, b.to) < 0),
  );
  if (current) return { freeNow: false, until: current.to };
  const next = mine.find((b) => Temporal.Instant.compare(b.from, at) > 0);
  return { freeNow: true, until: next ? next.from : null };
}

/**
 * A session past its booked end extends 15 minutes at a time, only while
 * nothing is booked next: the next block must still have the wrap-up notice
 * plus the room's cleaning before it starts, and nothing runs past the close.
 */
export function canExtend(
  sessionTo: Temporal.Instant,
  nextFrom: Temporal.Instant | null,
  noticeMin: number,
  cleaningMin: number,
  close: Temporal.Instant | null,
): { ok: true; to: Temporal.Instant } | { ok: false; why: "booked_next" | "past_close" } {
  const to = sessionTo.add({ minutes: 15 });
  if (close !== null && Temporal.Instant.compare(to, close) > 0)
    return { ok: false, why: "past_close" };
  if (
    nextFrom !== null &&
    Temporal.Instant.compare(to, nextFrom.subtract({ minutes: noticeMin + cleaningMin })) > 0
  )
    return { ok: false, why: "booked_next" };
  return { ok: true, to };
}
