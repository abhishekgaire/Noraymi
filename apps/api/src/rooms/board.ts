import { readSetting, roomNotes, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { availability, venueClock } from "./assignment.js";
import { openCalls } from "./calls.js";
import { headcount } from "./headcount.js";
import { offerSuggestion, staffWaitlist } from "./waitlist.js";
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
  const [avail, sessions, notes, calls, count, alertSettings] = await Promise.all([
    availability(c, venueId, now),
    sessionViews(c, venueId, now),
    roomNotes(c, venueId),
    openCalls(c, venueId),
    headcount(c, venueId, now),
    readSetting(c, venueId, "alerts", date),
  ]);
  const noticeMin = alertSettings?.value.roomEndingMin ?? 10;
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
  const alerts = await boardAlerts(c, venueId, now, { rooms, sessions, calls, noticeMin });
  return { at: now.toString(), close: avail.close, rooms, counts, headcount: count, alerts };
}

/**
 * The alerts band (M2-30; Board note 3). Pink: a room past its end with a
 * booking next, then room calls; amber: a room near its end with a booking
 * next; lime: a free room for the first waiting party that fits; grey: rooms
 * that need a wipe while parties wait, then a guest who texted they're late.
 * Ordered by color, then that order of kinds, then oldest first (cautious
 * reading of the seed's order, flagged). Room-order alerts join in M3.
 */
const COLOR_ORDER = ["pink", "amber", "lime", "grey"] as const;
const KIND_ORDER = ["needed_now", "call", "near_end", "offer", "wipe", "late"] as const;

async function boardAlerts(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  ctx: {
    rooms: { room_id: string; name: string; words: TileWords }[];
    sessions: Awaited<ReturnType<typeof sessionViews>>;
    calls: Awaited<ReturnType<typeof openCalls>>;
    noticeMin: number;
  },
) {
  type Alert = {
    kind: (typeof KIND_ORDER)[number];
    color: (typeof COLOR_ORDER)[number];
    since: string;
  } & Record<string, unknown>;
  const out: Alert[] = [];
  const minutes = (from: string) =>
    Math.max(
      0,
      Math.floor((now.epochMilliseconds - Temporal.Instant.from(from).epochMilliseconds) / 60_000),
    );
  // The booking that needs a room next, for the past-end and near-end alerts.
  const nextBooking = async (roomId: string) =>
    (
      await c.query<{ id: string; name: string; party_size: number; starts_at: string }>(
        `select b.id, g.name, b.party_size, to_json(b.starts_at) #>> '{}' as starts_at
           from bookings b join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
          where b.venue_id = $1 and b.room_id = $2 and b.status in ('pending', 'confirmed') and b.starts_at > $3::timestamptz
          order by b.starts_at limit 1`,
        [venueId, roomId, now.toString()],
      )
    ).rows[0];
  for (const s of ctx.sessions) {
    const tile = s.clock.tile;
    if (tile.kind === "needed_now" || (tile.kind === "in_room" && s.clock.wrapUp)) {
      const next = await nextBooking(s.room_id);
      if (!next || !s.booked_end_at) continue;
      const base = {
        room_name: s.room_name,
        session_id: s.id,
        guest_name: s.guest_name,
        next: { name: next.name, party_size: next.party_size, at: next.starts_at },
      };
      if (tile.kind === "needed_now")
        out.push({
          kind: "needed_now",
          color: "pink",
          since: s.booked_end_at,
          ...base,
          minutes_past: tile.minutesPast,
        });
      else
        out.push({
          kind: "near_end",
          color: "amber",
          since: Temporal.Instant.from(s.booked_end_at)
            .subtract({ minutes: ctx.noticeMin })
            .toString(),
          ...base,
          minutes_left: tile.minutesLeft,
        });
    }
  }
  for (const k of ctx.calls)
    out.push({
      kind: "call",
      color: "pink",
      since: k.created_at,
      call_id: k.id,
      room_name: k.room_name,
      call: k.kind,
      minutes_ago: minutes(k.created_at),
    });
  const waiting = (await staffWaitlist(c, venueId, now)).filter((w) => w.status === "waiting");
  const suggestion = await offerSuggestion(c, venueId, now);
  if (suggestion) {
    const entry = waiting.find((w) => w.id === suggestion.entry_id);
    const room = ctx.rooms.find((r) => r.room_id === suggestion.room_id);
    out.push({
      kind: "offer",
      color: "lime",
      since: entry?.joined_at ?? now.toString(),
      entry_id: suggestion.entry_id,
      room_name: suggestion.room_name,
      name: suggestion.name,
      party_size: suggestion.party_size,
      waited_min: entry?.waited_min ?? 0,
      all_night: room?.words.kind === "free_all_night",
    });
  }
  const wiping = ctx.rooms.filter((r) => r.words.kind === "cleaning");
  const others = waiting.filter((w) => w.id !== suggestion?.entry_id);
  if (wiping.length > 0 && others.length > 0) {
    const left = wiping.map((r) => (r.words.kind === "cleaning" ? r.words : null)!);
    out.push({
      kind: "wipe",
      color: "grey",
      since: left.map((l) => l.left_at).sort()[0]!,
      rooms: wiping.map((r) => ({
        room_id: r.room_id,
        name: r.name,
        minutes: r.words.kind === "cleaning" ? r.words.minutes : 0,
      })),
      waiting: others.map((w) => w.name),
    });
  }
  // A guest who texted they're late: an arriving booking whose thread has their text tonight.
  const late = await c.query<{
    booking_id: string;
    conversation_id: string;
    name: string;
    room_name: string;
    starts_at: string;
    running_late_until: string | null;
    body: string;
    at: string;
  }>(
    `select distinct on (b.id) b.id as booking_id, cv.id as conversation_id, g.name, r.name as room_name,
            to_json(b.starts_at) #>> '{}' as starts_at, to_json(b.running_late_until) #>> '{}' as running_late_until,
            m.body, to_json(m.created_at) #>> '{}' as at
       from bookings b
       join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
       join rooms r on r.venue_id = b.venue_id and r.id = b.room_id
       join conversations cv on cv.venue_id = b.venue_id and cv.context_kind = 'booking' and cv.context_id = b.id
       join messages m on m.venue_id = cv.venue_id and m.conversation_id = cv.id and m.direction = 'inbound'
      where b.venue_id = $1 and b.status in ('pending', 'confirmed')
        and b.starts_at <= $2::timestamptz + interval '1 hour' and m.created_at >= $2::timestamptz - interval '6 hours'
      order by b.id, m.created_at desc`,
    [venueId, now.toString()],
  );
  for (const l of late.rows) {
    const grace = Temporal.Instant.from(l.starts_at).add({ minutes: 15 }).toString();
    const until = l.running_late_until ?? grace;
    out.push({
      kind: "late",
      color: "grey",
      since: until,
      booking_id: l.booking_id,
      conversation_id: l.conversation_id,
      name: l.name,
      text: l.body,
      starts_at: l.starts_at,
      room_name: l.room_name,
      held_until: until,
      no_show_ok: Temporal.Instant.compare(now, Temporal.Instant.from(until)) >= 0,
    });
  }
  return out.sort(
    (a, b) =>
      COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      Temporal.Instant.compare(Temporal.Instant.from(a.since), Temporal.Instant.from(b.since)),
  );
}
