import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tipChoices } from "./tips.js";

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
