import { describe, expect, it } from "vitest";
import { SEED_NOW, Temporal } from "@west4/shared";
import { nextHalfHour } from "./booking-time.js";

const NY = "America/New_York";
const at = (local: string) => Temporal.ZonedDateTime.from(`${local}[${NY}]`).toInstant();

describe("New booking's default time (U-13)", () => {
  it("is 11:00 PM at the seed's 10:41 PM", () => {
    expect(nextHalfHour(Temporal.Instant.from(SEED_NOW), NY)).toBe("23:00");
  });
  it("is the next half hour, never now", () => {
    expect(nextHalfHour(at("2026-09-25T22:00:00"), NY)).toBe("22:30");
    expect(nextHalfHour(at("2026-09-25T22:29:59"), NY)).toBe("22:30");
    expect(nextHalfHour(at("2026-09-25T22:30:00"), NY)).toBe("23:00");
    expect(nextHalfHour(at("2026-09-25T23:45:00"), NY)).toBe("00:00");
  });
});
