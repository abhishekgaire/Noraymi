import { describe, expect, it } from "vitest";
import type { PaymentStatus } from "@west4/db";
import {
  ATTEMPT_STATES,
  PAYMENT_STATUSES,
  canMoveAttempt,
  canMovePayment,
  statusOfIntent,
  type AttemptState,
} from "./state.js";

const RANK: Record<PaymentStatus, number> = {
  pending: 0,
  requires_action: 1,
  authorized: 2,
  failed: 3,
  canceled: 3,
  capture_failed: 3,
  captured: 3,
  partly_refunded: 4,
  refunded: 5,
};

/** Applies events in order, taking only the moves the machine allows. */
function run(events: PaymentStatus[]): PaymentStatus[] {
  let s: PaymentStatus = "pending";
  const seen = [s];
  for (const e of events) if (canMovePayment(s, e)) seen.push((s = e));
  return seen;
}

describe("the payment state machine", () => {
  it("never moves a payment backward, whatever order the events arrive in (property)", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const events = Array.from(
        { length: 1 + rand(8) },
        () => PAYMENT_STATUSES[rand(PAYMENT_STATUSES.length)]!,
      );
      const seen = run(events);
      for (let k = 1; k < seen.length; k++)
        expect(RANK[seen[k]!]).toBeGreaterThanOrEqual(RANK[seen[k - 1]!]);
      // A final state takes nothing more.
      const last = seen.at(-1)!;
      if (["canceled", "failed", "refunded", "capture_failed"].includes(last))
        for (const s of PAYMENT_STATUSES) expect(canMovePayment(last, s)).toBe(false);
    }
  });

  it("succeeded before amount_capturable_updated, or canceled after succeeded, changes nothing", () => {
    expect(run(["captured", "authorized"])).toEqual(["pending", "captured"]);
    expect(run(["captured", "canceled"])).toEqual(["pending", "captured"]);
    expect(run(["authorized", "captured", "captured"])).toEqual([
      "pending",
      "authorized",
      "captured",
    ]);
  });

  it("moves attempts forward only: started, then unknown, then an end", () => {
    const ends: AttemptState[] = ["succeeded", "failed", "canceled"];
    for (const e of ends) {
      expect(canMoveAttempt("started", e)).toBe(true);
      expect(canMoveAttempt("unknown", e)).toBe(true);
      for (const s of ATTEMPT_STATES) expect(canMoveAttempt(e, s)).toBe(false);
    }
    expect(canMoveAttempt("unknown", "started")).toBe(false);
  });

  it("reads Stripe's PaymentIntent statuses", () => {
    expect(statusOfIntent("succeeded")).toBe("captured");
    expect(statusOfIntent("requires_capture")).toBe("authorized");
    expect(statusOfIntent("requires_payment_method")).toBeNull();
    expect(statusOfIntent("processing")).toBeNull();
  });
});
