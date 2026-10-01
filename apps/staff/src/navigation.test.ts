import { describe, expect, it } from "vitest";
import {
  actions,
  defaultPermissions,
  roles,
  type Action,
  type ModuleStates,
  type Role,
} from "@west4/shared";
import { hiddenScreens, homeFor, menu, visibleMenu } from "./navigation.js";

const allowedFor = (role: Role): Action[] => actions.filter((a) => defaultPermissions[a][role]);
const everythingOn: ModuleStates = Object.fromEntries(
  ["rooms", "bar_screen", "bar_tabs", "bar_mode", "guest_texts", "reports", "team"].map((id) => [
    id,
    "on",
  ]),
) as ModuleStates;

describe("the side menu", () => {
  it("lists the spec's entries in the spec's order", () => {
    expect(menu.map((e) => e.id)).toEqual([
      "tonight",
      "barPos",
      "barOrders",
      "songQueue",
      "calendar",
      "messages",
      "reports",
      "closeNight",
      "admin",
      "lock",
    ]);
  });

  it("shows a manager everything that's on, and a bartender nothing a manager keeps", () => {
    const manager = visibleMenu({
      modules: everythingOn,
      permissions: allowedFor("manager"),
      includeUnshipped: true,
    });
    expect(manager.map((e) => e.id)).toEqual(menu.map((e) => e.id));
    const bartender = visibleMenu({
      modules: everythingOn,
      permissions: allowedFor("bartender"),
      includeUnshipped: true,
    });
    // Bartenders book and text (spec 02 defaults) but never close the night, read reports or open Admin.
    expect(bartender.map((e) => e.id)).toEqual([
      "tonight",
      "barPos",
      "barOrders",
      "songQueue",
      "calendar",
      "messages",
      "lock",
    ]);
  });

  it("shows the song queue only in bar mode", () => {
    const off = visibleMenu({
      modules: { ...everythingOn, bar_mode: "off" },
      permissions: allowedFor("manager"),
      includeUnshipped: true,
    });
    expect(off.map((e) => e.id)).not.toContain("songQueue");
    const stopping = visibleMenu({
      modules: { ...everythingOn, bar_mode: "stopping" },
      permissions: allowedFor("manager"),
      includeUnshipped: true,
    });
    expect(stopping.map((e) => e.id)).toContain("songQueue");
  });

  it("hides what an off module hides, and only shipped screens by default", () => {
    expect(hiddenScreens({ ...everythingOn, reports: "off" })).toContain("reports");
    expect(hiddenScreens(everythingOn).has("board")).toBe(false);
    const shipped = visibleMenu({ modules: everythingOn, permissions: allowedFor("owner") });
    expect(shipped.every((e) => e.shipped)).toBe(true);
    expect(shipped.map((e) => e.id)).toContain("lock");
  });

  it("sends each role to its home", () => {
    expect(roles.map((r) => [r, homeFor(r)])).toEqual([
      ["owner", "/tonight"],
      ["manager", "/tonight"],
      ["bartender", "/bar"],
      ["front_desk", "/tonight"],
      ["staff", "/runs"],
    ]);
  });
});
