import { businessDate, shiftMinutes, type Duty, type PunchKind } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { emitEvent } from "./events.js";
import type { Queryable } from "./tenancy.js";

/**
 * The time clock (M7-01; spec 04 · time_punches and shifts). Every punch is
 * written here, and the shift it belongs to is rebuilt from its punches in the
 * same transaction: one row per clock-in to clock-out, its business date the
 * clock-in's, its break minutes the breaks that have ended. A person has one
 * open shift; the partial unique index backs the check below.
 */
export interface VenueTime {
  readonly timeZone: string;
  readonly dayCutover: string;
}

export interface ShiftPunch {
  readonly id: string;
  readonly kind: PunchKind;
  readonly duty: Duty | null;
  readonly at: string;
}

export interface ShiftRow {
  readonly id: string;
  readonly membership_id: string;
  readonly business_date: string;
  readonly duty: Duty;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly break_minutes: number;
  /** The break that hasn't ended, or null. */
  readonly break_started_at: string | null;
  /** This shift's punches, oldest first, for the screens' "so far". */
  readonly punches: readonly ShiftPunch[];
}

export type ShiftRefusal = "already_on" | "not_on" | "on_break" | "not_on_break" | "no_duty";

export class ShiftError extends Error {
  constructor(
    readonly refusal: ShiftRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ShiftError";
  }
}

/** Instants as Temporal writes them ("2026-09-25T20:00:00Z"), whatever Postgres printed. */
const iso = (at: string): string => Temporal.Instant.from(at).toString();

const PUNCH_COLS = `id, kind, duty, to_json(at) #>> '{}' as at`;

/**
 * The punches of the shift that starts at a clock-in: from it, in the order
 * they were written, up to its clock-out or the next clock-in. Punches at the
 * same instant (a frozen demo clock, or a clock-out during a break) keep
 * their written order through `created_at`, stamped with clock_timestamp().
 */
async function punchesOf(
  c: Queryable,
  venueId: string,
  clockIn: { membership_id: string; id: string },
): Promise<ShiftPunch[]> {
  const r = await c.query<ShiftPunch>(
    `select ${PUNCH_COLS} from time_punches p
      where p.venue_id = $1 and p.membership_id = $2
        and (p.at, p.created_at) >= (select s.at, s.created_at from time_punches s where s.venue_id = $1 and s.id = $3)
      order by p.at, p.created_at
      limit 500`,
    [venueId, clockIn.membership_id, clockIn.id],
  );
  const out: ShiftPunch[] = [];
  for (const row of r.rows) {
    const p = { ...row, at: iso(row.at) };
    if (out.length === 0 && p.id !== clockIn.id) continue;
    if (out.length > 0 && p.kind === "clock_in") break;
    out.push(p);
    if (p.kind === "clock_out") break;
  }
  return out;
}

/** Rebuild one shift from its punches (and write it, new or not). */
export async function rebuildShift(
  c: Queryable,
  venueId: string,
  clockInPunchId: string,
  venue: VenueTime,
): Promise<ShiftRow> {
  const clockIn = (
    await c.query<{ membership_id: string; at: string; duty: Duty | null }>(
      `select membership_id, to_json(at) #>> '{}' as at, duty from time_punches
        where venue_id = $1 and id = $2 and kind = 'clock_in'`,
      [venueId, clockInPunchId],
    )
  ).rows[0];
  if (!clockIn) throw new Error(`no clock-in ${clockInPunchId}`);
  const mine = await punchesOf(c, venueId, {
    membership_id: clockIn.membership_id,
    id: clockInPunchId,
  });
  const minutes = shiftMinutes(mine);
  const date = businessDate(clockIn.at, venue.timeZone, venue.dayCutover).businessDate.toString();
  const r = await c.query<{ id: string }>(
    `insert into shifts (venue_id, membership_id, clock_in_punch_id, business_date, duty, started_at, ended_at, break_minutes)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (venue_id, clock_in_punch_id) do update
       set business_date = excluded.business_date, duty = excluded.duty, started_at = excluded.started_at,
           ended_at = excluded.ended_at, break_minutes = excluded.break_minutes, updated_at = now()
     returning id`,
    [
      venueId,
      clockIn.membership_id,
      clockInPunchId,
      date,
      clockIn.duty ?? "bar",
      clockIn.at,
      minutes.endedAt?.toString() ?? null,
      minutes.closedBreakMinutes,
    ],
  );
  return {
    id: r.rows[0]!.id,
    membership_id: clockIn.membership_id,
    business_date: date,
    duty: clockIn.duty ?? "bar",
    started_at: iso(clockIn.at),
    ended_at: minutes.endedAt?.toString() ?? null,
    break_minutes: minutes.closedBreakMinutes,
    break_started_at: minutes.breakStartedAt?.toString() ?? null,
    punches: mine,
  };
}

