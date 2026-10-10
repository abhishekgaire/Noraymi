import { describe, expect, it } from "vitest";
import { pastLastOrder } from "./kitchen-last-order.js";

const tz = "America/New_York";
// A wall-clock time in New York in September (EDT), as an instant.
const ny = (local: string) => new Date(`${local}-04:00`).toISOString();

describe("pastLastOrder", () => {
  it("empty means no limit, at any hour", () => {
    expect(pastLastOrder(ny("2026-09-26T03:59"), null, tz, "06:00")).toBe(false);
    expect(pastLastOrder(ny("2026-09-26T03:59"), "", tz, "06:00")).toBe(false);
  });
  it("01:30 stops food in the small hours of the same night, not the evening before", () => {
    expect(pastLastOrder(ny("2026-09-25T22:41"), "01:30", tz, "06:00")).toBe(false);
    expect(pastLastOrder(ny("2026-09-26T01:29"), "01:30", tz, "06:00")).toBe(false);
    expect(pastLastOrder(ny("2026-09-26T01:30"), "01:30", tz, "06:00")).toBe(true);
    expect(pastLastOrder(ny("2026-09-26T05:59"), "01:30", tz, "06:00")).toBe(true);
  });
  it("a new business date starts with food open again", () => {
    expect(pastLastOrder(ny("2026-09-26T06:00"), "01:30", tz, "06:00")).toBe(false);
  });
  it("22:00 stops food in the evening and through the small hours", () => {
    expect(pastLastOrder(ny("2026-09-25T21:59"), "22:00", tz, "06:00")).toBe(false);
    expect(pastLastOrder(ny("2026-09-25T22:41"), "22:00", tz, "06:00")).toBe(true);
    expect(pastLastOrder(ny("2026-09-26T03:00"), "22:00", tz, "06:00")).toBe(true);
  });
  it("a last order at the cutover is the night's end", () => {
    expect(pastLastOrder(ny("2026-09-26T05:59"), "06:00", tz, "06:00")).toBe(false);
  });
  it("counts the wall clock through the fall-back night", () => {
    // Sun Nov 1, 2026: 2:00 AM EDT becomes 1:00 AM EST. 01:30 is the first 1:30 (EDT).
    expect(pastLastOrder("2026-11-01T05:29:00Z", "01:30", tz, "06:00")).toBe(false);
    expect(pastLastOrder("2026-11-01T05:30:00Z", "01:30", tz, "06:00")).toBe(true);
  });
});
