import {
  latestAttempt,
  paymentById,
  readSetting,
  rulePackFor,
  stripeAccountFor,
  withVenue,
  type Queryable,
} from "@west4/db";
import { businessDate, cardFee, percent } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { confirmOnReader, retrieveCollected, setSurcharge } from "../stripe/surcharge.js";
import type { PaymentDeps } from "./run.js";
import { confirmTabCard } from "../tabs/open.js";

/**
 * The card fee at the reader (M4-25; Money rules 10; Payment flows · Card fee
 * at the reader; off at West 4). With a surcharge on, the venue's flag on and
 * the notice period over, a tap collects the card first; a credit card then
 * gets the surcharge (on the amount before any tip) and, while surcharges are
 * taxable, its tax, through Stripe's surcharge API, inside the window before
 * confirm; debit and prepaid cards change nothing. On capture the payment
 * writes its `card_surcharge` line and the tax on it.
 */
export interface SurchargeTerms {
  readonly pct: number;
  readonly taxable: boolean;
  /** "8.875": the pack's rate as a percent, digits moved, no float. */
  readonly taxRatePct: string;
  /** The pack's rate as written on tax lines ("0.08875"). */
  readonly taxRate: string;
}

const pctOf = (rate: number) => {
  const [whole, frac = ""] = String(rate).split(".");
  const digits = (whole! + frac.padEnd(2, "0")).replace(/^0+(?=\d)/, "");
  const point = digits.length - Math.max(0, frac.length - 2);
  const out = frac.length > 2 ? `${digits.slice(0, point)}.${digits.slice(point)}` : digits;
  return out.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};

/** The surcharge that applies on a night, or null (the fee off, the flag off, or still in its notice period). */
export async function surchargeFor(
  c: Queryable,
  venueId: string,
  businessDate: string,
): Promise<SurchargeTerms | null> {
  const venue = (
    await c.query<{ surcharge_reader: boolean; rule_pack_id: string | null }>(
      "select surcharge_reader, rule_pack_id from venues where id = $1",
      [venueId],
    )
  ).rows[0];
  if (!venue?.surcharge_reader) return null;
  const date = Temporal.PlainDate.from(businessDate);
  const pay = await readSetting(c, venueId, "pay", date);
  const fee = pay?.value.cardFee;
  if (!fee || fee.mode !== "surcharge" || !fee.noticeSentOn) return null;
  const pack = await rulePackFor(c, venue.rule_pack_id ?? "us-ny-new-york-county", date);
  if (!pack) return null;
  const startsOn = Temporal.PlainDate.from(fee.noticeSentOn).add({
    days: pack.pack.cardFee.surcharge.noticeDays,
  });
  if (Temporal.PlainDate.compare(date, startsOn) < 0) return null;
  return {
    pct: fee.pct,
    taxable: pack.pack.salesTax.surchargeTaxable,
    taxRatePct: pctOf(pack.pack.salesTax.rate),
    taxRate: String(pack.pack.salesTax.rate),
  };
}

/**
 * The card is collected: a credit card gets the surcharge (and its tax while taxable), then the
 * reader confirms. Outside any transaction; each write keyed by the payment and the attempt.
 */
export async function confirmCollected(deps: PaymentDeps, venueId: string, paymentId: string) {
  // A bar tab's opening hold (M6-06): the card is checked against the open tabs before confirm.
  if (await confirmTabCard(deps, venueId, paymentId)) return;
  const ctx = await withVenue(
    deps.pool,
    { venueId, requestId: `payment:${paymentId}:collected` },
    async (c) => {
      const payment = await paymentById(c, venueId, paymentId);
      const attempt = await latestAttempt(c, venueId, paymentId);
      if (!payment || !attempt?.reader_id || !payment.stripe_pi_id) return null;
      const held = (
        await c.query<{ s: string }>(
          "select coalesce(sum(amount_cents), 0) as s from payment_allocations where venue_id = $1 and payment_id = $2 and state = 'in_progress'",
          [venueId, paymentId],
        )
      ).rows[0]!.s;
      return {
        payment,
        attempt,
        held: Number(held),
        account: await stripeAccountFor(c, venueId, payment.training),
        terms: await surchargeFor(c, venueId, payment.business_date),
      };
    },
  );
  // Only the surcharge path collects first; without it, nothing waits to be confirmed.
  if (!ctx?.account || !ctx.terms) return;
  deps = { ...deps, stripe: deps.stripe.forTraining(ctx.payment.training) };
  const pi = await retrieveCollected(deps.stripe, ctx.account, ctx.payment.stripe_pi_id!);
  if (pi.status !== "requires_confirmation") return;
  const method = typeof pi.payment_method === "object" ? pi.payment_method : null;
  // A card whose type can't be read is never surcharged: only a known credit card pays the fee.
  const funding = method?.card_present?.funding ?? "unknown";
  if (ctx.terms && funding === "credit" && !pi.amount_details?.surcharge?.amount) {
    const fee = cardFee({
      amountCents: ctx.held,
      ratePct: ctx.terms.pct,
      taxRatePct: ctx.terms.taxRatePct,
      funding: "credit",
    });
    if (fee.surchargeCents > 0)
      await setSurcharge(
        deps.stripe,
        ctx.account,
        pi.id,
        {
          amountCents:
            pi.amount + fee.surchargeCents + (ctx.terms.taxable ? fee.taxOnSurchargeCents : 0),
          surchargeCents: fee.surchargeCents,
        },
        `${paymentId}:surcharge:${ctx.attempt.attempt_no}`,
      );
  }
  await confirmOnReader(
    deps.stripe,
    ctx.account,
    { readerId: ctx.attempt.reader_id!, piId: pi.id },
    `${paymentId}:confirm:${ctx.attempt.attempt_no}`,
  );
}

