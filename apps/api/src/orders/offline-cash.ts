import { emitEvent, moduleOn, readSetting, rulePackFor, type Queryable } from "@west4/db";
import { businessDate, gratuityApplies, salesTaxRule } from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { takeCash } from "../payments/cash.js";
import { cashDiscountFor } from "../payments/surcharge.js";
import { venueClock } from "../rooms/assignment.js";
import { startQuickSale } from "../tabs/quick-sale.js";
import { checkAlcohol } from "./alcohol.js";
import { orderItemsFor } from "./place.js";
import { ReplayRefused, type ReplayAnswer } from "./replay.js";

/**
 * Cash quick sales while offline (U-16; D133; spec 09 · Cash quick sales while offline). The venue
 * setting `pos.offlineCashSales` ("Take cash quick sales while offline") is off by default, and
 * absent reads as off: then the bar computer's drawer stays locked offline and nothing here runs.
 * On, the computer keeps tonight's pricing terms with the bar POS's other reads, prices a cash
 * quick sale with packages/rules (offlineCashSalePrice), opens its drawer, and queues the sale;
 * on reconnect the sale replays here once, by the order id the computer made.
 */
export interface OfflineCashTermsView {
  readonly tax: {
    readonly rate: number;
    readonly taxed_categories: readonly string[];
    readonly surcharge_taxable: boolean;
    readonly jurisdiction_code: string | null;
  };
  readonly gratuity_pct: number | null;
  readonly cash_discount: {
    readonly pct: number;
    readonly tax_rate_pct: string;
    readonly food_includes_fee: boolean;
  } | null;
}

/** Tonight's terms for pricing a cash quick sale offline, or null while the switch is off. */
export async function offlineCashTerms(
  c: Queryable,
  venueId: string,
  date: string,
): Promise<OfflineCashTermsView | null> {
  const day = Temporal.PlainDate.from(date);
  const pos = await readSetting(c, venueId, "pos", day);
  if (pos?.value.offlineCashSales !== true) return null;
  // A quick sale is the bar's (M6-05): no bar POS, no quick sale.
  if (!(await moduleOn(c, venueId, "bar_tabs"))) return null;
  const venue = (
    await c.query<{ rule_pack_id: string | null }>(
      "select rule_pack_id from venues where id = $1",
      [venueId],
    )
  ).rows[0];
  const [pack, pay] = await Promise.all([
    rulePackFor(c, venue?.rule_pack_id ?? "us-ny-new-york-county", day),
    readSetting(c, venueId, "pay", day),
  ]);
  if (!pack || !pay) return null;
  const tax = salesTaxRule(pack.pack);
  const g = pay.value.gratuity;
  const discount = await cashDiscountFor(c, venueId, date);
  return {
    tax: {
      rate: tax.rate,
      taxed_categories: tax.taxedCategories,
      surcharge_taxable: tax.surchargeTaxable,
      jurisdiction_code: tax.jurisdictionCode,
    },
    gratuity_pct: gratuityApplies(g.auto, { kind: "quick", partySize: null }, g.partyMin)
      ? g.pct
      : null,
    cash_discount: discount
      ? {
          pct: discount.pct,
          tax_rate_pct: discount.taxRatePct,
          food_includes_fee: discount.foodIncludesFee,
        }
      : null,
  };
}

export interface QueuedCashSale {
  readonly kind: "cash_sale";
  readonly order_id: string;
  readonly queued_at: string;
  readonly staff: { readonly membership_id: string; readonly name: string };
  readonly lines: readonly {
    readonly variant_id: string;
    readonly name: string;
    readonly qty: number;
    readonly unit_cents: number;
    readonly alcohol: boolean;
  }[];
  /** What a card would have paid (the check's total), as the computer priced it. */
  readonly total_cents: number;
  /** What the computer took in cash, and what the guest handed over. */
  readonly cash_cents: number;
  readonly tendered_cents: number;
}

async function nightOf(c: Queryable, venueId: string, at: Temporal.Instant): Promise<string> {
  const clock = await venueClock(c, venueId);
  return businessDate(at, clock.timeZone, clock.dayCutover).businessDate.toString();
}

/** The name the replay rows carry for a quick sale with no check (the screens show their own words). */
const QUICK = "Quick sale";

async function recordSale(
  c: Queryable,
  venueId: string,
  sale: QueuedCashSale,
  input: {
    deviceId: string | null;
    now: Temporal.Instant;
    outcome: "sold" | "failed";
    reason: string | null;
    checkId: string | null;
    label: string;
    orderId: string | null;
    paymentId: string | null;
  },
): Promise<void> {
  await c.query(
    `insert into offline_replays (venue_id, client_order_id, device_id, kind, queued_on, replayed_on,
       queued_at, replayed_at, check_id, tab_name, staff_membership_id, staff_name, lines, total_cents,
       cash_cents, tendered_cents, outcome, reason, order_id, cash_payment_id, cash_posted_at)
     values ($1, $2, $3, 'cash_sale', $4, $5, $6, $7, $8, $9,
       (select id from memberships where venue_id = $1 and id::text = $10), $11, $12, $13, $14, $15,
       $16, $17, $18, $19, case when $19::uuid is null then null else $7::timestamptz end)`,
    [
      venueId,
      sale.order_id,
      input.deviceId,
      await nightOf(c, venueId, Temporal.Instant.from(sale.queued_at)),
      await nightOf(c, venueId, input.now),
      sale.queued_at,
      input.now.toString(),
      input.checkId,
      input.label,
      sale.staff.membership_id,
      sale.staff.name,
      JSON.stringify(sale.lines),
      sale.total_cents,
      sale.cash_cents,
      sale.tendered_cents,
      input.outcome,
      input.reason,
      input.orderId,
      input.paymentId,
    ],
  );
}

