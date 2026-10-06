import { describe, expect, it } from "vitest";
import { taxQuarterOf } from "./tax-quarter.js";

describe("New York's sales-tax quarters", () => {
  it("puts Fri Sep 25, 2026 in Sep–Nov 2026", () => {
    expect(taxQuarterOf("2026-09-25")).toEqual({
      label: "2026-Q3",
      start: "2026-09-01",
      end: "2026-11-30",
    });
  });

  it("ends each quarter on its last night, by business date", () => {
    expect(taxQuarterOf("2026-11-30").end).toBe("2026-11-30");
    expect(taxQuarterOf("2026-12-01").start).toBe("2026-12-01");
    expect(taxQuarterOf("2026-05-31")).toEqual({
      label: "2026-Q1",
      start: "2026-03-01",
      end: "2026-05-31",
    });
    expect(taxQuarterOf("2026-08-31")).toEqual({
      label: "2026-Q2",
      start: "2026-06-01",
      end: "2026-08-31",
    });
  });

  it("runs Dec–Feb across the new year, to Feb 29 in a leap year", () => {
    expect(taxQuarterOf("2027-01-15")).toEqual({
      label: "2026-Q4",
      start: "2026-12-01",
      end: "2027-02-28",
    });
    expect(taxQuarterOf("2028-02-29")).toEqual({
      label: "2027-Q4",
      start: "2027-12-01",
      end: "2028-02-29",
    });
    expect(taxQuarterOf("2028-03-01")).toEqual({
      label: "2028-Q1",
      start: "2028-03-01",
      end: "2028-05-31",
    });
  });
});
