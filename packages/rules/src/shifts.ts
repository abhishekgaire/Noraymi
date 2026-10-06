import { Temporal } from "@west4/shared";

/**
 * The time clock (M7-01; spec 05 rule 2, spec 04 · shifts). A shift runs from
 * a clock-in to its clock-out; its minutes are elapsed time minus breaks,
 * never wall-clock subtraction, so the two daylight-saving nights count right
 * (4:00 PM to 4:30 AM is 810 minutes on the fall-back night and 690 on the
 * spring-forward night).
 */
export type PunchKind = "clock_in" | "clock_out" | "break_start" | "break_end";
export const PUNCH_KINDS: readonly PunchKind[] = [
  "clock_in",
  "clock_out",
  "break_start",
  "break_end",
];

export type Duty = "bar" | "front_desk" | "runner" | "manager";
export const DUTIES: readonly Duty[] = ["bar", "front_desk", "runner", "manager"];

export interface Punch {
  readonly kind: PunchKind;
  readonly at: Temporal.Instant | string;
}

export interface ShiftMinutes {
  readonly startedAt: Temporal.Instant;
  /** The clock-out, or null while the shift is open. */
  readonly endedAt: Temporal.Instant | null;
  /** Whole minutes worked: clock-in to clock-out (or `until` while open), minus breaks. */
  readonly workedMinutes: number;
  /** Whole minutes of breaks, an open break counted up to the end. */
  readonly breakMinutes: number;
  /** Whole minutes of breaks that have ended: what `shifts.break_minutes` stores. */
  readonly closedBreakMinutes: number;
  /** When the break that hasn't ended started, or null. */
  readonly breakStartedAt: Temporal.Instant | null;
}

const MINUTE_MS = 60_000;
const ms = (at: Temporal.Instant | string) =>
  (typeof at === "string" ? Temporal.Instant.from(at) : at).epochMilliseconds;

/** One person's punches, oldest first, split into shifts: each starts at a clock-in. */
export function splitShifts<P extends Punch>(punches: readonly P[]): P[][] {
  const sorted = [...punches].sort((a, b) => ms(a.at) - ms(b.at));
  const shifts: P[][] = [];
  for (const p of sorted) {
    if (p.kind === "clock_in") shifts.push([p]);
    else if (shifts.length > 0 && shifts.at(-1)!.at(-1)!.kind !== "clock_out")
      shifts.at(-1)!.push(p);
  }
  return shifts;
}

/**
 * One shift's minutes from its punches (the first must be its clock-in).
 * While the shift is open, it counts up to `until` (the venue's clock now),
 * or to its last punch when no `until` is given.
 */
export function shiftMinutes(
  punches: readonly Punch[],
  until?: Temporal.Instant | string,
): ShiftMinutes {
  const sorted = [...punches].sort((a, b) => ms(a.at) - ms(b.at));
  const first = sorted[0];
  if (!first || first.kind !== "clock_in") throw new Error("a shift starts with its clock-in");
  const start = ms(first.at);
  let end: number | null = null;
  let breakOpen: number | null = null;
  let closedBreakMs = 0;
  for (const p of sorted.slice(1)) {
    const at = ms(p.at);
    if (p.kind === "clock_in") break;
    if (p.kind === "break_start" && breakOpen === null) breakOpen = Math.max(at, start);
    else if (p.kind === "break_end" && breakOpen !== null) {
      closedBreakMs += Math.max(0, at - breakOpen);
      breakOpen = null;
    } else if (p.kind === "clock_out") {
      end = at;
      break;
    }
  }
  const last = ms(sorted.at(-1)!.at);
  const upTo = end ?? (until !== undefined ? Math.max(ms(until), start) : last);
  // A break still open at clock-out ends with the shift.
  const openBreakMs = breakOpen === null ? 0 : Math.max(0, upTo - breakOpen);
  const breakMs = closedBreakMs + openBreakMs;
  const elapsed = Math.max(0, upTo - start);
  return {
    startedAt: Temporal.Instant.fromEpochMilliseconds(start),
    endedAt: end === null ? null : Temporal.Instant.fromEpochMilliseconds(end),
    workedMinutes: Math.floor(Math.max(0, elapsed - breakMs) / MINUTE_MS),
    breakMinutes: Math.floor(breakMs / MINUTE_MS),
    closedBreakMinutes: Math.floor((end === null ? closedBreakMs : breakMs) / MINUTE_MS),
    breakStartedAt:
      end === null && breakOpen !== null ? Temporal.Instant.fromEpochMilliseconds(breakOpen) : null,
  };
}

/** Which duties a role may pick at clock-in. Cautious default (M7-01): Manager only for owners and managers. */
export function dutiesFor(role: string): readonly Duty[] {
  return role === "owner" || role === "manager" ? DUTIES : DUTIES.filter((d) => d !== "manager");
}
