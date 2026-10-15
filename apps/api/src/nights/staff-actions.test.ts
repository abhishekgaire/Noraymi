import { describe, expect, it } from "vitest";
import { groupStaffActions, type StaffActionRow } from "./staff-actions.js";

const row = (over: Partial<StaffActionRow>): StaffActionRow => ({
  user_id: "u-maya",
  name: "Maya S.",
  kind: "comp",
  at: "2026-09-26T02:00:00Z",
  business_date: "2026-09-25",
  where: "Room 9",
  what: "Coke",
  why: "Spilled",
  cents: -350,
  approved_by: null,
  ...over,
});

describe("staff actions grouped by person (P-09)", () => {
  it("counts and sums each kind from the person's own rows, to the cent", () => {
    const people = groupStaffActions([
      row({}),
      row({ at: "2026-09-26T03:00:00Z", cents: -1200, approved_by: "Andy C." }),
      row({ kind: "void", cents: -899 }),
      row({ user_id: "u-diego", name: "Diego R.", kind: "no_sale", cents: 0, where: "Bar" }),
      row({ user_id: "u-diego", name: "Diego R.", kind: "over_short", cents: 250 }),
      row({ user_id: "u-diego", name: "Diego R.", kind: "over_short", cents: -400 }),
    ]);
    expect(people.map((p) => p.name)).toEqual(["Diego R.", "Maya S."]);
    const maya = people[1]!;
    expect(maya.actions).toEqual({
      comp: { count: 2, cents: -1550 },
      void: { count: 1, cents: -899 },
    });
    expect(people[0]!.actions.over_short).toEqual({ count: 2, cents: -150 });
    for (const p of people)
      for (const [kind, a] of Object.entries(p.actions))
        expect(
          p.entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount_cents, 0),
        ).toBe(a.cents);
  });

  it("lists each person's actions in time order with who approved each", () => {
    const [maya] = groupStaffActions([
      row({ at: "2026-09-26T03:00:00Z", approved_by: "Andy C." }),
      row({ at: "2026-09-26T01:00:00Z", kind: "discount", what: "10%", cents: -1580 }),
    ]);
    expect(maya!.entries.map((e) => [e.kind, e.approved_by])).toEqual([
      ["discount", null],
      ["comp", "Andy C."],
    ]);
  });

  it("keeps two people with the same name apart", () => {
    const people = groupStaffActions([row({}), row({ user_id: "u-maya-2" })]);
    expect(people).toHaveLength(2);
  });

  it("answers nobody for no rows", () => {
    expect(groupStaffActions([])).toEqual([]);
  });
});
