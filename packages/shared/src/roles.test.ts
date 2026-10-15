import { describe, expect, it } from "vitest";
import { catalogs } from "./i18n/index.js";
import {
  actions,
  defaultPermissions,
  isGrantableAdminSection,
  permissionFor,
  roles,
  settingsKeySections,
  type Action,
  type Role,
} from "./roles.js";
import { pinAgainActions, pinAgainSchema, settingsDefaults } from "./settings.js";

// The spec's table (Tenancy and access · Roles), as ✓ per role. "✓ when covering the bar" counts as ✓ here; Admin can switch it off.
const table: Record<Action, Role[]> = {
  "payments.take": ["owner", "manager", "bartender", "front_desk"],
  "pos.use": ["owner", "manager", "bartender", "front_desk"],
  "orders.accept": ["owner", "manager", "bartender", "front_desk"],
  "guests.checkin": ["owner", "manager", "bartender", "front_desk", "staff"],
  "waitlist.manage": ["owner", "manager", "bartender", "front_desk", "staff"],
  "bookings.manage": ["owner", "manager", "bartender", "front_desk"],
  "texts.send": ["owner", "manager", "bartender", "front_desk"],
  "runs.carry": ["owner", "manager", "bartender", "front_desk", "staff"],
  "comps.reasonOnly": ["owner", "manager", "bartender", "front_desk"],
  "cutoff.apply": ["owner", "manager", "bartender", "front_desk"],
  "approvals.decide": ["owner", "manager"],
  "refunds.request": ["owner", "manager"],
  "drawer.count": ["owner", "manager", "bartender", "front_desk"],
  "night.close": ["owner", "manager"],
  "reports.view": ["owner", "manager"],
  "admin.access": ["owner", "manager"],
  "admin.payments": ["owner"],
  "admin.team": ["owner"],
  "admin.console": ["owner"],
  "tips.share": ["bartender", "front_desk", "staff"],
};

describe("the default permission table", () => {
  it("allows or refuses each action for each of the five roles exactly as the spec's table says", () => {
    for (const action of actions) {
      for (const role of roles) {
        expect(defaultPermissions[action][role], `${action} / ${role}`).toBe(
          table[action].includes(role),
        );
      }
    }
    expect(Object.keys(table).sort()).toEqual([...actions].sort());
  });

  it("a runner gets check-in, the waitlist and runs only, and no Admin action", () => {
    const runner = actions.filter((a) => defaultPermissions[a].staff);
    expect(runner.sort()).toEqual([
      "guests.checkin",
      "runs.carry",
      "tips.share",
      "waitlist.manage",
    ]);
    for (const role of ["bartender", "front_desk", "staff"] as const) {
      for (const a of ["admin.access", "admin.payments", "admin.team", "admin.console"] as const)
        expect(defaultPermissions[a][role]).toBe(false);
    }
    expect(defaultPermissions["admin.team"].manager).toBe(false);
  });

  it("a venue's override wins over the default", () => {
    expect(permissionFor([], "front_desk", "pos.use").allowed).toBe(true);
    expect(
      permissionFor(
        [{ role: "front_desk", action: "pos.use", allowed: false, needsApproval: false }],
        "front_desk",
        "pos.use",
      ).allowed,
    ).toBe(false);
    expect(
      permissionFor(
        [{ role: "front_desk", action: "pos.use", allowed: false, needsApproval: false }],
        "bartender",
        "pos.use",
      ).allowed,
    ).toBe(true);
  });

  it("every role and action has a name in English and Spanish", () => {
    for (const r of roles) {
      expect(catalogs.en[`role.${r}` as keyof typeof catalogs.en]).toBeTruthy();
      expect(catalogs.es[`role.${r}` as keyof typeof catalogs.es]).toBeTruthy();
    }
    for (const a of actions) {
      expect(catalogs.en[`permission.${a}` as keyof typeof catalogs.en], a).toBeTruthy();
      expect(catalogs.es[`permission.${a}` as keyof typeof catalogs.es], a).toBeTruthy();
    }
  });
});

describe("P-10 · Can also open and Ask for the PIN again", () => {
  it("never grants Payments, Team or Console, and maps each section's settings keys to it", () => {
    for (const s of ["payments", "team", "console"]) expect(isGrantableAdminSection(s)).toBe(false);
    expect(settingsKeySections["prices"]).toBe("hours");
    expect(settingsKeySections["drawer"]).toBe("cashDrawers");
    // Keys that hold limits or owner choices open with no grant.
    for (const k of ["pos", "pay", "approvals", "pinAgain", "contacts", "tabs"])
      expect(settingsKeySections[k]).toBeUndefined();
    for (const s of Object.values(settingsKeySections))
      expect(isGrantableAdminSection(s)).toBe(true);
  });

  it("asks for the PIN again on no-sale alone by default, and takes each action once", () => {
    expect(settingsDefaults.pinAgain).toEqual({ actions: ["no_sale"] });
    expect(pinAgainSchema.safeParse({ actions: [...pinAgainActions] }).success).toBe(true);
    expect(pinAgainSchema.safeParse({ actions: ["void", "void"] }).success).toBe(false);
    expect(pinAgainSchema.safeParse({ actions: ["admin"] }).success).toBe(false);
    expect(pinAgainSchema.safeParse({ actions: [] }).success).toBe(true);
  });
});
