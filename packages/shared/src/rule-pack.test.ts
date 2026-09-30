import { describe, expect, it } from "vitest";
import { canonicalJson, newYorkCounty, rulePackChanges } from "./rule-pack.js";

describe("the New York County pack", () => {
  it("is version 2026.09 with the spec's values", () => {
    expect(newYorkCounty.id).toBe("us-ny-new-york-county");
    expect(newYorkCounty.version).toBe("2026.09");
    expect(newYorkCounty.alcohol.lastSale).toBe("04:00");
    expect(newYorkCounty.alcohol.drinkingUpMin).toBe(30);
    expect(newYorkCounty.salesTax.rate).toBe(0.08875);
    expect(newYorkCounty.wages).toEqual({
      region: "nyc",
      minimumCents: 1700,
      tippedCashCents: 1135,
      tipCreditCents: 565,
    });
    expect(newYorkCounty.retention.tipRecordsYears).toBe(6);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and drops whitespace, so key order can't change the signature", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("rulePackChanges", () => {
  it("lists each changed path with its old and new value, ignoring the version string", () => {
    const next = {
      ...newYorkCounty,
      version: "2026.12",
      alcohol: { ...newYorkCounty.alcohol, lastSale: "03:00" },
      salesTax: { ...newYorkCounty.salesTax, rate: 0.09 },
    };
    expect(rulePackChanges(newYorkCounty, next)).toEqual([
      { path: "alcohol.lastSale", from: "04:00", to: "03:00" },
      { path: "salesTax.rate", from: 0.08875, to: 0.09 },
    ]);
    expect(rulePackChanges(newYorkCounty, { ...newYorkCounty, version: "2026.10" })).toEqual([]);
  });
});
