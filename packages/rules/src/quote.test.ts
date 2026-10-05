import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { bookingQuote } from "./quote.js";
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
const small = { id: "room_3", sizeTier: "s" };
const vipRoom = { id: "room_vip", sizeTier: "vip" };
const quote = (start: string, hours: number, partySize: number, room = small) => {
  const s = Temporal.Instant.from(start);
  return bookingQuote({
    start: s,
    end: s.add({ minutes: hours * 60 }),
    partySize,
    room,
    prices: WEST4_PRICES,
    venue: WEST4_TIME,
    deposit: WEST4_DEPOSIT,
    taxRatePct: "8.875",
    gratuityPct: 20,
  });
};

/** M5-07 (Payment flows · the booking page; Money rules 2, 3 and 11), written before the code. */
describe("bookingQuote", () => {
  it("Jae & co.: 5 guests, Fri Sep 25, 11:00 PM, 2 hours: $100.00 + $8.88 + $20.00 = $128.88, $50.00 deposit", () => {
    const q = quote("2026-09-25T23:00:00-04:00", 2, 5);
    expect(q).toMatchObject({
      billableGuests: 5,
      minutes: 120,
      roomTimeCents: 10000,
      taxCents: 888,
      gratuityCents: 2000,
      totalCents: 12888,
      depositCents: 5000,
    });
    expect(q.businessDate.toString()).toBe("2026-09-25");
  });

  it("a party of 3 on a Friday bills as 4 and pays a $40.00 deposit; on a Wednesday $30.00", () => {
    expect(quote("2026-09-25T22:00:00-04:00", 1, 3)).toMatchObject({
      minGuests: 4,
      billableGuests: 4,
      roomTimeCents: 4000,
      depositCents: 4000,
    });
    expect(quote("2026-09-23T22:00:00-04:00", 1, 3)).toMatchObject({
      billableGuests: 3,
      depositCents: 3000,
    });
  });

  it("matches the seed's deposits group (deposit_party* cases)", () => {
    const cases = moneyCases.cases.filter(
      (c) => c.group === "deposits" && c.id.startsWith("deposit_party"),
    );
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const c of cases) {
      const date = c.inputs["business_date"] as string;
      const party = c.inputs["party_size"] as number;
      const q = quote(`${date}T22:00:00-04:00`, 1, party, party >= 20 ? vipRoom : small);
      expect(q.depositCents, c.id).toBe(c.expected["deposit_cents"]);
      expect(q.billableGuests, c.id).toBe(c.expected["billable_guests"]);
    }
  });

  it("bills real minutes: 2 hours across the fall-back hour are 120 minutes on the clock that ran", () => {
    // Sat Oct 31 night: 12:30 AM EDT to 1:30 AM EST is two real hours.
    const q = quote("2026-11-01T00:30:00-04:00", 2, 5);
    expect(q.minutes).toBe(120);
    expect(q.roomTimeCents).toBe(10000);
    expect(q.businessDate.toString()).toBe("2026-10-31");
  });
});
