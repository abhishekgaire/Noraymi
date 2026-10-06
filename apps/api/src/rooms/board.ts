import { failedTickets, readSetting, roomNotes, type Queryable } from "@west4/db";
import { managerOnDutyAt } from "../approvals/service.js";
import { agingFor, secondsSince } from "../orders/escalation.js";
import { barLostSince, venueOpenNow } from "./bar-presence.js";
import { alcoholNow } from "../orders/alcohol.js";
import { clearOutFor } from "./clear-out.js";
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

export async function board(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
  /** A screen in training also sees practice sessions (M7-03); a live screen never does. */
  training = false,
) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const [avail, sessions, notes, calls, count, alertSettings] = await Promise.all([
    availability(c, venueId, now),
    sessionViews(c, venueId, now, undefined, training),
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
  // Minimum spend (Money rules 6; M4-27; off at West 4): each session's minimum, and its check's spend
  // toward it (items and songs after comps and voids).
  const minimums = new Map(
    (
      await c.query<{ check_id: string; min: number | null; spend: number }>(
        `select s.check_id, s.min_spend_cents as min,
                coalesce((select sum(l.amount_cents) from check_lines l
                           where l.venue_id = s.venue_id and l.check_id = s.check_id
                             and l.kind in ('item', 'song', 'comp', 'void', 'transfer_in', 'transfer_out')), 0)::int as spend
           from room_sessions s
          where s.venue_id = $1 and s.check_id = any($2::uuid[]) and s.min_spend_cents is not null`,
        [venueId, checkIds],
      )
    ).rows.map((r) => [r.check_id, r]),
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

  // Each room's next booking tonight: the wrap-up prompt's "Jae & co. at 11:00".
  const nextBookings = new Map(
    (
      await c.query<{ room_id: string; name: string; party_size: number; starts_at: string }>(
        `select distinct on (b.room_id) b.room_id, g.name, b.party_size, to_json(b.starts_at) #>> '{}' as starts_at
           from bookings b join guests g on g.venue_id = b.venue_id and g.id = b.guest_id
          where b.venue_id = $1 and b.status in ('pending', 'confirmed') and b.starts_at > $2::timestamptz
            and b.starts_at < $3::timestamptz
          order by b.room_id, b.starts_at`,
        [venueId, now.toString(), avail.close ?? now.add({ hours: 12 }).toString()],
      )
    ).rows.map((b) => [b.room_id, { name: b.name, party_size: b.party_size, at: b.starts_at }]),
  );
  const rooms = avail.rooms.map((r) => {
    const s =
      sessions.find((x) => x.room_id === r.room_id && !x.training) ??
      sessions.find((x) => x.room_id === r.room_id);
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
            /** A practice session (M7-03): only a screen in training gets one. */
            training: s.training,
            started_at: s.started_at,
            guest_name: s.guest_name,
            party_size: s.party_size,
            ids_checked: s.ids_checked,
            minutes: s.clock.minutes,
            room_time_cents: roomTime,
            tab_so_far_cents: roomTime + (s.check_id ? (lines.get(s.check_id) ?? 0) : 0),
            min_spend_left_cents: (() => {
              const m = s.check_id ? minimums.get(s.check_id) : undefined;
              return m?.min ? Math.max(0, m.min - m.spend) : null;
            })(),
            deposit_cents: booking?.deposit_cents ?? 0,
            booked_end_at: s.booked_end_at,
            paused: s.segments.at(-1)?.paused ?? false,
            hourly_cents: s.segments.at(-1)?.hourly_cents ?? 0,
            stay_on_offer: s.clock.stayOnOffer,
            wrap_up: s.clock.wrapUp,
            close: s.close,
            cut_off: s.alcohol_cut_off_at
              ? {
                  at: s.alcohol_cut_off_at,
                  by: s.alcohol_cut_off_by_name,
                  reason: s.alcohol_cut_off_reason,
                }
              : null,
          }
        : null,
      next: nextBookings.get(r.room_id) ?? null,
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
  // Room tablets online: paired, not revoked, and not flagged offline by the device watch (M1-17).
  const tablets = (
    await c.query<{ total: number; online: number }>(
      `select count(*)::int as total,
              count(*) filter (where h.device_id is not null and h.offline_since is null)::int as online
         from devices d left join device_heartbeats h on h.venue_id = d.venue_id and h.device_id = d.id
        where d.venue_id = $1 and d.kind = 'room_tablet' and d.revoked_at is null`,
      [venueId],
    )
  ).rows[0]!;
  const alerts = await boardAlerts(c, venueId, now, { rooms, sessions, calls, noticeMin });
  return {
    at: now.toString(),
    close: avail.close,
    rooms,
    counts: { ...counts, tablets_online: tablets.online, tablets: tablets.total },
    headcount: count,
    alerts,
    // The alcohol window now and when it next changes, so every screen greys alcohol together (M3-20).
    alcohol: await alcoholNow(c, venueId, now),
  };
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
const KIND_ORDER = [
  "no_bar",
  "clear_out",
  "needed_now",
  "call",
  "order",
  "ticket",
  "near_end",
  "code",
  "offer",
  "wipe",
  "late",
] as const;

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
  // The clear-out check (M3-23): amber while it waits, grey once done, for tonight's business date.
  const v = await venueClock(c, venueId);
  const clear = await clearOutFor(
    c,
    venueId,
    businessDate(now, v.timeZone, v.dayCutover).businessDate.toString(),
  );
  if (clear)
    out.push(
      clear.done_at
        ? {
            kind: "clear_out",
            color: "grey",
            since: clear.done_at,
            done: true,
            done_at: clear.done_at,
            done_by: clear.done_by_name,
            business_date: clear.business_date,
          }
        : {
            kind: "clear_out",
            color: "amber",
            since: clear.due_at,
            done: false,
            business_date: clear.business_date,
          },
    );

  // No bar device connected during opening hours (M3-17): pink, first, until one connects.
  const lost = await barLostSince(c, venueId);
  if (lost && (await venueOpenNow(c, venueId, now)))
    out.push({ kind: "no_bar", color: "pink", since: lost, lost_at: lost });

  // Room orders nobody has accepted (M3-16): amber from 2 minutes, pink from 4, saying who was told.
  const aging = await agingFor(c, venueId, now);
  const waitingOrders = await c.query<{
    id: string;
    status: string;
    placed_at: string;
    escalation_level: number;
    room_name: string | null;
    items: string | null;
  }>(
    `select o.id, o.status, to_json(o.placed_at) #>> '{}' as placed_at, o.escalation_level, r.name as room_name,
            (select string_agg(i.qty || ' × ' || i.name_snapshot, ', ' order by i.sort)
               from order_items i where i.venue_id = o.venue_id and i.order_id = o.id) as items
       from orders o
       left join room_sessions s on s.venue_id = o.venue_id and s.id = o.session_id
       left join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where o.venue_id = $1 and o.status in ('ringing', 'held') order by o.placed_at`,
    [venueId],
  );
  let managerName: string | null | undefined;
  for (const o of waitingOrders.rows) {
    const age = secondsSince(o.placed_at, now);
    if (age < aging.amberSec) continue;
    if (managerName === undefined && o.escalation_level >= 3) {
      const m = await managerOnDutyAt(c, venueId, now);
      managerName = m
        ? ((
            await c.query<{ name: string }>(
              "select split_part(name, ' ', 1) as name from users where id = $1",
              [m],
            )
          ).rows[0]?.name ?? null)
        : null;
    }
    out.push({
      kind: "order",
      color: age >= aging.pinkSec ? "pink" : "amber",
      since: o.placed_at,
      order_id: o.id,
      status: o.status,
      room_name: o.room_name,
      items: o.items,
      age_sec: age,
      told: o.escalation_level >= 4 ? "texted" : o.escalation_level >= 3 ? "phone" : null,
      manager: managerName ?? null,
    });
  }

  // A ticket that didn't print (M3-13): pink until someone reprints it.
  for (const j of await failedTickets(c, venueId, now.toString()))
    out.push({
      kind: "ticket",
      color: "pink",
      since: j.failed_at,
      job_id: j.id,
      room_name: j.room_name,
      reprint_n: j.reprint_n,
    });
  // Ten wrong room codes rotated a room's code (M3-08): amber for half an hour.
  const rotated = await c.query<{ session_id: string; room_name: string; at: string }>(
    `select s.id as session_id, r.name as room_name, to_json(s.code_alert_at) #>> '{}' as at
       from room_sessions s join rooms r on r.venue_id = s.venue_id and r.id = s.room_id
      where s.venue_id = $1 and s.ended_at is null and s.code_alert_at > $2::timestamptz - interval '30 minutes'`,
    [venueId, now.toString()],
  );
  for (const k of rotated.rows)
    out.push({
      kind: "code",
      color: "amber",
      since: k.at,
      session_id: k.session_id,
      room_name: k.room_name,
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
