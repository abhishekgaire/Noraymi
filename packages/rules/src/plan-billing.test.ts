import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { adminReadOnlyFrom, planState } from "./plan-billing.js";

const NY = "America/New_York";
const at = (iso: string) => Temporal.Instant.from(iso);

describe("our plan: a failed payment, then read-only Admin (M8-15)", () => {
  it("turns read-only at the first 6:00 AM cutover 14 days after a failure at 10:41 PM", () => {
    // Fri Sep 25, 2026, 10:41 PM in New York → Sat Oct 10, 6:00 AM (EDT).
    expect(adminReadOnlyFrom("2026-09-26T02:41:00Z", NY, "06:00").toString()).toBe(
      "2026-10-10T10:00:00Z",
    );
  });

  it("a failure after midnight belongs to the night before, and still waits for the cutover", () => {
    // Sat Sep 26, 2:00 AM → Oct 10, 2:00 AM is business date Oct 9 → Oct 10, 6:00 AM.
    expect(adminReadOnlyFrom("2026-09-26T06:00:00Z", NY, "06:00").toString()).toBe(
      "2026-10-10T10:00:00Z",
    );
  });

  it("a failure exactly at the cutover turns read-only exactly 14 days later", () => {
    expect(adminReadOnlyFrom("2026-09-26T10:00:00Z", NY, "06:00").toString()).toBe(
      "2026-10-10T10:00:00Z",
    );
  });

  it("counts calendar days through the end of daylight saving (Nov 1, 2026)", () => {
    // Tue Oct 27, 7:00 PM EDT → Tue Nov 10, 7:00 PM EST → Wed Nov 11, 6:00 AM EST (11:00 Z).
    expect(adminReadOnlyFrom("2026-10-27T23:00:00Z", NY, "06:00").toString()).toBe(
      "2026-11-11T11:00:00Z",
    );
  });

  it("names the state: none, ok, payment_failed until the cutover, then read_only", () => {
    const failed = { payment_failed_at: "2026-09-26T02:41:00Z" };
    expect(planState(null, at("2026-09-26T02:41:00Z"), NY, "06:00").state).toBe("none");
    expect(planState({ payment_failed_at: null }, at("2026-09-26T02:41:00Z"), NY, "06:00")).toEqual(
      { state: "ok", readOnlyFrom: null },
    );
    expect(planState(failed, at("2026-10-10T09:59:59Z"), NY, "06:00").state).toBe("payment_failed");
    expect(planState(failed, at("2026-10-10T10:00:00Z"), NY, "06:00").state).toBe("read_only");
  });
});
