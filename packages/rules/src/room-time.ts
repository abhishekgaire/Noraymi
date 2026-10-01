import type { Temporal } from "@west4/shared";
import { cents, type Cents } from "@west4/shared";

/**
 * Room time (M2-01; spec 05 · rule 3). A session bills from its segments: a
 * party-size change, a time band, a move or a pause closes one and opens the
 * next, on the minute. The session bills round(Σ hourly_cents × minutes / 60)
 * over every segment, rounded once, never per segment. A paused segment bills
 * nothing. The first-hour minimum applies once per session: shorter than an
 * hour, it's topped up to 60 minutes at its first segment's rate.
 */
export interface Segment {
  /** Whole minutes, taken on the server's clock. */
  readonly minutes: number;
  readonly hourlyCents: Cents;
  readonly paused?: boolean;
}

export interface RoomTime {
  readonly cents: Cents;
  /** The minutes charged, including the first hour's top-up. */
  readonly billedMinutes: number;
  /** The minutes the party actually had, pauses left out. */
  readonly elapsedMinutes: number;
}

const wholeMinutes = (minutes: number): number => {
  if (!Number.isInteger(minutes) || minutes < 0)
    throw new Error(`a segment is whole minutes, not ${minutes}`);
  return minutes;
};

/** The billing step (spec 05 · rule 3): minutes after the first hour rounded to the step by the rule. */
export interface BillingStep {
  readonly incrementMin: 1 | 15 | 30 | 60;
  readonly rounding: "up" | "nearest" | "down";
}

export function roundToStep(minutes: number, step: BillingStep): number {
  if (step.incrementMin === 1) return minutes;
  const steps = minutes / step.incrementMin;
  const whole =
    step.rounding === "up"
      ? Math.ceil(steps)
      : step.rounding === "down"
        ? Math.floor(steps)
        : Math.floor(steps + 0.5); // nearest, half up
  return whole * step.incrementMin;
}

export function roomTime(
  segments: readonly Segment[],
  options: {
    readonly firstHourMinimum: boolean;
    /** The step and rule of the band the session ends in; the minutes added or taken off bill at the last segment's rate. */
    readonly step?: BillingStep | undefined;
  },
): RoomTime {
  const billed = segments.filter((s) => !s.paused);
  for (const s of segments) wholeMinutes(s.minutes);
  let minutes = 0;
  let weighted = 0; // Σ hourly_cents × minutes, kept exact until the one rounding
  for (const s of billed) {
    minutes += s.minutes;
    weighted += s.hourlyCents * s.minutes;
  }
  const elapsedMinutes = minutes;
  const first = billed[0];
  if (options.firstHourMinimum && first && minutes < 60) {
    weighted += first.hourlyCents * (60 - minutes);
    minutes = 60;
  }
  const last = billed.at(-1);
  if (options.step && options.step.incrementMin > 1 && last && minutes > 60) {
    const after = minutes - 60;
    const delta = roundToStep(after, options.step) - after;
    weighted += last.hourlyCents * delta;
    minutes += delta;
  }
  return {
    cents: cents(Math.floor((weighted + 30) / 60)),
    billedMinutes: minutes,
    elapsedMinutes,
  };
}

/**
 * Real elapsed minutes between two instants, never clock times subtracted:
 * the fall-back night has 60 more of them and the spring-forward night 60
 * fewer. A part minute is taken down to the whole minute (M2-01's note).
 */
export function roomTimeBetween(
  start: Temporal.Instant,
  end: Temporal.Instant,
  hourlyCents: Cents,
): { minutes: number; cents: Cents } {
  const ms = end.epochMilliseconds - start.epochMilliseconds;
  if (ms < 0) throw new Error("a segment can't end before it started");
  const minutes = Math.floor(ms / 60_000);
  return {
    minutes,
    cents: roomTime([{ minutes, hourlyCents }], { firstHourMinimum: false }).cents,
  };
}
