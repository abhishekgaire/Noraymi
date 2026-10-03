import { describe, expect, it } from "vitest";
import type { DepositRule } from "@west4/shared";
import { depositPolicyText } from "./policy.js";

/** West 4's deposit (seed): the first hour, 24 hours, keep and keep, 15 minutes, $250 from 20. */
const west4: DepositRule = {
  on: true,
  mode: "firstHour",
  value: 0,
  refundHours: 24,
  late: "keep",
  noShow: "keep",
  graceMin: 15,
  bigParty: { fromGuests: 20, deposit: { kind: "flat", cents: 25000 }, refundHours: 24 },
};
const rooms20 = { auto: "rooms", pct: 20 } as const;

describe("the deposit policy guests accept", () => {
  it("reads West 4's terms: the deposit off the bill, the saved card, 24 hours, keep, 15 minutes, $250 from 20, the gratuity", () => {
    expect(depositPolicyText(west4, rooms20).split("\n")).toEqual([
      "A deposit of the first hour's room time holds your room. It comes off your bill.",
      "Parties of 20 or more pay a $250 deposit instead, refunded in full if you cancel at least 24 hours before your start.",
      "We save the card you pay with. At the end of your visit, the rest of your tab can go on it: the amount due on your bill and never more, charged once you confirm on your phone, or with a manager's approval if you've already left. An itemized receipt is texted to you at once.",
      "Cancel at least 24 hours before your start for a full refund.",
      "Cancel later than that and the deposit is kept.",
      "If nobody from your party arrives within 15 minutes of your start, the booking is a no-show and the deposit is kept.",
      "A 20% gratuity is added to room tabs.",
    ]);
  });

  it("names a no-show charge on the saved card, how much and when", () => {
    const text = depositPolicyText({ ...west4, noShow: "firstHour", late: "half" }, rooms20);
    expect(text).toContain(
      "after those 15 minutes we charge the saved card up to the first hour's room time in total, the deposit included.",
    );
    expect(text).toContain("half the deposit is refunded");
  });

  it("a card hold charges nothing now and nothing on a no-show kept; no gratuity sentence with it off", () => {
    const text = depositPolicyText(
      { ...west4, mode: "cardHold", bigParty: null },
      {
        auto: "off",
        pct: 20,
      },
    );
    expect(text.split("\n")).toEqual([
      "Your card holds the room. Nothing is charged now.",
      expect.stringMatching(/^We save the card you pay with\./),
      "Cancel at least 24 hours before your start and nothing is charged.",
      "If nobody from your party arrives within 15 minutes of your start, the booking is a no-show and nothing is charged.",
    ]);
  });

  it("other modes say their amount", () => {
    expect(depositPolicyText({ ...west4, mode: "perPerson", value: 1000 }, rooms20)).toContain(
      "A deposit of $10 a guest holds your room.",
    );
    expect(depositPolicyText({ ...west4, mode: "flat", value: 5050 }, rooms20)).toContain(
      "A $50.50 deposit holds your room.",
    );
    expect(depositPolicyText({ ...west4, mode: "percent", value: 50 }, rooms20)).toContain(
      "A deposit of 50% of the first hour's room time",
    );
  });
});
