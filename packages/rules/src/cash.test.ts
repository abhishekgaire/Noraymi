import { describe, expect, it } from "vitest";
import { cashOffers, changeDue } from "./cash.js";

describe("the cash panel", () => {
  it("offers Exact and the next $5, $10 and $20: Room 5's $51.55", () => {
    expect(cashOffers(5155)).toEqual([
      { kind: "exact", cents: 5155 },
      { kind: "next5", cents: 5500 },
      { kind: "next10", cents: 6000 },
    ]);
  });
  it("drops a note that repeats an earlier offer: $498.60 is $500.00 for the next $5, $10 and $20 alike", () => {
    expect(cashOffers(49860)).toEqual([
      { kind: "exact", cents: 49860 },
      { kind: "next5", cents: 50000 },
    ]);
  });
  it("offers the next $20 when it's its own: $41.55", () => {
    expect(cashOffers(4155).map((o) => o.cents)).toEqual([4155, 4500, 5000, 6000]);
  });
  it("works out the change: $500.00 on $498.60 is $1.40; $60.00 on $51.55 is $8.45; $100.00 is $48.45", () => {
    expect(changeDue({ owedCents: 49860, tenderedCents: 50000 })).toBe(140);
    expect(changeDue({ owedCents: 5155, tenderedCents: 6000 })).toBe(845);
    expect(changeDue({ owedCents: 5155, tenderedCents: 10000 })).toBe(4845);
  });
  it("takes a cash tip out of what's handed over, and knows a short amount", () => {
    expect(changeDue({ owedCents: 5155, tipCents: 500, tenderedCents: 6000 })).toBe(345);
    expect(changeDue({ owedCents: 5155, tenderedCents: 5000 })).toBeNull();
  });
});
