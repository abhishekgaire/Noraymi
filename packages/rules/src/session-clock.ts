import { Temporal, type Cents } from "@west4/shared";
import { roomTime, type BillingStep } from "./room-time.js";

/**
 * The live room clock (M2-07; spec 05 · rules 3 and 4). Pure: a session's
 * segments and what's around it in, what the tile and the room screen say
 * out. The booked end never stops the clock. Past it with nobody booked next
 * and stay-on allowed, the party may stay on by the minute until the close;
 * offers to stay on stop 30 minutes before it. When someone needs the room,
 * or the night closes, the room is in wrap-up.
 */
export interface ClockSegment {
  readonly startedAt: Temporal.Instant;
  /** null: still running. */
  readonly endedAt: Temporal.Instant | null;
  readonly hourlyCents: Cents;
  readonly paused: boolean;
}

export type Tile =
  | { readonly kind: "in_room"; readonly minutesLeft: number }
  | { readonly kind: "staying"; readonly minutesPast: number }
  | { readonly kind: "needed_now"; readonly minutesPast: number }
  | { readonly kind: "walk_in" };

export interface SessionClock {
  readonly minutes: number;
  readonly roomTimeCents: Cents;
  readonly tile: Tile;
  /** The room shows "Stay on by the minute until we close at …". */
  readonly stayOnOffer: boolean;
  /** Staff and the room screen get wrap-up prompts. */
  readonly wrapUp: boolean;
}

export const STAY_ON_STOPS_BEFORE_CLOSE_MIN = 30;

const minutesBetween = (a: Temporal.Instant, b: Temporal.Instant) =>
  Math.floor((b.epochMilliseconds - a.epochMilliseconds) / 60_000);

export function sessionClock(input: {
  readonly segments: readonly ClockSegment[];
  readonly now: Temporal.Instant;
  readonly bookedEnd: Temporal.Instant | null;
  /** The next booking or offer that needs the room, or null. */
  readonly nextNeedsRoomAt: Temporal.Instant | null;
  readonly close: Temporal.Instant | null;
  readonly stayOnWhenFree: boolean;
  /** The wrap-up notice before a booked end when someone is next (alerts.roomEndingMin). */
  readonly noticeMin: number;
  readonly firstHourMinimum: boolean;
  readonly step?: BillingStep;
}): SessionClock {
  const now = input.now;
  const billed = input.segments.map((s) => {
    const end = s.endedAt ?? now;
    return {
      minutes: Math.max(0, minutesBetween(s.startedAt, end)),
      hourlyCents: s.hourlyCents,
      paused: s.paused,
    };
  });
  const time = roomTime(billed, { firstHourMinimum: input.firstHourMinimum, step: input.step });

  const atClose = input.close !== null && Temporal.Instant.compare(now, input.close) >= 0;
  const someoneNext = input.nextNeedsRoomAt !== null;
  let tile: Tile;
  if (input.bookedEnd === null) tile = { kind: "walk_in" };
  else if (Temporal.Instant.compare(now, input.bookedEnd) < 0)
    tile = {
      kind: "in_room",
      minutesLeft: Math.ceil((input.bookedEnd.epochMilliseconds - now.epochMilliseconds) / 60_000),
    };
  else if (someoneNext)
    tile = { kind: "needed_now", minutesPast: minutesBetween(input.bookedEnd, now) };
  else tile = { kind: "staying", minutesPast: minutesBetween(input.bookedEnd, now) };

  const nearEnd =
    input.bookedEnd !== null &&
    Temporal.Instant.compare(now, input.bookedEnd.subtract({ minutes: input.noticeMin })) >= 0;
  const wrapUp = atClose || (someoneNext && nearEnd);
  const offersStop =
    input.close !== null &&
    Temporal.Instant.compare(
      now,
      input.close.subtract({ minutes: STAY_ON_STOPS_BEFORE_CLOSE_MIN }),
    ) >= 0;
  const stayOnOffer = input.stayOnWhenFree && !someoneNext && !offersStop && !atClose;
  return { minutes: time.elapsedMinutes, roomTimeCents: time.cents, tile, stayOnOffer, wrapUp };
}
