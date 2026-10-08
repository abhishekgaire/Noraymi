import { Temporal } from "@west4/shared";

/**
 * On-call coverage for the gate (M9-16; spec 13 · On call): every opening hour of every live night,
 * through the night's close, has a shift with a named first and a named second responder, two
 * different people. A night's window runs from its opening to the next business date's start (the
 * day cutover), the cautious reading of "through each night's close": the close is done before the
 * cutover, but when it finishes isn't known in advance.
 */
export interface NightWindow {
  readonly businessDate: string;
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
}

export interface RotaShift {
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
  /** Who answers first and second: a Console staff email, never left empty. */
  readonly first: string;
  readonly second: string;
}

export type GapWhy = "uncovered" | "no_second" | "same_person";

export interface CoverageGap {
  readonly businessDate: string;
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
  readonly why: GapWhy;
}

const cmp = Temporal.Instant.compare;
const valid = (s: RotaShift): GapWhy | null =>
  s.second.trim() === ""
    ? "no_second"
    : s.first.trim().toLowerCase() === s.second.trim().toLowerCase()
      ? "same_person"
      : s.first.trim() === ""
        ? "uncovered"
        : null;

/** The shift on at an instant: the one starting latest among those covering it. */
export function shiftAt(shifts: readonly RotaShift[], at: Temporal.Instant): RotaShift | null {
  const on = shifts.filter((s) => cmp(s.from, at) <= 0 && cmp(at, s.to) < 0);
  on.sort((a, b) => cmp(b.from, a.from));
  return on[0] ?? null;
}

/** Every stretch of every window without a valid shift on, merged where they touch. */
export function coverageGaps(
  windows: readonly NightWindow[],
  shifts: readonly RotaShift[],
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const w of windows) {
    const edges = [w.from, w.to];
    for (const s of shifts)
      for (const e of [s.from, s.to]) if (cmp(e, w.from) > 0 && cmp(e, w.to) < 0) edges.push(e);
    edges.sort(cmp);
    for (let i = 0; i + 1 < edges.length; i++) {
      const [a, b] = [edges[i]!, edges[i + 1]!];
      if (cmp(a, b) === 0) continue;
      // Any valid shift covering the whole stretch covers it; otherwise the best reason it isn't.
      const on = shifts.filter((s) => cmp(s.from, a) <= 0 && cmp(b, s.to) <= 0);
      if (on.some((s) => valid(s) === null)) continue;
      const why: GapWhy = on.length === 0 ? "uncovered" : valid(on[0]!)!;
      const last = gaps.at(-1);
      if (last && last.businessDate === w.businessDate && last.why === why && cmp(last.to, a) === 0)
        gaps[gaps.length - 1] = { ...last, to: b };
      else gaps.push({ businessDate: w.businessDate, from: a, to: b, why });
    }
  }
  return gaps;
}
