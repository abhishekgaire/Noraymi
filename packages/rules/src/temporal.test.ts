import { describe, expect, it } from "vitest";
import { Temporal } from "./index.js";

// A sanity check that the pinned polyfill resolves New York time. The
// business-date rules themselves are written test-first in M1-04.
describe("pinned Temporal polyfill", () => {
  it("resolves an instant in America/New_York", () => {
    const zoned =
      Temporal.Instant.from("2026-09-26T02:41:00Z").toZonedDateTimeISO("America/New_York");
    expect(zoned.toPlainDateTime().toString()).toBe("2026-09-25T22:41:00");
    expect(zoned.offset).toBe("-04:00");
  });
});
