import { describe, expect, it } from "vitest";
import { catalogs } from "./i18n/index.js";
import {
  PLAN_GOVERNED_MODULES,
  PLAN_MODULES,
  planSwitchesOn,
  missingNeeds,
  moduleDef,
  moduleIds,
  modules,
  kitchenMissing,
  needsRoomOrdersConfirm,
  stateOf,
  turnsOffWith,
  type ModuleStates,
} from "./modules.js";

// West 4 on the demo night: everything phase 1 on except Song system control (none), and the phase 2 rows off.
const west4: ModuleStates = {
  website: "on",
  online_booking: "on",
  waitlist: "on",
  rooms: "on",
  room_ordering: "on",
  bar_screen: "on",
  bar_tabs: "on",
  bar_mode: "on",
  packages: "on",
  song_system: "off",
  guest_texts: "on",
  marketing_texts: "on",
  team: "on",
  safety: "on",
  reports: "on",
  deposits: "on",
  room_tablets: "on",
  card_behind_bar: "on",
  pay_share: "on",
  cash_discount: "on",
};

describe("modules", () => {
  it("lists the 34 modules spec 03 names, with the six core ones always on (D124)", () => {
    expect(moduleIds).toHaveLength(34);
    expect(modules.filter((m) => m.core).map((m) => m.id)).toEqual([
      "payments",
      "alcohol",
      "admin",
      "devices",
      "bar_tabs",
      "reports",
    ]);
    // Reports & accounting and Bar tabs & quick sale can't be off, whatever a row says.
    expect(stateOf({ reports: "off", bar_tabs: "off" }, "reports")).toBe("on");
    expect(stateOf({ reports: "off", bar_tabs: "off" }, "bar_tabs")).toBe("on");
    expect(stateOf({}, "payments")).toBe("on");
    expect(stateOf({}, "rooms")).toBe("off");
    expect(modules.filter((m) => !m.phase1).map((m) => m.id)).toEqual([
      "event_sales",
      "guests_loyalty",
      "multi_location",
    ]);
  });

  it("has every module's name in English and Spanish", () => {
    for (const id of moduleIds) {
      const key = `module.${id}.name` as keyof typeof catalogs.en;
      expect(catalogs.en[key], id).toBeTruthy();
      expect(catalogs.es[key], id).toBeTruthy();
    }
  });

  it("dependencies follow the spec's table", () => {
    const needs = Object.fromEntries(
      modules.filter((m) => m.needs.length > 0).map((m) => [m.id, m.needs]),
    );
    expect(needs).toEqual({
      online_booking: ["rooms"],
      packages: ["rooms"],
      song_system: ["rooms"],
      event_sales: ["rooms"],
      room_ordering: ["rooms", "bar_screen"],
      kitchen: ["bar_screen"],
      bar_mode: ["bar_tabs"],
      marketing_texts: ["guest_texts"],
      inventory: ["reports"],
      kitchen_screen: ["kitchen"],
      deposits: ["online_booking"],
      room_tablets: ["rooms"],
      card_behind_bar: ["rooms"],
      pay_share: ["rooms"],
    });
  });

  it("turning off Rooms & room clock at West 4 lists Online booking & deposits, Ordering from the room and Packages & specials", () => {
    expect(turnsOffWith(west4, "rooms")).toEqual([
      "online_booking",
      "room_ordering",
      "packages",
      "deposits",
      "room_tablets",
      "card_behind_bar",
      "pay_share",
    ]);
    expect(turnsOffWith(west4, "online_booking")).toEqual(["deposits"]);
    expect(turnsOffWith(west4, "bar_screen")).toEqual(["room_ordering"]);
    expect(turnsOffWith(west4, "guest_texts")).toEqual(["marketing_texts"]);
    expect(turnsOffWith(west4, "reports")).toEqual([]);
  });

  it("Ordering from the room can't be on while Bar screen & tickets is off, and the special confirm is only for that pair", () => {
    expect(missingNeeds({ ...west4, bar_screen: "off" }, "room_ordering")).toEqual(["bar_screen"]);
    expect(missingNeeds(west4, "room_ordering")).toEqual([]);
    expect(needsRoomOrdersConfirm(west4, "bar_screen")).toBe(true);
    expect(needsRoomOrdersConfirm({ ...west4, room_ordering: "off" }, "bar_screen")).toBe(false);
    expect(needsRoomOrdersConfirm(west4, "rooms")).toBe(false);
  });

  it("the effects table has the spec's four columns for every module, and the phase 2 rows hide nothing", () => {
    for (const m of modules) {
      expect(Object.keys(m.hides).sort()).toEqual(["staffApp", "staffPhone", "texts", "website"]);
      if (!m.phase1) expect(Object.values(m.hides).flat()).toEqual([]);
    }
    expect(modules.find((m) => m.id === "rooms")?.hides.staffPhone).toEqual([
      "tonight",
      "rooms",
      "calendar",
    ]);
    expect(modules.find((m) => m.id === "bar_mode")?.hides.texts).toEqual(["youre_up_next"]);
  });

  it("Kitchen & food (K-01) needs Bar screen & tickets, and turns off with it", () => {
    const singSing: ModuleStates = { ...west4, kitchen: "on" };
    expect(missingNeeds({ ...west4, bar_screen: "off" }, "kitchen")).toEqual(["bar_screen"]);
    expect(missingNeeds(west4, "kitchen")).toEqual([]);
    expect(turnsOffWith(singSing, "bar_screen")).toEqual(["room_ordering", "kitchen"]);
    expect(turnsOffWith({ ...singSing, room_ordering: "off" }, "bar_screen")).toEqual(["kitchen"]);
    // West 4 has no kitchen: nothing new turns off with Bar screen & tickets.
    expect(turnsOffWith(west4, "bar_screen")).toEqual(["room_ordering"]);
    // Nothing needs Ordering from the room's switch for food: no separate guest food switch.
    expect(turnsOffWith(singSing, "room_ordering")).toEqual([]);
    expect(turnsOffWith(singSing, "kitchen")).toEqual([]);
  });

  it("Kitchen & food stays off until a kitchen printer is paired and the allergy notice is set", () => {
    expect(kitchenMissing({ kitchenPrinter: false, allergyNotice: false })).toEqual([
      "printer",
      "allergyNotice",
    ]);
    expect(kitchenMissing({ kitchenPrinter: true, allergyNotice: false })).toEqual([
      "allergyNotice",
    ]);
    expect(kitchenMissing({ kitchenPrinter: true, allergyNotice: true })).toEqual([]);
    expect(modules.find((m) => m.id === "kitchen")?.hides.website).toContain("allergyNotice");
  });

  it("Online booking & deposits' row (M5-14): Deposits & cancelling, Book, the hero and nav button, Payment link and Deposit refund", () => {
    expect(modules.find((m) => m.id === "online_booking")?.hides).toEqual({
      staffApp: ["admin.deposits"],
      staffPhone: [],
      website: ["book", "manage.newBookings", "hero.bookARoom"],
      texts: [],
    });
    // The deposit's own switch (D124) carries the deposit texts.
    expect(modules.find((m) => m.id === "deposits")?.hides.texts).toEqual([
      "payment_link",
      "deposit_refund_new",
    ]);
    expect(catalogs.en["module.online_booking.hides.website"]).toContain('"Call to book"');
    expect(catalogs.en["module.deposits.hides.texts"]).toBe(
      "Payment link, and Deposit refund for new bookings",
    );
  });
});

