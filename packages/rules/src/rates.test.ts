import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Temporal, cents } from "@west4/shared";
import { deposit } from "./deposit.js";
import { hourlyRateAt } from "./rates.js";
import { tabSoFar } from "./tab.js";
import { WEST4_DEPOSIT, WEST4_PRICES, WEST4_TIME } from "./west4-fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const moneyCases = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: Record<string, unknown>;
    expected: Record<string, unknown>;
  }[];
};
const group = (name: string) => moneyCases.cases.filter((c) => c.group === name);
const room = (vip: boolean) => ({ id: vip ? "room_vip" : "room_1", sizeTier: vip ? "vip" : "m" });

/**
 * M2-02 (spec 05 · rules 2, 3 and 11), written before the code: billable
 * guests by business date, the VIP flat rate from 20, tab so far as room
 * time plus the lines so far, and the deposit as the first hour or the
 * big-party flat amount.
 */
describe("hourlyRateAt · the seed's billable_guests group", () => {
  const cases = group("billable_guests");
  it("has the 14 cases the ticket names", () => expect(cases).toHaveLength(14));
  for (const c of cases) {
    it(c.id, () => {
      const out = hourlyRateAt(
        Temporal.Instant.from(c.inputs["local_time"] as string),
        c.inputs["party_size"] as number,
        room(c.inputs["is_vip_room"] as boolean),
        WEST4_PRICES,
        WEST4_TIME,
      );
      expect(out.businessDate.toString()).toBe(c.expected["business_date"]);
      expect(out.minGuests).toBe(c.expected["min_guests"]);
      expect(out.billableGuests).toBe(c.expected["billable_guests"]);
      expect(out.rateKind).toBe(c.expected["rate_kind"]);
      expect(out.hourlyCents).toBe(c.expected["hourly_cents"]);
    });
  }
});

describe("tabSoFar · the seed's tab_so_far group", () => {
  const cases = group("tab_so_far");
  it("has the 8 rooms in use", () => expect(cases).toHaveLength(8));
  for (const c of cases) {
    it(c.id, () => {
      const now = Temporal.Instant.from(c.inputs["now"] as string);
      const minutes = c.inputs["minutes"] as number;
      const rate = hourlyRateAt(
        now,
        c.inputs["party_size"] as number,
        room(c.inputs["is_vip_room"] as boolean),
        WEST4_PRICES,
        WEST4_TIME,
      );
      expect(rate.billableGuests).toBe(c.expected["billable_guests"]);
      expect(rate.rateKind).toBe(c.expected["rate_kind"]);
      expect(rate.hourlyCents).toBe(c.expected["hourly_cents"]);
      const lines = (c.inputs["drink_lines"] as { qty: number; unit_cents: number }[]).map((l) => ({
        qty: l.qty,
        unitCents: cents(l.unit_cents),
      }));
      const out = tabSoFar(
        {
          segments: [],
          open: { startedAt: now.subtract({ minutes }), hourlyCents: rate.hourlyCents },
          firstHourMinimum: WEST4_PRICES.firstHourMinimum,
        },
        lines,
        now,
      );
      expect(out.roomTimeCents).toBe(c.expected["room_time_cents"]);
      expect(out.linesCents).toBe(c.expected["drinks_cents"]);
      expect(out.tabSoFarCents).toBe(c.expected["tab_so_far_cents"]);
    });
  }
});

describe("deposit · the seed's deposits group", () => {
  const cases = group("deposits").filter((c) => c.id !== "deposit_larger_than_check_forfeit");
  it("has the 8 booking cases (the forfeit case is M4's)", () => expect(cases).toHaveLength(8));
  for (const c of cases) {
    it(c.id, () => {
      const out = deposit(
        c.inputs["party_size"] as number,
        Temporal.PlainDate.from(c.inputs["business_date"] as string),
        WEST4_DEPOSIT,
        WEST4_PRICES,
      );
      expect(out.billableGuests).toBe(c.expected["billable_guests"]);
      expect(out.depositCents).toBe(c.expected["deposit_cents"]);
      expect(out.rule).toBe(c.expected["rule"]);
    });
  }
});

