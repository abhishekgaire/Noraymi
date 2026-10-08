/**
 * The published targets (spec 01 · Targets) and the numbers M8-17's alerts read from them: the
 * error budget each target leaves, and how fast it's burning. Pure, so the dashboards, the alert
 * job and the tests all count the same way.
 */

/** The parts of the service the targets and the public status page name. */
export const STATUS_PARTS = ["ordering", "payments", "printing", "texts"] as const;
export type StatusPart = (typeof STATUS_PARTS)[number];

export const TARGETS = {
  /** Ordering, payments and printing available during opening hours: 99.9% a month. */
  availability: { objective: 0.999, parts: ["ordering", "payments", "printing"] as const },
  /** Order to bar alarm: under 3 seconds for 95% of orders. */
  orderToAlarm: { thresholdMs: 3000, objective: 0.95 },
  /** Card payments that don't fail on our side during opening hours: 99.5% (declines don't count). */
  cardPayments: { objective: 0.995 },
  /** Data we can lose (RPO), in seconds. */
  rpoSeconds: { inRegion: 60, crossRegion: 15 * 60 },
  /** Time to recover (RTO), in seconds. */
  rtoSeconds: { zone: 5 * 60, region: 2 * 60 * 60 },
} as const;

/**
 * Which part a route belongs to, from its pattern (never its filled-in URL, which can carry a
 * token), or null for everything else. The availability numbers count these requests.
 */
export function partOfRoute(pattern: string): StatusPart | null {
  if (/\/print(\b|-host|-jobs|ers\b)|cloudprnt|\/epson/.test(pattern)) return "printing";
  if (/\/(texts|conversations)\b|\/hooks\/twilio|-text\b|\/text$/.test(pattern)) return "texts";
  if (/\/payments\b|\/pay(\b|-link)|\/refunds\b|\/readers\b|\/hooks\/stripe/.test(pattern))
    return "payments";
  if (/\/orders\b|offline-orders|gift-order/.test(pattern)) return "ordering";
  return null;
}

/** A request counts against availability when we failed it: a 5xx, or no answer at all. */
export const failedOnOurSide = (status: number): boolean => status >= 500;

/**
 * A card payment attempt's outcome for the 99.5% target: our side failed it (a timeout, an
 * unknown result, a 5xx, the reader offline), the card was declined (doesn't count), or it went
 * through. A canceled attempt isn't counted.
 */
export type CardOutcome = "ok" | "declined" | "our_side";
const OUR_SIDE_CODES =
  /timeout|timed_out|unknown|offline|unreachable|api_error|api_connection|rate_limit|internal|server|reader_busy|terminal_reader|lock_timeout/i;

export function cardOutcome(state: string, code: string | null): CardOutcome | null {
  if (state === "succeeded") return "ok";
  if (state === "unknown") return "our_side";
  if (state === "failed") return code && OUR_SIDE_CODES.test(code) ? "our_side" : "declined";
  return null;
}

/**
 * How fast an error budget burns: the bad fraction over the fraction the objective allows.
 * 1 spends the budget exactly over the target's window; 14.4 spends a month's budget in 2 days.
 */
export function burnRate(bad: number, total: number, objective: number): number {
  if (total <= 0) return 0;
  const allowed = 1 - objective;
  return bad / total / allowed;
}

/**
 * The multi-window burn-rate alerts (the SRE workbook's): both the long window and its short
 * window must burn faster than `rate` for the alert to fire, so it pages quickly on a real burn
 * and stops quickly once it ends. M8-17 pages on `page` and opens a ticket on `ticket`.
 */
export const BURN_ALERTS = [
  { longMinutes: 60, shortMinutes: 5, rate: 14.4, budgetSpent: 0.02, severity: "page" },
  { longMinutes: 360, shortMinutes: 30, rate: 6, budgetSpent: 0.05, severity: "page" },
  { longMinutes: 4320, shortMinutes: 360, rate: 1, budgetSpent: 0.1, severity: "ticket" },
] as const;

export interface WindowCounts {
  readonly bad: number;
  readonly total: number;
}

/** Which burn alerts fire for one target, given each window's counts (keyed by minutes). */
export function firingBurnAlerts(
  objective: number,
  windows: Readonly<Record<number, WindowCounts>>,
): (typeof BURN_ALERTS)[number][] {
  return BURN_ALERTS.filter((a) => {
    const long = windows[a.longMinutes];
    const short = windows[a.shortMinutes];
    if (!long || !short) return false;
    return (
      burnRate(long.bad, long.total, objective) >= a.rate &&
      burnRate(short.bad, short.total, objective) >= a.rate
    );
  });
}

/** The order-to-alarm target's bad events: orders whose alarm rang 3 seconds or more after placing. */
export const slowAlarm = (ms: number): boolean => ms >= TARGETS.orderToAlarm.thresholdMs;

/** The 95th percentile of a list of durations (nearest rank), or null for none. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
}

/** What the public status page says of a part. */
export const PART_STATES = ["operational", "degraded", "outage", "maintenance"] as const;
export type PartState = (typeof PART_STATES)[number];

export interface PartStatus {
  readonly part: StatusPart;
  readonly state: PartState;
  /** A short public note ("Card payments may fail at some venues"); never personal data. */
  readonly note: string | null;
  readonly since: string | null;
}

export interface PublicStatus {
  readonly parts: readonly PartStatus[];
  readonly updated_at: string;
}
