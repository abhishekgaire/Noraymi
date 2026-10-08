import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Temporal } from "@west4/shared";
import { deposit } from "./deposit.js";
import { changedCutoff, depositChange } from "./deposit-change.js";
import { WEST4_DEPOSIT, WEST4_PRICES } from "./west4-fixtures.js";

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
const byId = (id: string) => moneyCases.cases.find((c) => c.id === id)!;
const fri = Temporal.PlainDate.from("2026-09-25");
const sat = Temporal.PlainDate.from("2026-09-26");
const dep = (party: number, on = fri) =>
  deposit(party, on, WEST4_DEPOSIT, WEST4_PRICES).depositCents;

/**
 * M5-11 (Payment flows · Deposit when booking online, step 5; Money rules 11),
 * written before the code: a change works the deposit out again from billable
 * guests; a bigger one collects the difference; a smaller one refunds the
 * excess only before the refund cut-off, and after it the deposit already paid
 * stays. The cut-off never moves later.
 */
describe("depositChange · the seed's deposits group", () => {
  it("the group's Friday party of 3 bills as 4, so its deposit is the party of 4's", () => {
    const three = byId("deposit_party3_2026-09-25");
    const four = byId("deposit_party4_2026-09-25");
    expect(dep(3)).toBe(three.expected["deposit_cents"]);
    expect(dep(3)).toBe(four.expected["deposit_cents"]);
  });

  it("Jae goes from 5 to 6 guests: the deposit becomes $60.00 and he pays $10.00", () => {
    expect(dep(5)).toBe(5000);
    expect(depositChange({ heldCents: 5000, newDepositCents: dep(6), beforeCutoff: true })).toEqual(
      {
        depositCents: 6000,
        collectCents: 1000,
        refundCents: 0,
        staysCents: 0,
      },
    );
    // After the cut-off a bigger party still pays the difference.
    expect(
      depositChange({ heldCents: 5000, newDepositCents: dep(6), beforeCutoff: false }),
    ).toEqual({
      depositCents: 6000,
      collectCents: 1000,
      refundCents: 0,
      staysCents: 0,
    });
  });

  it("6 to 3 before the cut-off: $40.00 (Friday bills 4) and $20.00 back", () => {
    expect(depositChange({ heldCents: 6000, newDepositCents: dep(3), beforeCutoff: true })).toEqual(
      {
        depositCents: 4000,
        collectCents: 0,
        refundCents: 2000,
        staysCents: 0,
      },
    );
  });

  it("6 to 3 after the cut-off: the $60.00 already paid stays", () => {
    expect(
      depositChange({ heldCents: 6000, newDepositCents: dep(3), beforeCutoff: false }),
    ).toEqual({
      depositCents: 6000,
      collectCents: 0,
      refundCents: 0,
      staysCents: 2000,
    });
  });

  it("the big-party rule from 20: 19 to 20 guests collects $60.00 ($190 to the flat $250)", () => {
    expect(dep(19)).toBe(byId("deposit_party19_2026-09-25").expected["deposit_cents"]);
    expect(dep(20)).toBe(byId("deposit_party20_2026-09-25").expected["deposit_cents"]);
    expect(
      depositChange({ heldCents: dep(19), newDepositCents: dep(20), beforeCutoff: true })
        .collectCents,
    ).toBe(6000);
  });

  it("moving to Saturday with the same party changes nothing", () => {
    expect(dep(5, sat)).toBe(5000);
    expect(
      depositChange({ heldCents: 5000, newDepositCents: dep(5, sat), beforeCutoff: true }),
    ).toEqual({
      depositCents: 5000,
      collectCents: 0,
      refundCents: 0,
      staysCents: 0,
    });
  });

  it("a weeknight party of 3 is billed as 3", () => {
    expect(dep(3, Temporal.PlainDate.from("2026-09-23"))).toBe(
      byId("deposit_party3_2026-09-23").expected["deposit_cents"],
    );
  });
});

describe("changedCutoff · never later than it was", () => {
  const thu11 = Temporal.Instant.from("2026-09-25T03:00:00Z");
  const fri11 = Temporal.Instant.from("2026-09-26T03:00:00Z");
  const wed11 = Temporal.Instant.from("2026-09-24T03:00:00Z");
  it("moving Jae to Saturday keeps Thu 11:00 PM", () => {
    expect(changedCutoff(thu11, fri11)?.toString()).toBe(thu11.toString());
  });
  it("moving earlier brings it earlier", () => {
    expect(changedCutoff(thu11, wed11)?.toString()).toBe(wed11.toString());
  });
  it("a booking with no cut-off (no deposit) takes none", () => {
    expect(changedCutoff(null, fri11)).toBeNull();
  });
});