describe("what each plan allows (O-04)", () => {
  it("Bar allows no room module; Rooms adds the rooms; only Rooms + Kitchen allows the kitchen", () => {
    expect(PLAN_MODULES.bar).not.toContain("rooms");
    expect(PLAN_MODULES.bar).toEqual([
      "bar_mode",
      "bar_screen",
      "team",
      "guest_texts",
      "cash_discount",
    ]);
    expect(PLAN_MODULES.rooms).toEqual(
      expect.arrayContaining(["deposits", "room_tablets", "card_behind_bar", "pay_share"]),
    );
    expect(PLAN_MODULES.rooms).toEqual(
      expect.arrayContaining(["rooms", "online_booking", "room_ordering", "packages", "waitlist"]),
    );
    expect(PLAN_MODULES.rooms).not.toContain("kitchen");
    expect(PLAN_MODULES.rooms_kitchen).toContain("kitchen");
    // No plan decides a core module. The website, Safety & ID records, Marketing texts and the
    // outside card machine are in every plan (D129): always allowed, off until the owner turns them on.
    for (const m of PLAN_GOVERNED_MODULES) expect(moduleDef(m).core).toBe(false);
    for (const m of ["safety", "website", "marketing_texts", "outside_card"] as const) {
      expect(PLAN_GOVERNED_MODULES).not.toContain(m);
      expect(moduleDef(m).allowedOff).toBe(true);
    }
  });

  it("a plan switches on what it newly includes, each after what it needs (D121)", () => {
    const first = planSwitchesOn("rooms_kitchen", null);
    expect(first).toEqual(expect.arrayContaining([...PLAN_MODULES.rooms_kitchen]));
    expect(first).toHaveLength(PLAN_MODULES.rooms_kitchen.length);
    for (const m of first)
      for (const need of moduleDef(m).needs)
        expect(first.indexOf(need)).toBeLessThan(first.indexOf(m));
    // Bar to Rooms switches on only the room modules; the same plan again switches on nothing.
    expect(planSwitchesOn("rooms", "bar")).toEqual(
      expect.arrayContaining([
        "rooms",
        "online_booking",
        "room_ordering",
        "packages",
        "song_system",
        "waitlist",
      ]),
    );
    expect(planSwitchesOn("rooms", "bar")).not.toContain("bar_tabs");
    expect(planSwitchesOn("rooms", "rooms")).toEqual([]);
    expect(planSwitchesOn("bar", "rooms_kitchen")).toEqual([]);
  });
});
