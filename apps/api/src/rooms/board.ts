import { readSetting, roomNotes, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { availability, venueClock } from "./assignment.js";
import { openCalls } from "./calls.js";
import { headcount } from "./headcount.js";
import { sessionViews } from "./sessions.js";

/**
 * The Tonight board (M2-29; screens Board; spec 08 · `GET /board`): every
 * room's state and tile words in the glossary's terms, its party, ID chip,
 * deposit, clock, room time and tab so far, its open faults, notes and calls,
 * and the counts and the headcount. The words are data (a kind and numbers);
 * screens put them in their language.
 */
export type TileWords =
  | { kind: "in_room"; minutes_left: number }
  | { kind: "wrap_up"; minutes_left: number }
  | { kind: "staying"; minutes_past: number }
  | { kind: "needed_now"; minutes_past: number }
  | { kind: "walk_in" }
  | { kind: "cleaning"; left_at: string; minutes: number; flagged: boolean }
  | { kind: "held"; name: string; until: string }
  | { kind: "next"; at: string }
  | { kind: "free_all_night" }
  | { kind: "open" }
  | { kind: "out_of_service" };

export async function board(c: Queryable, venueId: string, now: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const [avail, sessions, notes, calls, count, alerts] = await Promise.all([
    availability(c, venueId, now),
    sessionViews(c, venueId, now),
    roomNotes(c, venueId),
    openCalls(c, venueId),
    headcount(c, venueId, now),
    readSetting(c, venueId, "alerts", date),
  ]);
  const noticeMin = alerts?.value.roomEndingMin ?? 10;
  const checkIds = sessions.map((s) => s.check_id).filter((x): x is string => !!x);
  const lines = new Map(
    (
      await c.query<{ check_id: string; cents: number }>(
        `select check_id, coalesce(sum(amount_cents), 0)::int as cents from check_lines
          where venue_id = $1 and check_id = any($2::uuid[]) group by check_id`,
        [venueId, checkIds],
      )
    ).rows.map((r) => [r.check_id, r.cents]),
  );
  const bookingIds = [
    ...sessions.map((s) => s.booking_id),
    ...avail.rooms.map((r) => (r.current?.kind === "booking" ? r.current.ref_id : null)),
  ].filter((x): x is string => !!x);
  const bookings = new Map(
    (
      await c.query<{
        id: string;
        guest_name: string;
        deposit_cents: number;
        running_late_until: string | null;
      }>(
        `select b.id, g.name as guest_name, b.deposit_cents, to_json(b.running_late_until) #>> '{}' as running_late_until
           from bookings b join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
          where b.venue_id = $1 and b.id = any($2::uuid[])`,
        [venueId, bookingIds],
      )
    ).rows.map((b) => [b.id, b]),
  );

  const rooms = avail.rooms.map((r) => {
    const s = sessions.find((x) => x.room_id === r.room_id);
    const booking = s?.booking_id ? bookings.get(s.booking_id) : undefined;
    let words: TileWords;
    let tone: "amber" | "red" | null = null;
    if (r.state === "out_of_service") words = { kind: "out_of_service" };
    else if (s) {
      const tile = s.clock.tile;
      if (tile.kind === "needed_now")
        words = { kind: "needed_now", minutes_past: tile.minutesPast };
      else if (tile.kind === "staying") words = { kind: "staying", minutes_past: tile.minutesPast };
      else if (tile.kind === "walk_in") words = { kind: "walk_in" };
      else
        words = s.clock.wrapUp
          ? { kind: "wrap_up", minutes_left: tile.minutesLeft }
          : { kind: "in_room", minutes_left: tile.minutesLeft };
      if (tile.kind === "needed_now" || tile.kind === "staying") tone = "red";
      else if (tile.kind === "in_room" && tile.minutesLeft <= noticeMin) tone = "amber";
    } else if (r.cleaning) words = { kind: "cleaning", ...r.cleaning };
    else if (r.current?.kind === "booking" && r.current.ref_id) {
      const b = bookings.get(r.current.ref_id);
      const until = b?.running_late_until ?? r.current.held_until;
      words = b && until ? { kind: "held", name: b.guest_name, until } : { kind: "open" };
    } else if (r.current?.kind === "hold") words = { kind: "open" };
    else if (r.free_now && r.all_night) words = { kind: "free_all_night" };
    else if (r.free_now && r.until) words = { kind: "next", at: r.until };
    else words = { kind: "open" };
    const roomTime = s?.clock.roomTimeCents ?? 0;
    return {
      room_id: r.room_id,
      name: r.name,
      state: r.state,
      words,
      tone,
      free_now: r.free_now,
      free_until: r.free_now ? r.until : null,
      tablet_on: r.tablet_on,
      session: s
        ? {
            id: s.id,
            check_id: s.check_id,
            guest_name: s.guest_name,
            party_size: s.party_size,
            ids_checked: s.ids_checked,
            minutes: s.clock.minutes,
            room_time_cents: roomTime,
            tab_so_far_cents: roomTime + (s.check_id ? (lines.get(s.check_id) ?? 0) : 0),
            deposit_cents: booking?.deposit_cents ?? 0,
            booked_end_at: s.booked_end_at,
            paused: s.segments.at(-1)?.paused ?? false,
          }
        : null,
      faults: r.faults,
      notes: notes.filter((n) => n.room_id === r.room_id).map((n) => ({ id: n.id, text: n.text })),
      calls: calls
        .filter((k) => k.room_id === r.room_id)
        .map((k) => ({ id: k.id, kind: k.kind, created_at: k.created_at })),
    };
  });

  const counts = {
    in_use: rooms.filter((r) => r.session).length,
    cleaning: rooms.filter((r) => !r.session && r.words.kind === "cleaning").length,
    out_of_service: rooms.filter((r) => r.words.kind === "out_of_service").length,
    open: 0,
  };
  counts.open = rooms.length - counts.in_use - counts.cleaning - counts.out_of_service;
  return { at: now.toString(), close: avail.close, rooms, counts, headcount: count };
}
