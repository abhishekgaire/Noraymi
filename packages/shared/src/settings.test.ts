import { describe, expect, it } from "vitest";
import {
  KITCHEN_DEFAULTS,
  parseSetting,
  settingsKeys,
  startsNextBusinessDate,
  withLaterPart,
} from "./settings.js";

describe("settings schemas", () => {
  it("has the seventeen keys spec 03 and spec 16 list", () => {
    expect([...settingsKeys].sort()).toEqual(
      [
        "alerts",
        "barMode",
        "deposit",
        "drawer",
        "hours",
        "kitchen",
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

  it("pos.printBarDrinkTickets is a yes or no, and a venue saved before it existed still parses (M6-29)", () => {
    const pos = {
      layouts: { bar: 1 },
      reasonOnly: { eachCents: 2500, perShiftCents: 7500 },
      idleLockMin: 3,
      wipeLockSec: 10,
      barTabTip: "reader",
      orderAging: { phonesSec: 30, amberSec: 120, pinkSec: 240, callSec: 360 },
      chime: true,
      muteSec: 60,
    };
    expect(parseSetting("pos", pos).ok).toBe(true);
    expect(parseSetting("pos", { ...pos, printBarDrinkTickets: false }).ok).toBe(true);
    expect(parseSetting("pos", { ...pos, printBarDrinkTickets: true }).ok).toBe(true);
    const bad = parseSetting("pos", { ...pos, printBarDrinkTickets: "yes" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reasons[0]).toMatch(/^pos\.printBarDrinkTickets/);
  });

  it("kitchen (K-01): unsentWarnMin defaults to 5 and refuses a value outside 1 to 60; the notice needs both languages", () => {
    expect(KITCHEN_DEFAULTS).toEqual({ allergyNotice: null, lastOrder: null, unsentWarnMin: 5 });
    expect(parseSetting("kitchen", KITCHEN_DEFAULTS).ok).toBe(true);
    for (const ok of [1, 60])
      expect(parseSetting("kitchen", { ...KITCHEN_DEFAULTS, unsentWarnMin: ok }).ok).toBe(true);
    for (const bad of [0, 61, 2.5, -1]) {
      const r = parseSetting("kitchen", { ...KITCHEN_DEFAULTS, unsentWarnMin: bad });
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(r.reasons[0]).toMatch(/^kitchen\.unsentWarnMin/);
    }
    expect(parseSetting("kitchen", { ...KITCHEN_DEFAULTS, lastOrder: "23:30" }).ok).toBe(true);
    expect(parseSetting("kitchen", { ...KITCHEN_DEFAULTS, lastOrder: "11:30 PM" }).ok).toBe(false);
    expect(
      parseSetting("kitchen", { ...KITCHEN_DEFAULTS, allergyNotice: { en: "Notice", es: "Aviso" } })
        .ok,
    ).toBe(true);
    expect(
      parseSetting("kitchen", { ...KITCHEN_DEFAULTS, allergyNotice: { en: "Notice" } }).ok,
    ).toBe(false);
    expect(
      parseSetting("kitchen", { ...KITCHEN_DEFAULTS, allergyNotice: { en: " ", es: "Aviso" } }).ok,
    ).toBe(false);
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

describe("withLaterPart (M6-25)", () => {
  it("takes only the parts that wait for the next business date", () => {
    expect(
      withLaterPart(
        "pos",
        { layouts: { bar: 1 }, muteSec: 30 },
        { layouts: { bar: 2 }, muteSec: 60 },
      ),
    ).toEqual({ layouts: { bar: 2 }, muteSec: 30 });
    expect(withLaterPart("pay", { pool: "hours", x: 1 }, { pool: "even", x: 2 })).toEqual({
      pool: "even",
      x: 1,
    });
    expect(withLaterPart("drawer", { drawer: "house" }, { drawer: "perPerson" })).toEqual({
      drawer: "perPerson",
    });
    expect(withLaterPart("tabs", { a: 1 }, { a: 2 })).toEqual({ a: 1 });
  });
});
