import { Temporal } from "@west4/shared";
import { parseCutover } from "./time.js";

/**
 * The booking grid (M2-06; spec 05 · rule 2). Start times are walked in real
 * time, 30 minutes apart, from the night's opening to the last start that
 * still ends by the close, so the fall-back night offers both 1:00 AMs (EDT,
 * then EST) and the spring-forward night skips 2:00 to 2:59 AM, which don't
 * exist. A venue's own start slots (prices.booking.startSlots, "HH:MM") narrow
 * the grid; with none set, every half hour is offered.
 */
export interface GridSlot {
  readonly start: Temporal.Instant;
  /** The wall clock, "01:00". */
  readonly time: string;
  /** The zone's short name at that instant, "EDT" or "EST", so the repeated hour reads apart. */
  readonly zone: string;
  /** The UTC offset, "-04:00", which a booking sends back to pick one of the two 1:00 AMs. */
  readonly offset: string;
}

export const GRID_STEP_MIN = 30;

export function zoneName(at: Temporal.Instant, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(
    new Date(at.epochMilliseconds),
  );
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

export function bookingGrid(input: {
  readonly opens: Temporal.Instant;
  readonly closes: Temporal.Instant;
  readonly minHours: number;
  readonly startSlots: readonly string[];
  readonly timeZone: string;
}): GridSlot[] {
  const last = input.closes.subtract({ minutes: Math.round(input.minHours * 60) });
  const out: GridSlot[] = [];
  for (
    let at = input.opens;
    Temporal.Instant.compare(at, last) <= 0;
    at = at.add({ minutes: GRID_STEP_MIN })
  ) {
    const z = at.toZonedDateTimeISO(input.timeZone);
    const time = `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
    if (input.startSlots.length > 0 && !input.startSlots.includes(time)) continue;
    out.push({ start: at, time, zone: zoneName(at, input.timeZone), offset: z.offset });
  }
  return out;
}

export type StartRefusal = "not_a_time" | "does_not_exist" | "ambiguous";

/**
 * A wall-clock start on a business date as an instant. A time before the
 * cutover is the next calendar day. A time the clocks skip is refused; a time
 * that happens twice needs its offset ("-04:00" for the EDT one).
 */
export function resolveStart(
  businessDate: Temporal.PlainDate,
  time: string,
  timeZone: string,
  cutover: string,
  offset?: string,
): { start: Temporal.Instant } | { refused: StartRefusal } {
  let at: Temporal.PlainTime;
  try {
    at = parseCutover(time);
  } catch {
    return { refused: "not_a_time" };
  }
  const day =
    Temporal.PlainTime.compare(at, parseCutover(cutover)) < 0
      ? businessDate.add({ days: 1 })
      : businessDate;
  const wall = day.toPlainDateTime(at);
  const earlier = wall.toZonedDateTime(timeZone, { disambiguation: "earlier" });
  const later = wall.toZonedDateTime(timeZone, { disambiguation: "later" });
  if (!earlier.toPlainDateTime().equals(wall)) return { refused: "does_not_exist" };
  if (earlier.equals(later)) {
    if (offset !== undefined && offset !== earlier.offset) return { refused: "does_not_exist" };
    return { start: earlier.toInstant() };
  }
  if (offset === earlier.offset) return { start: earlier.toInstant() };
  if (offset === later.offset) return { start: later.toInstant() };
  return { refused: "ambiguous" };
}
