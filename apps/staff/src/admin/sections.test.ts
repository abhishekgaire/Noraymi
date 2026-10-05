import { describe, expect, it } from "vitest";
import { defaultPermissions, actions, type Action, type Role } from "@west4/shared";
import { adminSections, visibleSections } from "./sections.js";

const permissionsOf = (role: Role): Action[] => actions.filter((a) => defaultPermissions[a][role]);

describe("the Admin sections", () => {
  it("shows the owner Team, and the manager everything except Team, Payments and Console", () => {
    const owner = visibleSections(permissionsOf("owner"), { includeUnshipped: true }).map(
      (s) => s.id,
    );
    expect(owner).toEqual([
      "team",
      "features",
      "hours",
      "devices",
      "rooms",
      "menu",
      "phone",
      "texts",
      "alerts",
      "safety",
      "connections",
      "payments",
      "cardFee",
      "disputes",
      "barPos",
      "deposits",
      "website",
      "console",
    ]);
    const manager = visibleSections(permissionsOf("manager"), { includeUnshipped: true }).map(
      (s) => s.id,
    );
    expect(manager).toEqual([
      "features",
      "hours",
      "devices",
      "rooms",
      "menu",
      "phone",
      "texts",
      "alerts",
      "safety",
      "connections",
      "cardFee",
      "disputes",
      "barPos",
      "deposits",
      "website",
    ]);
    expect(manager).not.toContain("team");
  });

  it("shows a bartender or the front desk nothing: Admin isn't theirs", () => {
    for (const role of ["bartender", "front_desk", "staff"] as const) {
      expect(visibleSections(permissionsOf(role), { includeUnshipped: true })).toEqual([]);
    }
  });

  it("lists only shipped sections by default, each with a hint", () => {
    const shipped = visibleSections(permissionsOf("owner"));
    expect(shipped.every((s) => s.shipped)).toBe(true);
    expect(adminSections.every((s) => s.hintKey.startsWith("admin.hint."))).toBe(true);
  });
});
