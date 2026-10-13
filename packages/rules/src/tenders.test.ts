import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitEven } from "./check-totals.js";
import { outsideCardNoteOk, tenderTotals, type TenderPayment } from "./tenders.js";

/** F-10 (D126): the outside card machine's money cases (seed/money-cases.json group outside_card). */
const here = path.dirname(fileURLToPath(import.meta.url));
interface Case {
  id: string;
  group: string;
  function: string;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown>;
}
const cases = (
  JSON.parse(readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8")) as {
    cases: Case[];
  }
).cases.filter((c) => c.group === "outside_card");

describe("the outside card machine's money cases", () => {
  it("has its four cases", () => expect(cases).toHaveLength(4));

  for (const c of cases)
    it(c.id, () => {
      if (c.function === "tender_totals") {
        const t = tenderTotals(c.inputs["payments"] as TenderPayment[]);
        expect(t).toEqual(c.expected);
      } else if (c.function === "split_even") {
        const shares = splitEven(c.inputs["amount_cents"] as number, c.inputs["shares"] as number);
        expect(shares).toEqual((c.expected["shares_cents"] as number[]).map((n) => n));
        expect(shares.reduce((a, b) => a + b, 0)).toBe(c.inputs["amount_cents"]);
      } else if (c.function === "outside_card_note") {
        const notes = c.inputs["notes"] as (string | null)[];
        expect(notes.map((n) => outsideCardNoteOk(n))).toEqual(c.expected["ok"]);
      } else throw new Error(`no test for ${c.function}`);
    });
});
