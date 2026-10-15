import { describe, expect, it } from "vitest";
import {
  defaultPermissions,
  actions,
  grantableAdminSections,
  type Action,
  type Role,
} from "@west4/shared";
import { adminSections, visibleSections } from "./sections.js";

const permissionsOf = (role: Role): Action[] => actions.filter((a) => defaultPermissions[a][role]);

describe("the Admin sections", () => {
  it("shows the owner Team, and the manager everything except Team, Payments and Console", () => {
    const owner = visibleSections(permissionsOf("owner"), { includeUnshipped: true }).map(
      (s) => s.id,
    );
    expect(owner).toEqual([
      "team",
      "venue",
      "features",
      "hours",
      "devices",
      "cashDrawers",
      "rooms",
      "menu",
      "phone",
      "texts",
      "alerts",
      "safety",
      "licenses",
      "connections",
      "payments",
      "cardFee",
      "disputes",
      "barPos",
      "barMode",
      "deposits",
      "publicForms",
      "website",
      "console",
      "activity",
      "setup",
      "about",
    ]);
    const manager = visibleSections(permissionsOf("manager"), { includeUnshipped: true }).map(
      (s) => s.id,
    );
    expect(manager).toEqual([
      "features",
      "hours",
      "devices",
      "cashDrawers",
      "rooms",
      "menu",
      "phone",
      "texts",
      "alerts",
      "safety",
      "licenses",
      "connections",
      "cardFee",
      "disputes",
      "barPos",
      "barMode",
      "deposits",
      "publicForms",
      "website",
      "setup",
      "about",
    ]);
    expect(manager).not.toContain("team");
  });

  it("lists Admin → Kitchen after Bar mode only where the Console allows Kitchen & food (K-01)", () => {
    const west4 = visibleSections(permissionsOf("manager")).map((s) => s.id);
    expect(west4).not.toContain("kitchen");
    const singSing = visibleSections(permissionsOf("manager"), { allowedModules: ["kitchen"] }).map(
      (s) => s.id,
    );
    expect(singSing.slice(singSing.indexOf("barMode"), singSing.indexOf("barMode") + 2)).toEqual([
      "barMode",
      "kitchen",
    ]);
  });

  it("shows a bartender or the front desk nothing: Admin isn't theirs", () => {
    for (const role of ["bartender", "front_desk", "staff"] as const) {
      expect(visibleSections(permissionsOf(role), { includeUnshipped: true })).toEqual([]);
    }
  });

  it("P-10: shows a bartender only the sections the owner gave them, never Team, Payments or Console", () => {
    const maya = visibleSections(permissionsOf("bartender"), {
      role: "bartender",
      granted: ["menu", "hours", "team", "payments", "console", "venue"],
    }).map((s) => s.id);
    expect(maya).toEqual(["hours", "menu"]);
  });

  it("P-10: every grantable section is a real Admin section a manager's role already opens", () => {
    const manager = visibleSections(permissionsOf("manager"), {
      role: "manager",
      allowedModules: ["kitchen"],
    }).map((s) => s.id);
    for (const id of grantableAdminSections) expect(manager).toContain(id);
    for (const id of ["team", "payments", "console", "venue"])
      expect(grantableAdminSections as readonly string[]).not.toContain(id);
  });

  it("lists only shipped sections by default, each with a hint", () => {
    const shipped = visibleSections(permissionsOf("owner"));
    expect(shipped.every((s) => s.shipped)).toBe(true);
    expect(adminSections.every((s) => s.hintKey.startsWith("admin.hint."))).toBe(true);
  });
});
