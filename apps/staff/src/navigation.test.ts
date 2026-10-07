import { describe, expect, it } from "vitest";
import {
  actions,
  defaultPermissions,
  roles,
  type Action,
  type ModuleStates,
  type Role,
} from "@west4/shared";
import { hiddenScreens, homeFor, menu, phoneTabs, visibleMenu } from "./navigation.js";

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

describe("the staff phone's tabs (M2-32)", () => {
  const tabsFor = (role: Role, modules: ModuleStates = everythingOn) =>
    phoneTabs({ role, modules, permissions: allowedFor(role) }).map((t) => t.id);

  it("a manager's phone: Tonight, Rooms, Calls, Waitlist, Messages, Approvals, Tips to enter, Clock in and out, Alerts and Admin", () => {
    expect(tabsFor("manager")).toEqual([
      "tonight",
      "rooms",
      "calls",
      "waitlist",
      "messages",
      "approvals",
      "incidents",
      "tips",
      "clock",
      "mytips",
      "reports",
      "offlineCodes",
      "alerts",
      "admin",
    ]);
  });

  it("Offline codes (M8-04) are on managers' and owners' phones only", () => {
    for (const role of roles)
      expect(tabsFor(role).includes("offlineCodes")).toBe(role === "owner" || role === "manager");
  });

  it("Incidents (M8-08) are on managers' and owners' phones only, and leave with Safety & ID records off", () => {
    for (const role of roles) {
      expect(tabsFor(role).includes("incidents")).toBe(role === "owner" || role === "manager");
      expect(tabsFor(role, { ...everythingOn, safety: "off" })).not.toContain("incidents");
    }
  });

  it("Clock in and out (M7-01) and My tips (M7-10) leave every phone with Team, time clock & tips off", () => {
    for (const role of roles) {
      expect(tabsFor(role)).toContain("clock");
      expect(tabsFor(role)).toContain("mytips");
      expect(tabsFor(role, { ...everythingOn, team: "off" })).not.toContain("clock");
      expect(tabsFor(role, { ...everythingOn, team: "off" })).not.toContain("mytips");
    }
  });

  it("Tips to enter (M6-09) is on the phones that use the bar POS, while bar tabs are on", () => {
    expect(tabsFor("bartender")).toContain("tips");
    expect(tabsFor("staff")).not.toContain("tips");
    expect(tabsFor("manager", { ...everythingOn, bar_tabs: "off" })).not.toContain("tips");
  });

  it("a runner's phone: Runs, check-in and the waitlist, and Calls; no Approvals, no Rooms", () => {
    expect(tabsFor("staff")).toEqual([
      "home",
      "tonight",
      "calls",
      "waitlist",
      "clock",
      "mytips",
      "alerts",
    ]);
  });

  it("every staff phone gets Calls; only managers and owners get Approvals", () => {
    for (const role of roles) {
      expect(tabsFor(role)).toContain("calls");
      expect(tabsFor(role).includes("approvals")).toBe(role === "owner" || role === "manager");
    }
  });

  it("turning off Walk-in waitlist removes the Waitlist tab", () => {
    expect(tabsFor("front_desk", { ...everythingOn, waitlist: "off" })).not.toContain("waitlist");
  });
});
