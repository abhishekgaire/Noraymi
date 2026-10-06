import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  isBalanced,
  journalCsv,
  nightJournal,
  payoutJournal,
  type Account,
} from "./journal.js";
import type { ReportLine } from "./night-report.js";

const line = (kind: string, amount: number, extra: Partial<ReportLine> = {}): ReportLine => ({
  check_id: "chk_room9",
  check_kind: "room",
  kind,
  amount_cents: amount,
  tax_category: null,
  jurisdiction_code: null,
  tax_rate: null,
  taxable_base_cents: null,
  description: kind,
  ...extra,
});
const empty = { deposits_taken_cents: 0, unmatched_cents: 0, over_short_cents: 0, adjustments: [] };
const at = (j: ReturnType<typeof nightJournal>, account: Account) =>
  j.lines
    .filter((l) => l.account === account)
    .reduce((s, l) => s + l.credit_cents - l.debit_cents, 0);

describe("the nightly journal", () => {
  it("posts Room 9's close-out: $120.00 from customer deposits and $498.60 to Stripe clearing against its sales, tax and gratuity", () => {
    const j = nightJournal({
      date: "2026-09-25",
      lines: [
        line("room_time", 32200, { tax_category: "room_time" }),
        line("item", 15800, { tax_category: "drink" }),
        line("tax", 2858, { jurisdiction_code: "NY-NYC" }),
        line("tax", 1402, { jurisdiction_code: "NY-NYC" }),
        line("gratuity", 9600),
      ],
      money: [
        { way: "deposit", amount_cents: 12000, tip_cents: 0 },
        { way: "card", amount_cents: 49860, tip_cents: 0 },
      ],
      ...empty,
    });
    expect(j.lines).toEqual([
      { account: "sales_room_time", debit_cents: 0, credit_cents: 32200 },
      { account: "sales_drinks", debit_cents: 0, credit_cents: 15800 },
      { account: "sales_tax_payable", jurisdiction: "NY-NYC", debit_cents: 0, credit_cents: 4260 },
      { account: "gratuity_payable", debit_cents: 0, credit_cents: 9600 },
      { account: "customer_deposits", debit_cents: 12000, credit_cents: 0 },
      { account: "stripe_clearing", debit_cents: 49860, credit_cents: 0 },
    ]);
    expect(isBalanced(j)).toBe(true);
  });

  it("holds Jae & co.'s $50.00 deposit in customer deposits until it's allocated at check-in", () => {
    const j = nightJournal({
      date: "2026-09-23",
      lines: [],
      money: [],
      ...empty,
      deposits_taken_cents: 5000,
    });
    expect(at(j, "customer_deposits")).toBe(5000);
    expect(at(j, "stripe_clearing")).toBe(-5000);
    const checkIn = nightJournal({
      date: "2026-09-25",
      lines: [line("room_time", 5000)],
      money: [{ way: "deposit", amount_cents: 5000, tip_cents: 0 }],
      ...empty,
    });
    expect(at(checkIn, "customer_deposits")).toBe(-5000);
  });

  it("posts a $5.00 short drawer to cash over and short", () => {
    const j = nightJournal({
      date: "2026-09-25",
      lines: [],
      money: [],
      ...empty,
      over_short_cents: -500,
    });
    expect(j.lines).toEqual([
      { account: "cash", debit_cents: 0, credit_cents: 500 },
      { account: "cash_over_short", debit_cents: 500, credit_cents: 0 },
    ]);
  });

  it("maps every Z figure to exactly one account", () => {
    const kinds: [string, Partial<ReportLine>, Account][] = [
      ["room_time", {}, "sales_room_time"],
      ["item", {}, "sales_drinks"],
      ["item", { is_package: true }, "sales_packages"],
      ["song", {}, "sales_songs"],
      ["damage", {}, "sales_damage"],
      ["forfeit", {}, "sales_deposits_kept"],
      ["min_spend", {}, "sales_min_spend"],
      ["card_surcharge", {}, "sales_card_surcharge"],
      ["comp", {}, "comps"],
      ["refund", {}, "refunds"],
      ["refund", { description: "Refund · Gratuity" }, "gratuity_payable"],
      ["tax", { jurisdiction_code: "NY-NYC" }, "sales_tax_payable"],
      ["gratuity", {}, "gratuity_payable"],
      ["void", { tax_category: "drink" }, "sales_drinks"],
    ];
    for (const [kind, extra, account] of kinds) {
      const j = nightJournal({
        date: "d",
        lines: [
          line(
            kind,
            -100 * (kind === "comp" || kind === "refund" || kind === "void" ? 1 : -1),
            extra,
          ),
        ],
        money: [],
        ...empty,
      });
      const touched = j.lines.map((l) => l.account).filter((a) => a !== "due_from_guests");
      expect(touched, kind).toEqual([account]);
    }
  });

  it("always balances, whatever the night holds", () => {
    const kinds = [
      "room_time",
      "item",
      "song",
      "tax",
      "gratuity",
      "comp",
      "void",
      "refund",
      "damage",
    ];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...kinds),
            amount: fc.integer({ min: -50_000, max: 50_000 }),
          }),
          {
            maxLength: 30,
          },
        ),
        fc.array(
          fc.record({
            way: fc.constantFrom(
              "card" as const,
              "cash" as const,
              "prepaid" as const,
              "deposit" as const,
            ),
            amount_cents: fc.integer({ min: -10_000, max: 200_000 }),
            tip_cents: fc.integer({ min: 0, max: 5_000 }),
          }),
          { maxLength: 10 },
        ),
        fc.integer({ min: -5_000, max: 5_000 }),
        (lines, money, overShort) => {
          const j = nightJournal({
            date: "d",
            lines: lines.map((l) => line(l.kind, l.amount)),
            money,
            ...empty,
            over_short_cents: overShort,
          });
          expect(isBalanced(j)).toBe(true);
          expect(j.lines.every((l) => ACCOUNTS.includes(l.account))).toBe(true);
        },
      ),
    );
  });
});