describe("the other rate modes and deposit modes", () => {
  const fri = Temporal.Instant.from("2026-09-25T22:00:00-04:00");
  it("base plus extra: $30 for up to 3, $10 each after", () => {
    const prices = {
      ...WEST4_PRICES,
      rate: { mode: "basePlusExtra" as const, baseCents: 3000, baseGuests: 3, extraCents: 1000 },
    };
    expect(hourlyRateAt(fri, 2, room(false), prices, WEST4_TIME)).toMatchObject({
      billableGuests: 4,
      rateKind: "base_plus_extra",
      hourlyCents: 4000,
    });
    expect(hourlyRateAt(fri, 7, room(false), prices, WEST4_TIME).hourlyCents).toBe(7000);
  });
  it("flat by size: the room's tier decides; a tier with no price is an error", () => {
    const prices = {
      ...WEST4_PRICES,
      rate: { mode: "flatBySize" as const, bySizeCents: { m: 6000 } },
    };
    expect(hourlyRateAt(fri, 2, room(false), prices, WEST4_TIME)).toMatchObject({
      rateKind: "flat_by_size",
      hourlyCents: 6000,
    });
    expect(() =>
      hourlyRateAt(fri, 2, { id: "room_2", sizeTier: "xl" }, prices, WEST4_TIME),
    ).toThrow(/no price for size tier "xl"/);
  });
  it("a VIP party in an ordinary room pays the normal rate", () => {
    expect(hourlyRateAt(fri, 22, room(false), WEST4_PRICES, WEST4_TIME)).toMatchObject({
      rateKind: "per_person",
      hourlyCents: 22000,
    });
  });
  it("deposit modes: per person, flat, percent of the first hour, and a card hold charges nothing", () => {
    const day = Temporal.PlainDate.from("2026-09-25");
    const rule = (mode: "perPerson" | "flat" | "percent" | "cardHold", value: number) => ({
      ...WEST4_DEPOSIT,
      mode,
      value,
      bigParty: null,
    });
    expect(deposit(3, day, rule("perPerson", 1500), WEST4_PRICES).depositCents).toBe(6000);
    expect(deposit(3, day, rule("flat", 5000), WEST4_PRICES).depositCents).toBe(5000);
    expect(deposit(3, day, rule("percent", 25), WEST4_PRICES).depositCents).toBe(1000);
    expect(deposit(3, day, rule("cardHold", 0), WEST4_PRICES)).toMatchObject({
      depositCents: 0,
      rule: "card hold: a card is saved and nothing is charged",
    });
    expect(deposit(3, day, { ...WEST4_DEPOSIT, on: false }, WEST4_PRICES).depositCents).toBe(0);
  });
  it("a big-party percent deposit is taken on the first hour's room cost", () => {
    const rule = {
      ...WEST4_DEPOSIT,
      bigParty: { fromGuests: 20, deposit: { kind: "pct" as const, pct: 50 }, refundHours: 24 },
    };
    expect(deposit(20, Temporal.PlainDate.from("2026-09-25"), rule, WEST4_PRICES)).toMatchObject({
      depositCents: 10000,
      rule: "big party: 50% of the first hour from 20 guests",
    });
  });
  it("tabSoFar counts closed segments, the open one to now, and every line, never a ringing order", () => {
    const start = Temporal.Instant.from("2026-09-25T20:00:00-04:00");
    const out = tabSoFar(
      {
        segments: [{ minutes: 60, hourlyCents: cents(4000) }],
        open: { startedAt: start, hourlyCents: cents(5000) },
        firstHourMinimum: true,
      },
      [{ qty: 2, unitCents: cents(1300) }],
      start.add({ minutes: 30 }),
    );
    expect(out).toEqual({
      minutes: 90,
      roomTimeCents: 6500,
      linesCents: 2600,
      tabSoFarCents: 9100,
    });
  });
});
