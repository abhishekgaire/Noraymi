import { describe, expect, it } from "vitest";
import { timeLabel } from "./report.js";

describe("the report's times", () => {
  it("reads EDT before 2 AM and EST after on the fall-back night", () => {
    expect(timeLabel("2026-11-01T05:30:00Z", "America/New_York")).toBe("1:30 AM EDT");
    expect(timeLabel("2026-11-01T06:30:00Z", "America/New_York")).toBe("1:30 AM EST");
  });

  it("reads EST before 2 AM and EDT after on the spring-forward night", () => {
    expect(timeLabel("2027-03-14T06:30:00Z", "America/New_York")).toBe("1:30 AM EST");
    expect(timeLabel("2027-03-14T07:30:00Z", "America/New_York")).toBe("3:30 AM EDT");
  });
});

describe("the printed report", () => {
  it("heads the Z report with its number, the date and who closed it, amounts on the right", async () => {
    const { reportPrintLines } = await import("./report.js");
    const lines = reportPrintLines(
      {
        kind: "z",
        business_date: "2026-09-25",
        time_zone: "America/New_York",
        generated_at: "2026-09-26T08:48:00Z",
        closed: { z_number: 1, closed_at: "2026-09-26T08:48:00Z", closed_by: "Andy C." },
        sales: {
          room_time_cents: 32200,
          drinks_room_checks_cents: 15800,
          drinks_bar_tabs_cents: 21900,
          packages_cents: 0,
          songs_cents: 0,
          damage_cents: 0,
          kept_deposits_cents: 0,
          min_spend_cents: 0,
          card_surcharge_cents: 0,
          fees_cents: 0,
          comps_cents: -1200,
          voids_cents: 0,
          discounts_cents: 0,
          refunds_cents: 0,
          net_cents: 68700,
        },
        tax: [
          { jurisdiction: "NY-NYC", rate: "0.08875", taxable_base_cents: 68700, tax_cents: 6097 },
        ],
        tax_cents: 6097,
        gratuity: { total_cents: 9360, by_check: {}, bar_tabs_cents: 0, refunded_cents: 0 },
        counts: { rooms: 1, bar_tabs: 5 },
        payments: {
          card_present_cents: 0,
          card_on_file_cents: 0,
          card_online_cents: 0,
          cash_cents: 0,
          prepaid_cents: 0,
          card_tips_cents: 0,
          cash_tips_cents: 0,
          refunds_cents: 0,
          card_total_cents: 0,
          deposits_taken_cents: 0,
          deposits_allocated_cents: 0,
        },
        drawers: [],
        tips: { sources: { total_cents: 0 } } as never,
        exceptions: [],
        adjustments: [],
        log: [],
      },
      (c) => `${c < 0 ? "−" : ""}$${(Math.abs(c) / 100).toFixed(2)}`,
    );
    expect(lines.slice(0, 4)).toEqual([
      "Z REPORT 1",
      "Business date 2026-09-25",
      "Closed 4:48 AM EDT by Andy C.",
      "Rooms 1 · Bar tabs 5",
    ]);
    expect(lines).toContain("Gratuity  $93.60");
    expect(lines).toContain("Comps  −$12.00");
  });
});