/** A person's open shift, rebuilt view included, or null when they're not on the clock. */
export async function openShiftOf(
  c: Queryable,
  venueId: string,
  membershipId: string,
): Promise<ShiftRow | null> {
  return (await openShifts(c, venueId, membershipId))[0] ?? null;
}

/** Everyone on the clock (or one person), with each shift's punches. */
export async function openShifts(
  c: Queryable,
  venueId: string,
  membershipId?: string,
): Promise<ShiftRow[]> {
  const r = await c.query<
    Omit<ShiftRow, "punches" | "break_started_at"> & { clock_in_punch_id: string }
  >(
    `select id, membership_id, business_date::text, duty, to_json(started_at) #>> '{}' as started_at,
            to_json(ended_at) #>> '{}' as ended_at, break_minutes, clock_in_punch_id
       from shifts where venue_id = $1 and ended_at is null and ($2::uuid is null or membership_id = $2)
      order by started_at`,
    [venueId, membershipId ?? null],
  );
  const out: ShiftRow[] = [];
  for (const s of r.rows) {
    const punches = await punchesOf(c, venueId, {
      membership_id: s.membership_id,
      id: s.clock_in_punch_id,
    });
    const minutes = shiftMinutes(punches);
    out.push({
      id: s.id,
      membership_id: s.membership_id,
      business_date: s.business_date,
      duty: s.duty,
      ended_at: s.ended_at,
      break_minutes: s.break_minutes,
      started_at: iso(s.started_at),
      punches,
      break_started_at: minutes.breakStartedAt?.toString() ?? null,
    });
  }
  return out;
}

/**
 * Write one punch, refusing what the clock can't do: a second clock-in while
 * a shift is open, a break or clock-out off the clock, a break inside a break.
 * Clocking out during a break ends the break first, at the same instant.
 */
export async function recordPunch(
  c: Queryable,
  input: {
    readonly venueId: string;
    readonly membershipId: string;
    readonly kind: PunchKind;
    readonly duty?: Duty;
    readonly at: Temporal.Instant;
    readonly deviceId?: string | null;
    readonly venue: VenueTime;
  },
): Promise<ShiftRow> {
  const { venueId, membershipId } = input;
  // One punch per person at a time: two screens can't open two shifts.
  await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`punch:${membershipId}`]);
  const open = await openShiftOf(c, venueId, membershipId);
  const onBreak = open?.break_started_at != null;
  if (input.kind === "clock_in") {
    if (!input.duty) throw new ShiftError("no_duty", "clock-in needs a duty");
    if (open) throw new ShiftError("already_on", "already on the clock");
  } else if (!open) throw new ShiftError("not_on", "not on the clock");
  else if (input.kind === "break_start" && onBreak)
    throw new ShiftError("on_break", "already on a break");
  else if (input.kind === "break_end" && !onBreak)
    throw new ShiftError("not_on_break", "not on a break");

  const insert = async (kind: PunchKind, duty: Duty | null) =>
    (
      await c.query<{ id: string }>(
        `insert into time_punches (venue_id, membership_id, kind, duty, at, device_id, created_at)
         values ($1, $2, $3, $4, $5, $6, clock_timestamp()) returning id`,
        [venueId, membershipId, kind, duty, input.at.toString(), input.deviceId ?? null],
      )
    ).rows[0]!.id;

  if (input.kind === "clock_out" && onBreak) await insert("break_end", open!.duty);
  const id = await insert(input.kind, input.kind === "clock_in" ? input.duty! : open!.duty);
  const clockInId =
    input.kind === "clock_in"
      ? id
      : (
          await c.query<{ clock_in_punch_id: string }>(
            "select clock_in_punch_id from shifts where venue_id = $1 and id = $2",
            [venueId, open!.id],
          )
        ).rows[0]!.clock_in_punch_id;
  const shift = await rebuildShift(c, venueId, clockInId, input.venue);
  await emitEvent(c, { venueId, type: "shift.updated", entityId: shift.id });
  return shift;
}
