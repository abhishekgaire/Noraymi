import { emitEvent, readSetting, type Queryable } from "@west4/db";
import { businessDate } from "@west4/rules";
import type { Temporal } from "@west4/shared";
import { venueClock } from "./assignment.js";

/**
 * The headcount (M2-28; screens N31; spec 09 · Safety): open sessions' party
 * sizes, plus waiting parties, plus the door counter's +1s and −1s (M6 adds
 * people on bar tabs), against `safety.occupancyLimit`. With no limit set the
 * board says so and shows no number; with one, it warns at `warnAtPct`.
 */
export async function headcount(c: Queryable, venueId: string, now: Temporal.Instant) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(now, venue.timeZone, venue.dayCutover).businessDate;
  const counts = (
    await c.query<{ rooms: number; waiting: number; door: number }>(
      `select
         (select coalesce(sum(party_size), 0)::int from room_sessions where venue_id = $1 and ended_at is null and not training) as rooms,
         (select coalesce(sum(party_size), 0)::int from waitlist_entries
           where venue_id = $1 and status in ('waiting', 'offered')) as waiting,
         (select coalesce(sum(delta), 0)::int from door_counts where venue_id = $1 and business_date = $2) as door`,
      [venueId, date.toString()],
    )
  ).rows[0]!;
  const safety = await readSetting(c, venueId, "safety", date);
  const limit = safety?.value.occupancyLimit ?? null;
  const warnAtPct = safety?.value.warnAtPct ?? 90;
  const inside = Math.max(0, counts.rooms + counts.waiting + counts.door);
  return {
    business_date: date.toString(),
    inside,
    in_rooms: counts.rooms,
    waiting: counts.waiting,
    door: counts.door,
    limit,
    warn_at_pct: warnAtPct,
    // Whole people: the warning starts at the first person at or past the share (90 of 100).
    warn: limit !== null && inside >= Math.ceil((limit * warnAtPct) / 100),
  };
}

export async function countDoor(
  c: Queryable,
  venueId: string,
  input: { delta: 1 | -1; userId: string; deviceId: string | null; now: Temporal.Instant },
) {
  const venue = await venueClock(c, venueId);
  const date = businessDate(input.now, venue.timeZone, venue.dayCutover).businessDate;
  await c.query(
    `insert into door_counts (venue_id, business_date, delta, counted_by, device_id, at)
       values ($1, $2, $3, $4, $5, $6)`,
    [venueId, date.toString(), input.delta, input.userId, input.deviceId, input.now.toString()],
  );
  await emitEvent(c, { venueId, type: "headcount.updated", entityId: venueId, entityVersion: 0 });
  return headcount(c, venueId, input.now);
}
