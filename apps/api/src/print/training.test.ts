import { describe, expect, it } from "vitest";
import { t } from "@west4/shared";
import { receiptPrintLines, TRAINING, ticketLines, ticketText } from "./ticket.js";
import { receiptText, type ReceiptModel } from "../receipts/model.js";

/** Training mode (M7-03): practice tickets and receipts print TRAINING; live ones never do. */
describe("practice printouts", () => {
  const order = {
    room: "Room 4",
    accepted_by: "Nina",
    accepted_at: "2026-09-26T02:41:00Z",
    lines: [{ qty: 2, name: "Modelo Especial", options: [] }],
  };
  const opts = { timeZone: "America/New_York", reprintN: 0 };

  it("a practice ticket says TRAINING at the top and the foot, within 32 columns", () => {
    const lines = ticketLines({ ...order, training: true }, opts);
    expect(lines[0]).toBe(TRAINING);
    expect(lines.at(-1)).toBe(TRAINING);
    expect(TRAINING.length).toBeLessThanOrEqual(32);
    expect(ticketText({ ...order, training: true }, { ...opts, reprintN: 2 })).toMatch(
      /^REPRINT 2\nTRAINING/,
    );
  });

  it("a live ticket never does", () => {
    expect(ticketLines(order, opts).join("\n")).not.toMatch(/TRAINING/);
  });

  it("a practice receipt opens with the band and its T- number", () => {
    const model: ReceiptModel = {
      venue: "West 4 Boho Karaoke",
      address: null,
      number: t("en", "receipt.numberTraining", { number: "T-0012" }),
      training: true,
      room: null,
      opened: "Fri Sep 25, 10:41 PM EDT",
      paid: null,
      status: "paid",
      status_label: "Paid in full · thank you",
      lines: [{ label: "Modelo Especial", amount_cents: 900 }],
      totals: [],
      payments: [],
      total_cents: 900,
      amount_due_cents: 0,
      refunded_cents: 0,
    };
    const text = receiptText(model);
    expect(text[0]).toBe("TRAINING · not real money");
    expect(text).toContain("Check T-0012");
    expect(receiptPrintLines({ lines: text }, { reprintN: 0 })[0]).toBe(
      "TRAINING · not real money",
    );
    expect(receiptText({ ...model, training: false }).join("\n")).not.toMatch(/TRAINING/);
  });
});
