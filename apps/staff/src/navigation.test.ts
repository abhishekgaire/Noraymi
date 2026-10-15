import { describe, expect, it } from "vitest";
import {
  actions,
  defaultPermissions,
  inMenuOrder,
  menuOrderSchema,
  staffMenuIds,
  roles,
  type Action,
  type ModuleStates,
  type Role,
} from "@west4/shared";
import {
  hiddenScreens,
  homeFor,
  menu,
  phoneDestinations,
  phoneMore,
  phoneTabLimit,
  phoneTabs,
  phoneTabsByRole,
  visibleMenu,
} from "./navigation.js";

const allowedFor = (role: Role): Action[] => actions.filter((a) => defaultPermissions[a][role]);
const everythingOn: ModuleStates = Object.fromEntries(
  ["rooms", "bar_screen", "bar_tabs", "bar_mode", "guest_texts", "reports", "team", "safety"].map(
    (id) => [id, "on"],
  ),
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
      "tips",
      "clock",
      "reports",
      "closeNight",
      "incidents",
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
      "tips",
      "clock",
      "lock",
    ]);
  });

  it("P-10: shows a bartender Admin once the owner gives them a section, and nothing else more", () => {
    const given = visibleMenu({
      modules: everythingOn,
      permissions: allowedFor("bartender"),
      adminSections: ["menu"],
      includeUnshipped: true,
    }).map((e) => e.id);
    expect(given).toContain("admin");
    expect(given).not.toContain("reports");
    expect(given).not.toContain("closeNight");
    const more = phoneMore({
      modules: everythingOn,
      permissions: allowedFor("bartender"),
      adminSections: ["menu"],
      role: "bartender",
    }).map((tab) => tab.id);
    expect(more).toContain("admin");
    expect(more).not.toContain("reports");
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
    expect(hiddenScreens({ ...everythingOn, guest_texts: "off" })).toContain("messages");
    // Reports & accounting is always on (D124): a stray "off" row hides nothing.
    expect(hiddenScreens({ ...everythingOn, reports: "off" })).not.toContain("reports");
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

describe("the staff phone's tabs (M2-32; U-19)", () => {
  const ctx = (role: Role, modules: ModuleStates = everythingOn) => ({
    role,
    modules,
    permissions: allowedFor(role),
  });
  const tabsFor = (role: Role, modules: ModuleStates = everythingOn) =>
    phoneTabs(ctx(role, modules)).map((t) => t.id);
  const moreFor = (role: Role, modules: ModuleStates = everythingOn) =>
    phoneMore(ctx(role, modules)).map((t) => t.id);
  // Everything a phone can reach: the tabs, then More's list.
  const reachFor = (role: Role, modules: ModuleStates = everythingOn) => [
    ...tabsFor(role, modules),
    ...moreFor(role, modules),
  ];

  it("U-19: each role's tabs follow the table: home first, then its most used, four at most", () => {
    expect(tabsFor("bartender")).toEqual(["home", "rooms", "calls", "messages"]);
    expect(tabsFor("front_desk")).toEqual(["rooms", "tonight", "calls", "messages"]);
    expect(tabsFor("staff")).toEqual(["home", "tonight", "calls", "waitlist"]);
    expect(tabsFor("manager")).toEqual(["rooms", "approvals", "calls", "messages"]);
    expect(tabsFor("owner")).toEqual(["rooms", "approvals", "reports", "calls"]);
    for (const role of roles) {
      expect(tabsFor(role).length).toBeLessThanOrEqual(phoneTabLimit);
      expect(phoneTabsByRole[role].length).toBeGreaterThan(phoneTabLimit);
    }
    expect(phoneTabs(ctx("bartender"))[0]?.path).toBe("/bar");
    expect(phoneTabs(ctx("staff"))[0]?.path).toBe("/runs");
  });

  it("U-19: nothing shows twice between the tabs and More, and More ends with Lock", () => {
    for (const role of roles) {
      for (const modules of [everythingOn, { ...everythingOn, guest_texts: "off" as const }]) {
        const paths = [...phoneTabs(ctx(role, modules)), ...phoneMore(ctx(role, modules))].map(
          (t) => t.path,
        );
        expect(new Set(paths).size, role).toBe(paths.length);
        expect(moreFor(role, modules).at(-1)).toBe("lock");
      }
    }
  });

  it("U-19: a bartender's More holds the side menu's other entries and the phone's own screens", () => {
    const more = moreFor("bartender");
    expect(more).toEqual(expect.arrayContaining(["barOrders", "songQueue", "tips", "clock"]));
    expect(more).toEqual(expect.arrayContaining(["mytips", "alerts", "lock"]));
    // The bar POS (home), the board (Rooms) and Messages are tabs, so More leaves them out.
    const paths = phoneMore(ctx("bartender")).map((t) => t.path);
    for (const tab of ["/bar", "/tonight", "/calls", "/messages"]) expect(paths).not.toContain(tab);
  });

  it("U-19: a switched-off feature lets the next name in the role's row take its place", () => {
    expect(tabsFor("bartender", { ...everythingOn, guest_texts: "off" })).toEqual([
      "home",
      "rooms",
      "calls",
      "tips",
    ]);
  });

  it("U-19: More keeps the venue's menu order (P-13)", () => {
    const order = phoneMore({ ...ctx("manager"), menuOrder: ["reports", "barOrders"] }).map(
      (t) => t.id,
    );
    expect(order.indexOf("reports")).toBeLessThan(order.indexOf("barOrders"));
    expect(order.indexOf("barOrders")).toBeLessThan(order.indexOf("barPos"));
    expect(order.at(-1)).toBe("lock");
  });

  it("names the board Rooms and tonight's bookings Bookings: never two Rooms, never Tonight (D111)", () => {
    for (const role of roles) {
      const keys = phoneDestinations(ctx(role)).map((t) => t.labelKey);
      expect(keys.filter((k) => k === "tabs.rooms").length).toBeLessThanOrEqual(1);
      expect(keys.some((k) => /tonight/i.test(k))).toBe(false);
    }
    expect(menu.find((m) => m.path === "/tonight")?.labelKey).toBe("menu.rooms");
  });

  it("Offline codes (M8-04) are on managers' and owners' phones only", () => {
    for (const role of roles)
      expect(reachFor(role).includes("offlineCodes")).toBe(role === "owner" || role === "manager");
  });

  it("Incidents (M8-08) are on managers' and owners' phones only, and leave with Safety & ID records off", () => {
    for (const role of roles) {
      const destinations = phoneDestinations(ctx(role)).map((t) => t.id);
      expect(destinations.includes("incidents")).toBe(role === "owner" || role === "manager");
      expect(reachFor(role, { ...everythingOn, safety: "off" })).not.toContain("incidents");
    }
  });

  it("Clock in and out (M7-01) leaves every phone with Team, time clock & tips off", () => {
    for (const role of roles) {
      expect(reachFor(role)).toContain("clock");
      expect(reachFor(role, { ...everythingOn, team: "off" })).not.toContain("clock");
      expect(reachFor(role, { ...everythingOn, team: "off" })).not.toContain("mytips");
    }
  });

  it("U-19: My tips (M7-10) only for those who share in tips (tips.share)", () => {
    for (const role of roles)
      expect(reachFor(role).includes("mytips"), role).toBe(allowedFor(role).includes("tips.share"));
    expect(reachFor("manager")).not.toContain("mytips");
    expect(reachFor("bartender")).toContain("mytips");
  });

  it("Tips to enter (M6-09) is on the phones that use the bar POS, while bar tabs are on", () => {
    expect(reachFor("bartender")).toContain("tips");
    expect(reachFor("staff")).not.toContain("tips");
    const own = (role: Role, modules: ModuleStates) =>
      phoneDestinations(ctx(role, modules)).map((t) => t.id);
    expect(own("manager", { ...everythingOn, bar_tabs: "off" })).not.toContain("tips");
  });

  it("a runner's phone: Runs, check-in and the waitlist, and Calls; no Approvals, no Rooms tab", () => {
    expect(tabsFor("staff")).not.toContain("rooms");
    expect(reachFor("staff")).not.toContain("approvals");
  });

  it("every staff phone gets Calls as a tab; only managers and owners get Approvals", () => {
    for (const role of roles) {
      expect(tabsFor(role)).toContain("calls");
      expect(reachFor(role).includes("approvals")).toBe(role === "owner" || role === "manager");
    }
  });

  it("turning off Walk-in waitlist removes the Waitlist tab", () => {
    expect(reachFor("front_desk", { ...everythingOn, waitlist: "off" })).not.toContain("waitlist");
    expect(reachFor("staff", { ...everythingOn, waitlist: "off" })).not.toContain("waitlist");
  });
});

describe("the venue's menu order (P-13)", () => {
  it("every entry but Lock can be moved, and the shared list names exactly the menu's entries", () => {
    expect([...staffMenuIds, "lock"]).toEqual(menu.map((e) => e.id));
  });

  it("puts the listed entries first, the rest after in the app's order, and Lock last", () => {
    const ids = inMenuOrder(menu, ["admin", "reports", "barPos"]).map((e) => e.id);
    expect(ids).toEqual([
      "admin",
      "reports",
      "barPos",
      "tonight",
      "barOrders",
      "songQueue",
      "calendar",
      "messages",
      "tips",
      "clock",
      "closeNight",
      "incidents",
      "lock",
    ]);
    expect(inMenuOrder(menu, []).map((e) => e.id)).toEqual(menu.map((e) => e.id));
    expect(inMenuOrder(menu, undefined).map((e) => e.id)).toEqual(menu.map((e) => e.id));
    // An id the app doesn't have any more is skipped, never shown.
    expect(inMenuOrder(menu, ["gone", "clock"]).map((e) => e.id)[0]).toBe("clock");
  });

  it("never shows a role an entry it can't open: the order only places what visibleMenu kept", () => {
    const bartender = visibleMenu({
      modules: everythingOn,
      permissions: allowedFor("bartender"),
      includeUnshipped: true,
    });
    const ids = inMenuOrder(bartender, ["admin", "reports", "clock", "barPos"]).map((e) => e.id);
    expect(ids).toEqual([
      "clock",
      "barPos",
      "tonight",
      "barOrders",
      "songQueue",
      "calendar",
      "messages",
      "tips",
      "lock",
    ]);
  });

  it("saves only known entries, each once, and never Lock", () => {
    expect(menuOrderSchema.safeParse({ order: ["admin", "tonight"] }).success).toBe(true);
    expect(menuOrderSchema.safeParse({ order: [] }).success).toBe(true);
    expect(menuOrderSchema.safeParse({ order: ["admin", "admin"] }).success).toBe(false);
    expect(menuOrderSchema.safeParse({ order: ["lock"] }).success).toBe(false);
    expect(menuOrderSchema.safeParse({ order: ["nope"] }).success).toBe(false);
    expect(menuOrderSchema.safeParse({ order: [], extra: 1 }).success).toBe(false);
  });
});
