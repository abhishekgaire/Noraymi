import { describe, expect, it } from "vitest";
import { receiptEscPos, receiptPrintLines } from "./ticket.js";

describe("the printed receipt (M4-19)", () => {
  const lines = [
    "Check #1042 · Room 9",
    "Room time · 161 min at $120.00 an hour  $322.00",
    "Deposit  −$120.00",
    "Paid in full · thank you",
  ];

  it("right-aligns every amount within 32 columns and wraps a long label above it", () => {
    const out = receiptPrintLines({ lines }, { reprintN: 0 });
    expect(out.every((l) => l.length <= 32)).toBe(true);
    expect(out).toContain("Deposit                 −$120.00");
    expect(out.some((l) => l.endsWith("$322.00"))).toBe(true);
    expect(out.join("")).toContain("Room time · 161 min at $120.00");
  });

  it("marks a reprint, and prints ASCII only over USB", () => {
    expect(receiptPrintLines({ lines }, { reprintN: 2 })[0]).toBe("REPRINT 2");
    const bytes = receiptEscPos({ lines }, { reprintN: 0 });
    expect([...bytes].every((b) => b < 0x80)).toBe(true);
    expect(Buffer.from(bytes).toString("latin1")).toContain("-$120.00");
  });
});
