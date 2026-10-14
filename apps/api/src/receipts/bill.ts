import { checkById, insertPrintJob, latestSetting, type Queryable } from "@west4/db";
import { t, type Locale, type Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { cashPriceFor } from "../payments/surcharge.js";
import { workOut } from "../rooms/finalize.js";
import { money, receiptModel, receiptTime, type ReceiptLine } from "./model.js";

/**
 * The bill before paying (P-01; Payment flows · Room close-out; Devices, printing, offline): what a
 * guest is handed to look over before they pay, printed on the station's receipt printer as a print
 * job of kind `bill`, laid out like a receipt (print/ticket.ts · receiptPrintLines), so it prints on
 * ESC/POS and Star raster alike. The venue, the room or tab, the guests, each line with room time,
 * comps and voids, tax, gratuity, the total, the deposit and payments so far and what's left to pay;
 * with the cash discount on, the cash price under the total (and under Left to pay when part is
 * paid); and "This is not a receipt". Every amount is the receipt model's: a presented check's
 * finalized revision, or an open check's totals worked out now by packages/rules. Reprinting is
 * allowed: each print is a print_jobs row (audited by its trigger) numbered REPRINT 1, 2 and on.
 */
const FINALIZED = new Set(["finalized", "partly_paid", "paid"]);

export async function billLines(
  c: Queryable,
  venueId: string,
  checkId: string,
  input: { now: Temporal.Instant; locale: Locale },
): Promise<{ lines: string[]; totalCents: number; dueCents: number }> {
  const found = await checkById(c, venueId, checkId);
  if (!found) throw new ApiError("not_found", "no such check");
  const worked = FINALIZED.has(found.check.status)
    ? undefined
    : await workOut(c, venueId, found.check, found.lines, input.now);
  const m = await receiptModel(c, venueId, checkId, {
    locale: input.locale,
    ...(worked ? { worked } : {}),
  });
  if (!m) throw new ApiError("not_found", "no such check");
  const f = (
    await c.query<{ tab: string | null; party: number | null; time_zone: string }>(
      `select t.name as tab, s.party_size as party, v.time_zone
         from checks k join venues v on v.id = k.venue_id
         left join tabs t on t.venue_id = k.venue_id and t.check_id = k.id
         left join room_sessions s on s.venue_id = k.venue_id and s.id = k.room_session_id
        where k.venue_id = $1 and k.id = $2`,
      [venueId, checkId],
    )
  ).rows[0]!;
  const L = input.locale;
  const row = (l: ReceiptLine) => `${l.label}  ${money(l.amount_cents)}`;
  const cashPrice = async (amount: number) => {
    if (amount <= 0) return null;
    const cash = await cashPriceFor(c, venueId, {
      checkId,
      amountCents: amount,
      businessDate: found.check.business_date,
      extraOtherCents: worked ? worked.roomTimeCents + worked.minSpendCents : 0,
    });
    return cash === null ? null : row({ label: t(L, "printBill.cashPrice"), amount_cents: cash });
  };
  const cashTotal = await cashPrice(m.total_cents);
  const cashDue = m.amount_due_cents !== m.total_cents ? await cashPrice(m.amount_due_cents) : null;
  const where = m.room ?? (f.tab ? t(L, "printBill.tab", { name: f.tab }) : null);
  const lines = [
    ...(m.training ? [t(L, "training.band")] : []),
    m.venue,
    ...(m.address ? [m.address] : []),
    t(L, "printBill.title"),
    where ? `${m.number} · ${where}` : m.number,
    ...(f.party ? [t(L, "printBill.guests", { n: f.party })] : []),
    t(L, "printBill.printedAt", { time: receiptTime(input.now.toString(), f.time_zone) }),
    "",
    ...m.lines.map(row),
    ...m.totals.map(row),
    ...(cashTotal ? [cashTotal] : []),
    ...m.payments.map(row),
    ...(cashDue ? [cashDue] : []),
    "",
    t(L, "printBill.notReceipt"),
  ];
  return { lines, totalCents: m.total_cents, dueCents: m.amount_due_cents };
}

/** The venue's first staff language: the bill's words when the screen doesn't ask for one. */
export async function venueLocale(c: Queryable, venueId: string): Promise<Locale> {
  const first = ((await latestSetting(c, venueId, "languages"))?.value.staff ?? ["en"])[0];
  return first === "es" ? "es" : "en";
}

/** Print the bill on a station's receipt printer; the first print is 0, then REPRINT 1, 2 and on. */
export async function printBill(
  c: Queryable,
  venueId: string,
  input: { checkId: string; station: string; locale: Locale; now: Temporal.Instant },
): Promise<{ print_job_id: string; reprint_n: number; total_cents: number; due_cents: number }> {
  const bill = await billLines(c, venueId, input.checkId, input);
  const reprintN = (
    await c.query<{ n: number }>(
      "select count(*)::int as n from print_jobs where venue_id = $1 and kind = 'bill' and check_id = $2",
      [venueId, input.checkId],
    )
  ).rows[0]!.n;
  const id = await insertPrintJob(c, venueId, {
    kind: "bill",
    checkId: input.checkId,
    station: input.station,
    payload: { lines: bill.lines },
    reprintN,
    createdAt: input.now.toString(),
  });
  return {
    print_job_id: id,
    reprint_n: reprintN,
    total_cents: bill.totalCents,
    due_cents: bill.dueCents,
  };
}
