import { describe, expect, it } from "vitest";
import { newYorkCounty, Temporal } from "@west4/shared";
import {
  checkDeposit,
  checkHours,
  checkLanguages,
  checkPay,
  checkSafety,
  checkSetting,
} from "./settings-checks.js";

const ctx = { pack: newYorkCounty, today: Temporal.PlainDate.from("2026-09-25"), cutover: "06:00" };
const weekly = [{ day: 5, opens: "16:00", closes: "04:00" }];

describe("rule-pack checks on settings", () => {
  it("the house last call is never later than the pack's last sale, and a refusal names both", () => {
    const refused = checkHours({ weekly, lastCall: "04:30" }, ctx);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("4:30 AM");
    expect(refused[0]).toContain("4:00 AM");
    expect(checkHours({ weekly, lastCall: "04:00" }, ctx)).toEqual([]);
    expect(checkHours({ weekly, lastCall: "03:00" }, ctx)).toEqual([]);
    expect(checkHours({ weekly, lastCall: null }, ctx)).toEqual([]);
    // 11 PM is earlier in the business date than 4 AM, even though "23:00" > "04:00" as text.
    expect(checkHours({ weekly, lastCall: "23:00" }, ctx)).toEqual([]);
  });

  const pay = (cardFee: Parameters<typeof checkPay>[0]["cardFee"]) => ({
    cardFee,
    gratuity: { auto: "rooms" as const, pct: 20 },
    tipScreen: {
      on: true,
      pcts: [18, 20, 22] as [number, number, number],
      fixedCents: [100, 200, 300] as [number, number, number],
      smartThresholdCents: 1000,
    },
    tipReview: { overPct: 25, overCents: 5000, lateHours: 2 },
    pool: "hours" as const,
    roomHold: { on: false, cents: 0 },
    payShare: { on: true },
  });

  it("a 3.5% card surcharge is refused (over 2.7%), and a 2.7% one with noticeSentOn today is refused until 30 days later", () => {
    expect(
      checkPay(pay({ mode: "surcharge", pct: 3.5, noticeSentOn: "2026-08-01" }), ctx)[0],
    ).toContain("2.7%");
    const tooSoon = checkPay(pay({ mode: "surcharge", pct: 2.7, noticeSentOn: "2026-09-25" }), ctx);
    expect(tooSoon).toHaveLength(1);
    expect(tooSoon[0]).toContain("from 2026-10-25");
    expect(
      checkPay(pay({ mode: "surcharge", pct: 2.7, noticeSentOn: "2026-09-25" }), {
        ...ctx,
        today: Temporal.PlainDate.from("2026-10-25"),
      }),
    ).toEqual([]);
    expect(checkPay(pay({ mode: "surcharge", pct: 2.7, noticeSentOn: null }), ctx)[0]).toContain(
      "set the date",
    );
    expect(checkPay(pay({ mode: "off" }), ctx)).toEqual([]);
  });

  it("a cash discount only where the pack allows one", () => {
    expect(checkPay(pay({ mode: "discount", pct: 3 }), ctx)).toEqual([]);
    const noDiscount = {
      ...newYorkCounty,
      cardFee: { ...newYorkCounty.cardFee, discount: { allowed: false } },
    };
    expect(checkPay(pay({ mode: "discount", pct: 3 }), { ...ctx, pack: noDiscount })[0]).toContain(
      "isn't allowed",
    );
  });

  it("languages hold only English and Spanish, and the occupancy limit is empty or a whole number", () => {
    expect(checkLanguages({ staff: ["en", "es"] })).toEqual([]);
    expect(checkLanguages({ staff: ["en", "en"] })).toEqual(["Each language can be listed once."]);
    expect(checkLanguages({ staff: ["ko" as unknown as "en"] })[0]).toContain('"ko"');
    expect(checkSafety({ occupancyLimit: null, warnAtPct: 90 })).toEqual([]);
    expect(checkSafety({ occupancyLimit: 250, warnAtPct: 90 })).toEqual([]);
    expect(checkSafety({ occupancyLimit: 0, warnAtPct: 90 })).toHaveLength(1);
    expect(
      checkSetting(
        "rooms",
        { cleaningMin: 10, cleaningEnds: "staff", cleaningFlagMin: 8, stayOnWhenFree: true },
        ctx,
      ),
    ).toEqual([]);
  });
});

describe("the deposit checks (M5-06)", () => {
  const west4 = {
    on: true,
    mode: "firstHour" as const,
    value: 0,
    refundHours: 24,
    late: "keep" as const,
    noShow: "keep" as const,
    graceMin: 15,
    bigParty: { fromGuests: 20, deposit: { kind: "flat" as const, cents: 25000 }, refundHours: 24 },
  };
  it("passes West 4's deposit and refuses an amount that doesn't fit its mode", () => {
    expect(checkDeposit(west4)).toEqual([]);
    expect(checkDeposit({ ...west4, mode: "percent", value: 120 })).toEqual([
      "A percent deposit is a whole percent from 1 to 100.",
    ]);
    expect(checkDeposit({ ...west4, mode: "flat", value: 0 })).toHaveLength(1);
    expect(checkDeposit({ ...west4, value: 500 })).toEqual([
      "The first-hour and card-hold deposits take no amount.",
    ]);
    expect(checkDeposit({ ...west4, refundHours: 1.5 })).toHaveLength(1);
  });
});
