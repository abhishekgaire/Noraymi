import { describe, expect, it } from "vitest";
import {
  KITCHEN_DEFAULTS,
  parseSetting,
  settingsKeys,
  startsNextBusinessDate,
  roomSoundOn,
  roomSoundVolume,
  tabCardRequired,
  walkInTakesOf,
  withLaterPart,
  zReportAtClose,
} from "./settings.js";

describe("settings schemas", () => {
  it("has the twenty-six keys spec 03 and spec 16 list", () => {
    expect([...settingsKeys].sort()).toEqual(
      [
        "alerts",
        "approvals",
        "pinAgain",
        "barMode",
        "contacts",
        "deposit",
        "drawer",
        "hours",
        "kitchen",
        "languages",
        "menuOrder",
        "messages",
        "inventory",
        "kitchenScreen",
        "ordering",
        "pay",
        "phone",
        "pos",
        "prices",
        "publicForms",
        "rooms",
        "safety",
        "tabs",
        "taxExempt",
        "texting",
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
    // "We run our own orders" (U-11): the same yes or no, absent reads as off.
    expect(parseSetting("pos", { ...pos, selfRunOrders: true }).ok).toBe(true);
    const badRun = parseSetting("pos", { ...pos, selfRunOrders: "on" });
    expect(badRun.ok).toBe(false);
    if (!badRun.ok) expect(badRun.reasons[0]).toMatch(/^pos\.selfRunOrders/);
    // "Print and email the Z report at close" (U-15): absent reads as on; false turns it off.
    expect(zReportAtClose(pos)).toBe(true);
    expect(zReportAtClose(null)).toBe(true);
    expect(zReportAtClose({ ...pos, zReportAtClose: false })).toBe(false);
    expect(parseSetting("pos", { ...pos, zReportAtClose: false }).ok).toBe(true);
    expect(parseSetting("pos", { ...pos, zReportAtClose: "on" }).ok).toBe(false);
    // "Take cash quick sales while offline" (U-16): absent reads as off; a yes or no only.
    expect(pos).not.toHaveProperty("offlineCashSales");
    expect(parseSetting("pos", { ...pos, offlineCashSales: true }).ok).toBe(true);
    const badCash = parseSetting("pos", { ...pos, offlineCashSales: 1 });
    expect(badCash.ok).toBe(false);
    if (!badCash.ok) expect(badCash.reasons[0]).toMatch(/^pos\.offlineCashSales/);
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

describe("what a walk-in check-in takes (D112)", () => {
  const rule = {
    on: true,
    mode: "firstHour",
    value: 0,
    refundHours: 24,
    late: "keep",
    noShow: "keep",
    graceMin: 15,
    bigParty: null,
  };
  it("defaults to the deposit when it was never set (West 4)", () => {
    expect(parseSetting("deposit", rule).ok).toBe(true);
    expect(walkInTakesOf(rule as never)).toBe("deposit");
    expect(walkInTakesOf(null)).toBe("deposit");
  });
  it("takes one of the four choices (D112, D116), and nothing else", () => {
    for (const walkIn of ["deposit", "cardOnTab", "cardBehindBar", "nothing"]) {
      expect(parseSetting("deposit", { ...rule, walkIn }).ok).toBe(true);
      expect(walkInTakesOf({ walkIn } as never)).toBe(walkIn);
    }
    expect(parseSetting("deposit", { ...rule, walkIn: "hold" }).ok).toBe(false);
  });
});

describe("Open a tab without a card (P-03)", () => {
  const tabs = { openingHoldCents: 5000, flagOverCents: 60000, cutOffAt: "04:30" };
  it("is card first unless the venue turns it off; absent reads as card first", () => {
    expect(tabCardRequired(tabs)).toBe(true);
    expect(tabCardRequired(null)).toBe(true);
    expect(tabCardRequired({ ...tabs, cardRequired: true })).toBe(true);
    expect(tabCardRequired({ ...tabs, cardRequired: false })).toBe(false);
  });
  it("is saved with the tab settings, as a yes or no", () => {
    expect(parseSetting("tabs", { ...tabs, cardRequired: false }).ok).toBe(true);
    expect(parseSetting("tabs", tabs).ok).toBe(true);
    expect(parseSetting("tabs", { ...tabs, cardRequired: "no" }).ok).toBe(false);
  });
});

describe("Sound when a room's time is up (P-05)", () => {
  it("is on at volume 50 until the venue changes it; saved alerts without it still parse", () => {
    expect(roomSoundOn({ roomEndingMin: 10 } as never)).toBe(true);
    expect(roomSoundOn(null)).toBe(true);
    expect(roomSoundOn({ roomSound: false })).toBe(false);
    expect(roomSoundVolume({})).toBe(50);
    expect(roomSoundVolume({ roomSoundVolume: 0 })).toBe(0);
    expect(parseSetting("alerts", { roomEndingMin: 10 }).ok).toBe(true);
  });
  it("is a yes or no and a volume from 0 to 100", () => {
    const ok = { roomEndingMin: 10, roomSound: false, roomSoundVolume: 80 };
    expect(parseSetting("alerts", ok).ok).toBe(true);
    expect(parseSetting("alerts", { ...ok, roomSound: "off" }).ok).toBe(false);
    expect(parseSetting("alerts", { ...ok, roomSoundVolume: 101 }).ok).toBe(false);
    expect(parseSetting("alerts", { ...ok, roomSoundVolume: 2.5 }).ok).toBe(false);
  });
});
