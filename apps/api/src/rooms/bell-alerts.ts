import { statesOf, venueModules, type Queryable } from "@west4/db";
import { stateOf, type Temporal } from "@west4/shared";
import { lateArrivals } from "./board.js";
import { openCalls } from "./calls.js";
import { sessionViews } from "./sessions.js";
import { offerSuggestion } from "./waitlist.js";

/**
 * The bell's room lines (U-18; spec 10 · rule 14): what the bell shows about the rooms, read on
 * its own instead of the whole board (the board's tiles, tabs and headcount doubled the board's
 * load on every screen). Each line names its room, so a tap opens that room's panel:
 *   time_up  a room past its end (the tile is red), in the tile's words: Staying · 41 min past,
 *            or Needed now · 11 min past when someone is booked next
 *   call     a room calling for staff, until someone taps On it
 *   offer    a free room for the first party on the waitlist that fits
 *   late     an arriving party that texted they're running late
 * No guest's name or words: the bell's list is kept on a shared computer for offline.
 * Null while Rooms is off.
 */
export type BellRoomLine =
  | {
      kind: "time_up";
      room_id: string;
      room_name: string;
      session_id: string;
      words: { kind: "staying" | "needed_now"; minutes_past: number };
    }
  | {
      kind: "call";
      room_id: string;
      room_name: string;
      call_id: string;
      call: string;
    }
  | { kind: "offer"; room_id: string; room_name: string; entry_id: string }
  | { kind: "late"; room_id: string; room_name: string; booking_id: string };

export async function bellRoomLines(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  /** A screen in training also sees practice sessions (M7-03), as on the board. */
  training = false,
): Promise<BellRoomLine[] | null> {
  if (stateOf(statesOf(await venueModules(c, venueId)), "rooms") === "off") return null;
  const [sessions, calls, offer, late] = await Promise.all([
    sessionViews(c, venueId, now, undefined, training),
    openCalls(c, venueId),
    offerSuggestion(c, venueId, now),
    lateArrivals(c, venueId, now),
  ]);
  const out: BellRoomLine[] = [];
  // The board's order: rooms past their end first, then calls, then the waitlist, then late guests.
  for (const s of sessions) {
    const tile = s.clock.tile;
    if (tile.kind !== "needed_now" && tile.kind !== "staying") continue;
    out.push({
      kind: "time_up",
      room_id: s.room_id,
      room_name: s.room_name,
      session_id: s.id,
      words: { kind: tile.kind, minutes_past: tile.minutesPast },
    });
  }
  // Needed now (someone is booked next) before Staying, then the longest past first.
  const rank = (l: BellRoomLine) => (l.kind === "time_up" && l.words.kind === "needed_now" ? 0 : 1);
  const past = (l: BellRoomLine) => (l.kind === "time_up" ? l.words.minutes_past : 0);
  out.sort((a, b) => rank(a) - rank(b) || past(b) - past(a));
  for (const k of calls)
    out.push({
      kind: "call",
      room_id: k.room_id,
      room_name: k.room_name,
      call_id: k.id,
      call: k.kind,
    });
  if (offer)
    out.push({
      kind: "offer",
      room_id: offer.room_id,
      room_name: offer.room_name,
      entry_id: offer.entry_id,
    });
  for (const l of late)
    out.push({
      kind: "late",
      room_id: l.room_id,
      room_name: l.room_name,
      booking_id: l.booking_id,
    });
  return out;
}
