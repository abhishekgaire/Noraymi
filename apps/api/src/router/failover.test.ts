import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { failoverDue } from "./failover.js";

describe("the monthly failover test (M8-02)", () => {
  const today = Temporal.PlainDate.from("2026-09-25");
  it("is due at once when it was never run", () => {
    expect(failoverDue(null, today)).toEqual({ due: true, dueOn: null });
  });
  it("is due a calendar month after the last one", () => {
    expect(failoverDue("2026-09-01", today)).toEqual({ due: false, dueOn: "2026-10-01" });
    expect(failoverDue("2026-08-25", today)).toEqual({ due: true, dueOn: "2026-09-25" });
    expect(failoverDue("2026-01-31", Temporal.PlainDate.from("2026-02-28")).due).toBe(true);
  });
});
