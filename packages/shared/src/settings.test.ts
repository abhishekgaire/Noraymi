import { describe, expect, it } from "vitest";
import { parseSetting, settingsKeys, startsNextBusinessDate } from "./settings.js";

describe("settings schemas", () => {
  it("has the sixteen keys spec 03 lists", () => {
    expect([...settingsKeys].sort()).toEqual(
      [
        "alerts",
        "barMode",
        "deposit",
        "drawer",
        "hours",
        "languages",
        "messages",
        "ordering",
        "pay",
        "phone",
        "pos",
        "prices",
        "rooms",
        "safety",
        "tabs",
        "website",
      ].sort(),
    );
  });

  it("refuses unknown fields and wrong shapes with the key and path in the reason", () => {
    const bad = parseSetting("tabs", {
      openingHoldCents: 5000,
      flagOverCents: "600",
      cutOffAt: "4:30",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reasons.some((r) => r.startsWith("tabs.flagOverCents"))).toBe(true);
      expect(bad.reasons.some((r) => r.startsWith("tabs.cutOffAt"))).toBe(true);
    }
    expect(
      parseSetting("tabs", { openingHoldCents: 5000, flagOverCents: 60000, cutOffAt: "04:30" }).ok,
    ).toBe(true);
    expect(parseSetting("safety", { occupancyLimit: null, warnAtPct: 90, extra: 1 }).ok).toBe(
      false,
    );
  });

  it("only the drawer model, the tip-pool method and the bar POS layouts wait for the next business date", () => {
    expect(startsNextBusinessDate("drawer", { drawer: "house" }, { drawer: "perPerson" })).toBe(
      true,
    );
    expect(startsNextBusinessDate("drawer", undefined, { drawer: "perPerson" })).toBe(false);
    expect(startsNextBusinessDate("pay", { pool: "hours" }, { pool: "even" })).toBe(true);
    expect(startsNextBusinessDate("pay", { pool: "hours", x: 1 }, { pool: "hours", x: 2 })).toBe(
      false,
    );
    expect(startsNextBusinessDate("pos", { layouts: { bar: 1 } }, { layouts: { bar: 2 } })).toBe(
      true,
    );
    expect(startsNextBusinessDate("hours", { lastCall: "04:00" }, { lastCall: "03:00" })).toBe(
      false,
    );
  });
});
