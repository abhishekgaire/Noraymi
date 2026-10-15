import { describe, expect, it } from "vitest";
import { actions, defaultPermissions, modules, t, type Action } from "@west4/shared";
import {
  ADMIN_GROUPS,
  MODULE_GROUP,
  SECTION_GROUP,
  byGroup,
  groupLabelKey,
  sectionGroup,
} from "./groups.js";
import { adminSections, visibleSections } from "./sections.js";

const ownerPermissions: Action[] = actions.filter((a) => defaultPermissions[a].owner);

describe("Admin's groups (U-21)", () => {
  it("puts every Admin section in exactly one group, and names no section that doesn't exist", () => {
    const ids = adminSections.map((s) => s.id).sort();
    expect(Object.keys(SECTION_GROUP).sort()).toEqual(ids);
  });

  it("puts every phase 1 module in a group, the switches reading as six short groups", () => {
    const phase1 = modules.filter((m) => m.phase1);
    const groups = byGroup(phase1, (m) => MODULE_GROUP[m.id]);
    expect(groups.map((g) => g.group)).toEqual([...ADMIN_GROUPS]);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(phase1.length);
    for (const g of groups) expect(g.items.length).toBeLessThanOrEqual(8);
  });

  it("groups the owner's sections in the six groups' order without losing or adding one", () => {
    const owner = visibleSections(ownerPermissions, { role: "owner" });
    const grouped = byGroup(owner, (s) => sectionGroup(s.id));
    expect(grouped.map((g) => g.group)).toEqual([...ADMIN_GROUPS]);
    expect(grouped.flatMap((g) => g.items).length).toBe(owner.length);
    expect(grouped.find((g) => g.group === "rooms")?.items.map((s) => s.id)).toEqual([
      "hours",
      "rooms",
      "alerts",
    ]);
  });

  it("keeps a granted person's groups to what they were given (P-10)", () => {
    const bartender = actions.filter((a) => defaultPermissions[a].bartender);
    const maya = visibleSections(bartender, { role: "bartender", granted: ["menu"] });
    expect(byGroup(maya, (s) => sectionGroup(s.id))).toEqual([{ group: "bar", items: maya }]);
  });

  it("names every group in English and Spanish", () => {
    for (const g of ADMIN_GROUPS) {
      expect(t("en", groupLabelKey(g))).toBeTruthy();
      expect(t("es", groupLabelKey(g))).toBeTruthy();
    }
    expect(t("es", "admin.group.rooms")).toBe("Salas");
  });
});