/**
 * One cash sale checked again and made: the night is still the one it was sold on, the switch was
 * on for that night, the person who rang it is on the team, every drink is still on the menu and
 * not 86'd, the alcohol window allows it now (as a round's replay does, spec 09 · Replay), and the
 * server's own price is the one the computer took, to the cent. Then the quick sale is made and paid
 * in cash into this computer's drawer, with no second drawer kick. Any refusal throws (the caller
 * records it) and rolls the sale back, so nothing half-made stays.
 */
export async function replayCashSale(
  c: Queryable,
  venueId: string,
  sale: QueuedCashSale,
  input: { deviceId: string | null; now: Temporal.Instant; number: number },
): Promise<ReplayAnswer> {
  const night = await nightOf(c, venueId, Temporal.Instant.from(sale.queued_at));
  if (night !== (await nightOf(c, venueId, input.now))) throw new ReplayRefused("earlier_night");
  if (!(await offlineCashTerms(c, venueId, night))) throw new ReplayRefused("switched_off");
  const who = (
    await c.query<{ user_id: string; id: string }>(
      "select user_id, id from memberships where venue_id = $1 and id::text = $2 and status = 'active'",
      [venueId, sale.staff.membership_id],
    )
  ).rows[0];
  if (!who) throw new ReplayRefused("no_staff");
  // The menu, 86'd drinks and the alcohol window, checked as if it were rung now, before any check
  // is made: a refusal is logged after the rollback, on no check.
  const items = await orderItemsFor(
    c,
    venueId,
    sale.lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })),
    input.now,
  );
  await checkAlcohol(c, venueId, {
    items: items.map((i) => ({ name: i.name, alcohol: i.alcohol })),
    sessionId: null,
    checkId: null,
    roomGuestId: null,
    refusedBy: who.user_id,
    now: input.now,
  });
  const made = await startQuickSale(c, venueId, {
    number: input.number,
    lines: sale.lines.map((l) => ({ variant_id: l.variant_id, qty: l.qty })),
    clientOrderId: sale.order_id,
    userId: who.user_id,
    membershipId: who.id,
    deviceId: input.deviceId,
    keepDraft: true,
    now: input.now,
  });
  const cashPrice = made.cash_due_cents ?? made.amount_due_cents;
  if (made.amount_due_cents !== sale.total_cents || cashPrice !== sale.cash_cents)
    throw new ReplayRefused("price_changed");
  let paymentId: string;
  try {
    const taken = await takeCash(c, venueId, {
      checkId: made.check_id,
      amountCents: made.amount_due_cents,
      tenderedCents: sale.tendered_cents,
      tipCents: 0,
      userId: who.user_id,
      deviceId: input.deviceId,
      businessDate: night,
      noKick: true,
      now: input.now,
    });
    paymentId = taken.paymentId;
  } catch (e) {
    // A drawer that's someone else's (a drawer per person), or less handed over than owed.
    if (e instanceof ApiError) throw new ReplayRefused("cash_refused");
    throw e;
  }
  const order = (
    await c.query<{ id: string }>(
      "select id from orders where venue_id = $1 and client_order_id = $2",
      [venueId, sale.order_id],
    )
  ).rows[0]!;
  await recordSale(c, venueId, sale, {
    ...input,
    outcome: "sold",
    reason: null,
    checkId: made.check_id,
    label: made.check_label,
    orderId: order.id,
    paymentId,
  });
  return { order_id: sale.order_id, outcome: "sold", reason: null };
}

/** A cash sale the server refused: no check is made; it shows under Confirm replayed orders. */
export async function recordFailedCashSale(
  c: Queryable,
  venueId: string,
  sale: QueuedCashSale,
  input: { deviceId: string | null; now: Temporal.Instant; reason: string },
): Promise<ReplayAnswer> {
  await recordSale(c, venueId, sale, {
    deviceId: input.deviceId,
    now: input.now,
    outcome: "failed",
    reason: input.reason,
    checkId: null,
    label: QUICK,
    orderId: null,
    paymentId: null,
  });
  await emitEvent(c, {
    venueId,
    type: "offline.replay_failed",
    entityId: sale.order_id,
    entityVersion: 0,
  });
  return {
    order_id: sale.order_id,
    outcome: "failed",
    reason: input.reason as ReplayAnswer["reason"],
  };
}
