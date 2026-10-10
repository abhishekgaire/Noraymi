import { describe, expect, it } from "vitest";
import {
  ORDER_STATUSES,
  ORDER_STEPS,
  orderStep,
  pickUpStep,
  type OrderStatus,
  type OrderStep,
} from "./orders.js";

/** Every step from every status: the allowed moves, and a refusal for all the rest. */
const ALLOWED: Record<OrderStep, Partial<Record<OrderStatus, OrderStatus>>> = {
  hold: { ringing: "held" },
  accept: { ringing: "accepted", held: "accepted" },
  decline: { ringing: "cancelled", held: "cancelled" },
  cancel: { ringing: "cancelled", held: "cancelled" },
  ready: { accepted: "ready" },
  claim: { ready: "on_the_way" },
  deliver: { ready: "delivered", on_the_way: "delivered" },
  return: { ready: "returned", on_the_way: "returned" },
  resolve: { returned: "returned" },
  remake: { returned: "accepted" },
};

describe("orderStep", () => {
  for (const step of ORDER_STEPS) {
    for (const from of ORDER_STATUSES) {
      const to = ALLOWED[step][from];
      it(`${step} from ${from} ${to ? `→ ${to}` : "is refused"}`, () => {
        const r = orderStep(from, step);
        if (to) expect(r).toEqual({ ok: true, to });
        else expect(r).toMatchObject({ ok: false });
      });
    }
  }

  it("says why: ready on an order that isn't accepted", () => {
    expect(orderStep("held", "ready")).toEqual({
      ok: false,
      why: "the order is held; it needs Accept before it can be marked ready",
    });
  });

  it("a held order still needs Accept; cancel is gone once it's accepted", () => {
    expect(orderStep("held", "deliver").ok).toBe(false);
    expect(orderStep("accepted", "cancel")).toEqual({
      ok: false,
      why: "the order is accepted; it can only be cancelled while it's ringing or held",
    });
  });
});

describe("Picked up (K-06)", () => {
  const food = {
    status: "accepted" as const,
    station: "kitchen",
    hasRun: true,
    sentToKitchen: true,
  };
  it("moves accepted food in the kitchen to on its way", () => {
    expect(pickUpStep(food)).toEqual({ ok: true, to: "on_the_way" });
  });
  it("refuses an order that isn't accepted", () => {
    for (const status of [
      "ringing",
      "held",
      "ready",
      "on_the_way",
      "delivered",
      "returned",
    ] as const)
      expect(pickUpStep({ ...food, status })).toMatchObject({ ok: false, reason: "status" });
  });
  it("refuses staff-rung food still Not sent", () => {
    expect(pickUpStep({ ...food, sentToKitchen: false })).toMatchObject({
      ok: false,
      reason: "not_sent",
    });
  });
  it("refuses drinks, and food for a bar tab or a quick sale, which has no run", () => {
    expect(pickUpStep({ ...food, station: "bar" })).toMatchObject({ reason: "not_food" });
    expect(pickUpStep({ ...food, hasRun: false })).toMatchObject({ reason: "no_run" });
  });
});