describe("a payout's journal", () => {
  it("puts the net in the bank, expenses Stripe's fees and empties Stripe clearing by the gross", () => {
    const j = payoutJournal({
      date: "2026-09-28",
      payout_id: "po_1",
      lines: [
        { type: "charge", gross_cents: 49860, fee_cents: 1351, net_cents: 48509 },
        { type: "refund", gross_cents: -1200, fee_cents: 0, net_cents: -1200 },
        { type: "fee", gross_cents: -150, fee_cents: 0, net_cents: -150 },
      ],
    });
    expect(isBalanced(j)).toBe(true);
    expect(j.lines).toEqual([
      { account: "stripe_clearing", debit_cents: 0, credit_cents: 48660 },
      { account: "bank", debit_cents: 47159, credit_cents: 0 },
      { account: "stripe_fees", debit_cents: 1501, credit_cents: 0 },
    ]);
  });
});

describe("the QuickBooks file", () => {
  it("writes one balanced journal per night and per payout, in QuickBooks Online's journal import layout (golden)", () => {
    const night = nightJournal({
      date: "2026-09-25",
      lines: [line("room_time", 32200), line("tax", 2858, { jurisdiction_code: "NY-NYC" })],
      money: [{ way: "card", amount_cents: 35058, tip_cents: 0 }],
      ...empty,
    });
    const payout = payoutJournal({
      date: "2026-09-28",
      payout_id: "po_1",
      lines: [{ type: "charge", gross_cents: 35058, fee_cents: 952, net_cents: 34106 }],
    });
    const defaults = Object.fromEntries(ACCOUNTS.map((a) => [a, a])) as Record<Account, string>;
    expect(journalCsv([night, payout], { sales_room_time: "Room Rental Income" }, defaults)).toBe(
      [
        "Journal No,Journal Date,Account,Debits,Credits,Description,Memo",
        "1,2026-09-25,Room Rental Income,,322.00,Night 2026-09-25,",
        "1,2026-09-25,sales_tax_payable · NY-NYC,,28.58,Night 2026-09-25,",
        "1,2026-09-25,stripe_clearing,350.58,,Night 2026-09-25,",
        "2,2026-09-28,stripe_clearing,,350.58,Payout po_1,",
        "2,2026-09-28,bank,341.06,,Payout po_1,",
        "2,2026-09-28,stripe_fees,9.52,,Payout po_1,",
        "",
      ].join("\n"),
    );
  });
});
