import { describe, expect, it } from "vitest";
import { SEED_NOW } from "@west4/shared";
import { UpdateGate, nextCutoverAfter } from "./updates.js";

/** The seed's night: an update published at 10:41 PM Fri Sep 25 installs after 6:00 AM Sat Sep 26, not before. */
const NEW_YORK = { timeZone: "America/New_York", dayCutover: "06:00" };

describe("updates at the cutover", () => {
  it("finds the next 6:00 AM on the venue's clock", () => {
    expect(nextCutoverAfter(SEED_NOW, NEW_YORK).toString()).toBe("2026-09-26T10:00:00Z");
    // Just after a cutover, the next one is a day away; just before, it's minutes away.
    expect(nextCutoverAfter("2026-09-26T10:00:01Z", NEW_YORK).toString()).toBe(
      "2026-09-27T10:00:00Z",
    );
    expect(nextCutoverAfter("2026-09-26T09:59:00Z", NEW_YORK).toString()).toBe(
      "2026-09-26T10:00:00Z",
    );
    // Across the clock change on Nov 1, 2026, the cutover stays 6:00 AM local.
    expect(nextCutoverAfter("2026-11-01T03:30:00Z", NEW_YORK).toString()).toBe(
      "2026-11-01T11:00:00Z",
    );
  });

  it("holds an update downloaded at 10:41 PM until 6:00 AM, then lets it install", () => {
    const gate = new UpdateGate(NEW_YORK);
    expect(gate.isDue(SEED_NOW)).toBe(false);
    gate.downloaded(SEED_NOW);
    expect(gate.pending).toBe(true);
    expect(gate.dueAt()?.toString()).toBe("2026-09-26T10:00:00Z");
    expect(gate.isDue("2026-09-26T05:00:00Z")).toBe(false);
    expect(gate.isDue("2026-09-26T09:59:59Z")).toBe(false);
    expect(gate.isDue("2026-09-26T10:00:00Z")).toBe(true);
    // The first start after the cutover, hours later, installs too.
    expect(gate.isDue("2026-09-26T15:00:00Z")).toBe(true);
  });

  it("never installs while the venue's clock isn't known", () => {
    const gate = new UpdateGate(null);
    gate.downloaded(SEED_NOW);
    expect(gate.isDue("2026-09-27T00:00:00Z")).toBe(false);
    gate.setClock(NEW_YORK);
    expect(gate.isDue("2026-09-27T00:00:00Z")).toBe(true);
  });
});