/**
 * On capture: the surcharge line and the tax on it (the part of what the card paid beyond the check's
 * amount, the fee and the tip), and the allocation that pays them, so the check still adds up.
 */
export async function recordSurcharge(
  c: Queryable,
  venueId: string,
  paymentId: string,
  input: { surchargeCents: number; paidBeyondCents: number; at: string },
) {
  const a = (
    await c.query<{ check_id: string; business_date: string }>(
      `select a.check_id, p.business_date::text from payment_allocations a
         join payments p on p.venue_id = a.venue_id and p.id = a.payment_id
        where a.venue_id = $1 and a.payment_id = $2 and a.kind = 'payment' limit 1`,
      [venueId, paymentId],
    )
  ).rows[0];
  if (!a) return;
  const terms = await surchargeFor(c, venueId, a.business_date);
  const tax = Math.max(0, input.paidBeyondCents - input.surchargeCents);
  const line = (
    kind: string,
    description: string,
    cents: number,
    extra: { taxRate?: string | undefined; base?: number },
  ) =>
    c.query(
      `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category,
         tax_rate, taxable_base_cents, business_date, adjusts_business_date, added_at, reason)
       values ($1, $2, $3, $4, 1, $5, $5, $6, $7, $8, open_business_date($1, $9::date),
         nullif($9::date, open_business_date($1, $9::date)), $10, $11)`,
      [
        venueId,
        a.check_id,
        kind,
        description,
        cents,
        kind === "card_surcharge" ? "fee" : null,
        extra.taxRate ?? null,
        extra.base ?? null,
        a.business_date,
        input.at,
        `payment ${paymentId}`,
      ],
    );
  await line("card_surcharge", "Credit card surcharge", input.surchargeCents, {});
  if (tax > 0)
    await line("tax", "Tax · fees", tax, {
      taxRate: terms?.taxRate ?? undefined,
      base: input.surchargeCents,
    });
  await c.query(
    `insert into payment_allocations (venue_id, payment_id, check_id, amount_cents, kind, state)
     values ($1, $2, $3, $4, 'payment', 'captured')`,
    [venueId, paymentId, a.check_id, input.surchargeCents + tax],
  );
}

/** The cash discount on a night (`pay.cardFee` mode discount, where the rule pack allows it), or null. */
export async function cashDiscountFor(
  c: Queryable,
  venueId: string,
  businessDate: string,
): Promise<{ pct: number; taxRatePct: string; taxRate: string } | null> {
  const date = Temporal.PlainDate.from(businessDate);
  const pay = await readSetting(c, venueId, "pay", date);
  const fee = pay?.value.cardFee;
  if (!fee || fee.mode !== "discount" || fee.pct <= 0) return null;
  const venue = (
    await c.query<{ rule_pack_id: string | null }>(
      "select rule_pack_id from venues where id = $1",
      [venueId],
    )
  ).rows[0];
  const pack = await rulePackFor(c, venue?.rule_pack_id ?? "us-ny-new-york-county", date);
  if (!pack?.pack.cardFee.discount.allowed) return null;
  return {
    pct: fee.pct,
    taxRatePct: pctOf(pack.pack.salesTax.rate),
    taxRate: String(pack.pack.salesTax.rate),
  };
}

/**
 * Cash taken with a cash discount on (M4-25): a `cash_discount` line for its share of what's paid and
 * a matching tax reduction, written as the cash is taken; answers what the cash then pays.
 */
export async function applyCashDiscount(
  c: Queryable,
  venueId: string,
  input: { checkId: string; amountCents: number; businessDate: string; at: string },
): Promise<number> {
  const terms = await cashDiscountFor(c, venueId, input.businessDate);
  if (!terms) return input.amountCents;
  const off = percent(input.amountCents, terms.pct);
  const taxOff = percent(off, terms.taxRatePct);
  const line = (kind: string, description: string, cents: number, taxRate: string | null) =>
    c.query(
      `insert into check_lines (venue_id, check_id, kind, description, qty, unit_cents, amount_cents, tax_category,
         tax_rate, business_date, adjusts_business_date, added_at)
       values ($1, $2, $3, $4, 1, $5, $5, $6, $7, open_business_date($1, $8::date),
         nullif($8::date, open_business_date($1, $8::date)), $9)`,
      [
        venueId,
        input.checkId,
        kind,
        description,
        cents,
        kind === "cash_discount" ? "fee" : null,
        taxRate,
        input.businessDate,
        input.at,
      ],
    );
  if (off > 0) await line("cash_discount", "Cash discount", -off, null);
  if (taxOff > 0) await line("tax", "Tax · cash discount", -taxOff, terms.taxRate);
  return input.amountCents - off - taxOff;
}

/** The surcharge rate menus show their credit prices at tonight, or null with the fee off (M4-25). */
export async function creditPricePct(
  c: Queryable,
  venueId: string,
  now: Temporal.Instant,
): Promise<number | null> {
  const v = (
    await c.query<{ time_zone: string; day_cutover: string }>(
      "select time_zone, to_char(day_cutover, 'HH24:MI') as day_cutover from venues where id = $1",
      [venueId],
    )
  ).rows[0];
  if (!v) return null;
  const date = businessDate(now, v.time_zone, v.day_cutover).businessDate.toString();
  return (await surchargeFor(c, venueId, date))?.pct ?? null;
}
