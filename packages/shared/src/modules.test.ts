import { describe, expect, it } from "vitest";
import { catalogs } from "./i18n/index.js";
import {
  missingNeeds,
  moduleIds,
  modules,
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
};

describe("modules", () => {
  it("lists the 23 modules spec 03 names, with the four core ones always on", () => {
    expect(moduleIds).toHaveLength(23);
    expect(modules.filter((m) => m.core).map((m) => m.id)).toEqual([
      "payments",
      "alcohol",
      "admin",
      "devices",
    ]);
    expect(stateOf({}, "payments")).toBe("on");
    expect(stateOf({}, "rooms")).toBe("off");
    expect(modules.filter((m) => !m.phase1).map((m) => m.id)).toEqual([
      "kitchen",
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
      bar_mode: ["bar_tabs"],
      marketing_texts: ["guest_texts"],
    });
  });

  it("turning off Rooms & room clock at West 4 lists Online booking & deposits, Ordering from the room and Packages & specials", () => {
    expect(turnsOffWith(west4, "rooms")).toEqual(["online_booking", "room_ordering", "packages"]);
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
});
