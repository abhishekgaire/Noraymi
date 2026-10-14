import { describe, expect, it } from "vitest";
import { hostJobBytes, receiptStarRaster } from "./host-bytes.js";
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

describe("the bill before paying (P-01)", () => {
  const lines = ["CUENTA", "Depósito  −$120.00", "Por pagar  $498.60", "Esto no es un recibo"];
  it("prints as a receipt does on a USB printer, and as dots on a Star raster printer", () => {
    const job = { kind: "bill", payload: { lines }, reprint_n: 1 };
    const esc = hostJobBytes(job, "escpos", "America/New_York");
    expect(esc).toEqual(receiptEscPos({ lines }, { reprintN: 1 }));
    const text = Buffer.from(esc).toString("latin1");
    expect(text).toContain("REPRINT 1");
    expect(text).toContain("Deposito");
    expect(text).toContain("Esto no es un recibo");
    expect(hostJobBytes(job, "star_raster", "America/New_York")).toEqual(
      receiptStarRaster({ lines }, { reprintN: 1 }),
    );
  });
});
