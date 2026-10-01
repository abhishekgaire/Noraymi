import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cents } from "@west4/shared";
import { compMinutesCents, reasonOnly } from "./reason-only.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const moneyCases = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: {
      used_this_shift_cents: number;
      amount_cents: number;
      each_limit_cents: number;
      shift_limit_cents: number;
    };
    expected: {
      needs_approval: boolean;
      over_each_limit: boolean;
      over_shift_limit: boolean;
      shift_total_after_cents: number;
      left_this_shift_before_cents: number;
    };
  }[];
};

/** M2-14 (spec 02 · The reason-only limit; spec 05 · rule 7), written before the code. */
describe("reasonOnly · the seed's reason_only_limits group", () => {
  const group = moneyCases.cases.filter((c) => c.group === "reason_only_limits");
  it("has the 8 cases the ticket names", () => expect(group).toHaveLength(8));
  for (const c of group) {
    it(c.id, () => {
      const out = reasonOnly(cents(c.inputs.used_this_shift_cents), cents(c.inputs.amount_cents), {
        eachCents: c.inputs.each_limit_cents,
        perShiftCents: c.inputs.shift_limit_cents,
      });
      expect(out).toEqual({
        needsApproval: c.expected.needs_approval,
        overEachLimit: c.expected.over_each_limit,
        overShiftLimit: c.expected.over_shift_limit,
        shiftTotalAfterCents: c.expected.shift_total_after_cents,
        leftThisShiftBeforeCents: c.expected.left_this_shift_before_cents,
      });
    });
  }
});

describe("reasonOnly", () => {
  it("limits of 0 send every comp and void for approval", () => {
    expect(reasonOnly(cents(0), cents(1), { eachCents: 0, perShiftCents: 0 }).needsApproval).toBe(
      true,
    );
  });
  it("a credit line's amount counts by its size, whatever its sign", () => {
    expect(
      reasonOnly(cents(1200), cents(-1300), { eachCents: 2500, perShiftCents: 7500 })
        .shiftTotalAfterCents,
    ).toBe(2500);
  });
  it("Comp 15 min of room time: $10.00 in Room 5 (4 guests), $30.00 in Room 9 (12 guests)", () => {
    expect(compMinutesCents(15, cents(4000))).toBe(1000);
    expect(compMinutesCents(15, cents(12000))).toBe(3000);
    expect(compMinutesCents(7, cents(4000))).toBe(467);
  });
});
