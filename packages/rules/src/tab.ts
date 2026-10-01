import { Temporal, cents, type Cents } from "@west4/shared";
import { roomTime, roomTimeBetween, type Segment } from "./room-time.js";

/**
 * Tab so far (M2-02; glossary): room time so far plus the check's lines so
 * far, before tax and gratuity. The lines are what's on the check: accepted
 * drinks, comps and voids, a damage fee. A ringing order isn't a line yet, so
 * it isn't counted (M2-02's note).
 */
export interface TabLine {
  readonly qty: number;
  readonly unitCents: Cents;
}

export interface SessionSoFar {
  /** Closed segments, whole minutes each. */
  readonly segments: readonly Segment[];
  /** The segment still running, billed to `at`. */
  readonly open?: { readonly startedAt: Temporal.Instant; readonly hourlyCents: Cents } | undefined;
  readonly firstHourMinimum: boolean;
}

export interface TabSoFar {
  readonly minutes: number;
  readonly roomTimeCents: Cents;
  readonly linesCents: Cents;
  readonly tabSoFarCents: Cents;
}

export function tabSoFar(
  session: SessionSoFar,
  lines: readonly TabLine[],
  at: Temporal.Instant,
): TabSoFar {
  const segments: Segment[] = [...session.segments];
  if (session.open) {
    const minutes = roomTimeBetween(session.open.startedAt, at, session.open.hourlyCents).minutes;
    segments.push({ minutes, hourlyCents: session.open.hourlyCents });
  }
  const time = roomTime(segments, { firstHourMinimum: session.firstHourMinimum });
  const linesCents = cents(lines.reduce((sum, l) => sum + l.qty * l.unitCents, 0));
  return {
    minutes: time.elapsedMinutes,
    roomTimeCents: time.cents,
    linesCents,
    tabSoFarCents: cents(time.cents + linesCents),
  };
}
