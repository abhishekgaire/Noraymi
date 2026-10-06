import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { zReportGratuity, type ZCheck } from "./z-report.js";

interface Row {
  id: string;
  room_time_cents?: number;
  drinks_cents: number;
  comps_cents?: number;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const moneyCases = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: { room_checks: Row[]; bar_tabs: Row[]; training_checks: Row[] };
    expected: {
      room_check_gratuity_lines_cents: Record<string, number>;
      z_gratuity_cents: number;
      bar_tab_gratuity_cents: number;
      drinks_room_checks_cents: number;
      drinks_bar_tabs_cents: number;
      excluded_training_checks: string[];
    };
    must_not_equal?: { z_gratuity_cents: number };
  }[];
};

const toCheck = (kind: ZCheck["kind"], training: boolean) => (r: Row) => ({
  id: r.id,
  kind,
  training,
  roomTimeCents: r.room_time_cents ?? 0,
  drinksCents: r.drinks_cents,
  compsCents: r.comps_cents ?? 0,
});

describe("Z report gratuity (money-cases group z_report)", () => {
  const cases = moneyCases.cases.filter((c) => c.group === "z_report");
  it("has the four cases", () => expect(cases.length).toBe(4));
  for (const c of cases)
    it(c.id, () => {
      const z = zReportGratuity([
        ...c.inputs.room_checks.map(toCheck("room", false)),
        ...c.inputs.bar_tabs.map(toCheck("bar", false)),
        // A practice check is a room check too: the flag alone keeps it out.
        ...c.inputs.training_checks.map(toCheck("room", true)),
      ]);
      expect(z.roomCheckGratuityLinesCents).toEqual(c.expected.room_check_gratuity_lines_cents);
      expect(z.zGratuityCents).toBe(c.expected.z_gratuity_cents);
      expect(z.barTabGratuityCents).toBe(c.expected.bar_tab_gratuity_cents);
      expect(z.drinksRoomChecksCents).toBe(c.expected.drinks_room_checks_cents);
      expect(z.drinksBarTabsCents).toBe(c.expected.drinks_bar_tabs_cents);
      expect(z.excludedTrainingChecks).toEqual(c.expected.excluded_training_checks);
      if (c.must_not_equal) expect(z.zGratuityCents).not.toBe(c.must_not_equal.z_gratuity_cents);
    });

  it("leaves T-0012 out even when it's the only check", () => {
    const z = zReportGratuity([
      { id: "T-0012", kind: "room", training: true, roomTimeCents: 4000, drinksCents: 1200 },
    ]);
    expect(z.zGratuityCents).toBe(0);
    expect(z.roomCheckGratuityLinesCents).toEqual({});
  });
});
