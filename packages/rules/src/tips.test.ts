import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tipChoices, tipPosting, tipReview } from "./tips.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = (
  JSON.parse(readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8")) as {
    cases: {
      id: string;
      function: string;
      inputs: Record<string, number>;
      expected: { kind: string; choices_cents: number[] };
    }[];
  }
).cases.filter((c) => c.function === "tip_choices");
const west4 = {
  pcts: [18, 20, 22] as [number, number, number],
  fixedCents: [100, 200, 300] as [number, number, number],
  smartThresholdCents: 1000,
};

/** M6-05: the reader's tip choices on a quick sale, from the seed's tips group. */
describe("tipChoices · the seed's tip_choices cases", () => {
  it("has the cases", () => expect(cases.length).toBeGreaterThanOrEqual(7));
  for (const c of cases)
    it(c.id, () => {
      const out = tipChoices(c.inputs["drinks_before_tax_cents"]!, west4);
      expect(out.kind).toBe(c.expected.kind);
      expect(out.choicesCents).toEqual(c.expected.choices_cents);
    });
  it("a $9.00 sale offers $1, $2 and $3; a $30.00 one $5.40, $6.00 and $6.60", () => {
    expect(tipChoices(900, west4).choicesCents).toEqual([100, 200, 300]);
    expect(tipChoices(3000, west4).choicesCents).toEqual([540, 600, 660]);
  });
});

const reviewCases = (
  JSON.parse(readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8")) as {
    cases: {
      id: string;
      function: string;
      inputs: Record<string, number>;
      expected: { needs_approval: boolean; reasons: string[] };
    }[];
  }
).cases.filter((c) => c.function === "tip_review");

/** M6-09: a tip typed in from a paper slip, from the seed's tip_review cases. */
describe("tipReview · the seed's tip_review cases", () => {
  it("has the four cases", () =>
    expect(reviewCases.map((c) => c.id).sort()).toEqual([
      "tip_review_entered_late",
      "tip_review_normal",
      "tip_review_over_25pct",
      "tip_review_over_50_dollars",
    ]));
  for (const c of reviewCases)
    it(c.id, () => {
      const out = tipReview({
        tabTotalCents: c.inputs["tab_total_cents"]!,
        tipCents: c.inputs["tip_cents"]!,
        enteredAfterMinutes: c.inputs["entered_after_minutes"]!,
        review: {
          overPct: c.inputs["over_pct"]!,
          overCents: c.inputs["over_cents"]!,
          lateHours: c.inputs["late_hours"]!,
        },
      });
      expect(out.needsApproval).toBe(c.expected.needs_approval);
      expect(out.reasons).toEqual(c.expected.reasons);
    });
  const review = { overPct: 25, overCents: 5000, lateHours: 2 };
  it("exactly 25%, exactly $50 and exactly 2 hours aren't over", () => {
    expect(
      tipReview({ tabTotalCents: 20000, tipCents: 5000, enteredAfterMinutes: 120, review }),
    ).toEqual({ needsApproval: false, reasons: [] });
    expect(
      tipReview({ tabTotalCents: 6250, tipCents: 1563, enteredAfterMinutes: 0, review }).reasons,
    ).toEqual(["over_pct"]);
    expect(
      tipReview({ tabTotalCents: 6250, tipCents: 1562, enteredAfterMinutes: 0, review }).reasons,
    ).toEqual([]);
  });
  it("can be over all three at once", () =>
    expect(
      tipReview({ tabTotalCents: 10000, tipCents: 6000, enteredAfterMinutes: 121, review }).reasons,
    ).toEqual(["over_pct", "over_cents", "late"]));
});

describe("tipPosting · a tip after the night closes (Money rules 16)", () => {
  it("posts to its own night while that night is open", () =>
    expect(tipPosting({ night: "2026-09-25", today: "2026-09-25", nightClosed: false })).toEqual({
      businessDate: "2026-09-25",
      adjustsBusinessDate: null,
    }));
  it("after the Z report, before the 6 AM cutover: the next business date, adjusting Friday", () =>
    expect(tipPosting({ night: "2026-09-25", today: "2026-09-25", nightClosed: true })).toEqual({
      businessDate: "2026-09-26",
      adjustsBusinessDate: "2026-09-25",
    }));
  it("days later: today's business date, adjusting its night", () =>
    expect(tipPosting({ night: "2026-09-25", today: "2026-09-28", nightClosed: false })).toEqual({
      businessDate: "2026-09-28",
      adjustsBusinessDate: "2026-09-25",
    }));
  it("across the fall-back night, the next date is the calendar's next date", () =>
    expect(tipPosting({ night: "2026-10-31", today: "2026-10-31", nightClosed: true })).toEqual({
      businessDate: "2026-11-01",
      adjustsBusinessDate: "2026-10-31",
    }));
});
