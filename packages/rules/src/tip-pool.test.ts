import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { Temporal } from "@west4/shared";
import { describe, expect, it } from "vitest";
import { poolMinutes, poolShares, type PoolWorker } from "./tip-pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = (
  JSON.parse(readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8")) as {
    cases: {
      id: string;
      function: string;
      inputs: { pool_cents: number; minutes: Record<string, number> };
      expected: { shares_cents: Record<string, number> };
    }[];
  }
).cases.filter((c) => c.function === "tip_pool");

const worker = (userId: string, minutes: number, extra: Partial<PoolWorker> = {}): PoolWorker => ({
  userId,
  role: "bartender",
  duty: "bar",
  minutes,
  eligible: true,
  ...extra,
});

describe("the tip pool", () => {
  it.each(cases.map((c) => [c.id, c] as const))("money case %s", (_id, c) => {
    const r = poolShares({
      method: "hours",
      workers: Object.entries(c.inputs.minutes).map(([u, m]) => worker(u, m)),
      gratuityCents: c.inputs.pool_cents,
      cardTipCents: 0,
      cashTipCents: 0,
    });
    expect(Object.fromEntries(r.shares.map((s) => [s.userId, s.gratuityCents]))).toEqual(
      c.expected.shares_cents,
    );
  });

  it("leaves owners and managers out whatever duty they worked, and a Manager-duty shift never counts", () => {
    const r = poolShares({
      method: "hours",
      workers: [
        worker("maya", 560),
        worker("diego", 330, { role: "front_desk", duty: "front_desk" }),
        worker("andy", 600, { role: "manager", duty: "manager" }),
        worker("abhishek", 120, { role: "owner", duty: "bar" }),
      ],
      gratuityCents: 9600,
      cardTipCents: 600,
      cashTipCents: 500,
    });
    expect(r.shares.map((s) => s.userId)).toEqual(["maya", "diego"]);
    expect(r.leftOut).toEqual([
      { userId: "andy", reason: "manager" },
      { userId: "abhishek", reason: "manager" },
    ]);
  });

  it("splits each source on its own by occupation share, then by minutes", () => {
    const r = poolShares({
      method: "hours",
      workers: [
        worker("maya", 300, { occupation: "bartender" }),
        worker("sam", 300, { occupation: "bartender" }),
        worker("rae", 600, { role: "staff", duty: "runner", occupation: "runner" }),
      ],
      occupations: [
        { code: "bartender", sharePct: 70 },
        { code: "runner", sharePct: 30 },
      ],
      gratuityCents: 10001,
      cardTipCents: 0,
      cashTipCents: 0,
    });
    expect(r.shares.map((s) => [s.userId, s.gratuityCents])).toEqual([
      ["maya", 3501],
      ["sam", 3500],
      ["rae", 3000],
    ]);
  });

  it("splits evenly among the people who worked, and gives a room's gratuity to its server", () => {
    const even = poolShares({
      method: "even",
      workers: [worker("a", 300), worker("b", 30), worker("c", 30)],
      gratuityCents: 10000,
      cardTipCents: 0,
      cashTipCents: 0,
    });
    expect(even.shares.map((s) => s.gratuityCents)).toEqual([3334, 3333, 3333]);
    const server = poolShares({
      method: "roomServer",
      workers: [worker("a", 300), worker("b", 300)],
      gratuityCents: 10000,
      cardTipCents: 0,
      cashTipCents: 0,
      roomGratuity: [
        { serverUserId: "a", cents: 6000 },
        { serverUserId: null, cents: 4000 },
      ],
    });
    expect(server.shares.map((s) => s.gratuityCents)).toEqual([8000, 2000]);
  });

  it("splits a negative source (a refund) the same way, sign kept", () => {
    const r = poolShares({
      method: "hours",
      workers: [worker("a", 2), worker("b", 1)],
      gratuityCents: -100,
      cardTipCents: 0,
      cashTipCents: 0,
    });
    expect(r.shares.map((s) => s.gratuityCents)).toEqual([-67, -33]);
  });

  it("always adds up to the cent for every source, and equal minutes never differ by more than a cent", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 900 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: -50_000, max: 500_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        fc.constantFrom("hours" as const, "even" as const),
        (minutes, gratuity, card, cash, method) => {
          const r = poolShares({
            method,
            workers: minutes.map((m, i) => worker(`p${i}`, m)),
            gratuityCents: gratuity,
            cardTipCents: card,
            cashTipCents: cash,
          });
          const sum = (k: "gratuityCents" | "cardTipCents" | "cashTipCents") =>
            r.shares.reduce((s, x) => s + x[k], 0);
          expect(sum("gratuityCents")).toBe(gratuity);
          expect(sum("cardTipCents")).toBe(card);
          expect(sum("cashTipCents")).toBe(cash);
          for (const a of r.shares)
            for (const b of r.shares)
              if (method === "even" || a.minutes === b.minutes)
                expect(Math.abs(a.gratuityCents - b.gratuityCents)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("counts a 4:00 PM to 4:30 AM shift on the fall-back night as 810 minutes", () => {
    const start = Temporal.ZonedDateTime.from(
      "2026-10-31T16:00[America/New_York]",
    ).epochMilliseconds;
    const end = Temporal.ZonedDateTime.from("2026-11-01T04:30[America/New_York]").epochMilliseconds;
    expect(poolMinutes(start, end, 0)).toBe(810);
  });
});
