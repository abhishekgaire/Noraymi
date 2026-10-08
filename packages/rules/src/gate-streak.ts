import { Temporal } from "@west4/shared";

/**
 * The gate's count (M9-17; milestones · the go-live gate, item 5, and Estimate): 4 weeks of live nights
 * without a money error. Each night's latest morning audit says clean or not; a money error starts
 * the 4 weeks again from the night after it. The 4 weeks are 28 calendar days from the first clean
 * night of the run, with every night the venue opened in them audited clean; a night with money but
 * no audit yet holds the count (it's neither clean nor an error until audited).
 */
export const GATE_DAYS = 28;

export interface AuditedNight {
  readonly night: string;
  readonly ok: boolean;
}

export interface GateStreak {
  /** Live nights audited clean since the last money error (or since the first live night). */
  readonly cleanNights: number;
  /** The first night of the current run, or null before any clean night. */
  readonly runStartedOn: string | null;
  /** The night of the last money error, or null when there's been none. */
  readonly lastErrorOn: string | null;
  /** Calendar days from the run's first night to the last audited night, inclusive. */
  readonly daysInRun: number;
  readonly daysToGo: number;
  readonly met: boolean;
}

export function gateStreak(nights: readonly AuditedNight[]): GateStreak {
  const sorted = [...nights].sort((a, b) => Temporal.PlainDate.compare(a.night, b.night));
  let lastErrorOn: string | null = null;
  for (const n of sorted) if (!n.ok) lastErrorOn = n.night;
  const run = sorted.filter(
    (n) => n.ok && (lastErrorOn === null || Temporal.PlainDate.compare(n.night, lastErrorOn) > 0),
  );
  const first = run[0]?.night ?? null;
  const last = run.at(-1)?.night ?? null;
  const daysInRun =
    first && last
      ? Temporal.PlainDate.from(first).until(Temporal.PlainDate.from(last), { largestUnit: "days" })
          .days + 1
      : 0;
  return {
    cleanNights: run.length,
    runStartedOn: first,
    lastErrorOn,
    daysInRun,
    daysToGo: Math.max(0, GATE_DAYS - daysInRun),
    met: daysInRun >= GATE_DAYS,
  };
}
