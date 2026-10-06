import { emitEvent, withVenue, type Queryable } from "@west4/db";
import type { Temporal } from "@west4/shared";
import { enqueuePush } from "../push/send-push.js";
import { stripeEventHandlers, type StripeEventContext } from "../stripe/webhooks.js";
import { recordUnmatched } from "./reconcile.js";

/**
 * Payout matching (M7-14; Stripe setup 8 and 11; Security and data retention
 * 4). On `payout.reconciliation_completed`, the payout's balance transactions
 * are listed with the reporting key and each charge and refund is matched to
 * our payments row by its PaymentIntent, never by metadata. Each line's venue
 * comes from that row (through `resolve_payment_intent`, which stays inside
 * the account's organization); every venue touched gets its own `payouts` row
 * and its own lines, all written in that venue's scope by a job with no user.
 * Stripe's fees post as fees; a charge with no row of ours is recorded in
 * Unmatched payments (an `external` payment with no allocation, as M4-12's
 * reconciler records them); anything else is "other". The lines add up to the
 * payout, or the owner is told it doesn't reconcile. The same event again
 * changes nothing.
 */
interface BalanceTxn {
  readonly id: string;
  readonly type: string;
  readonly amount: number;
  readonly fee: number;
  readonly net: number;
  readonly source:
    | string
    | {
        readonly id: string;
        readonly object: string;
        readonly payment_intent?: string | { readonly id: string } | null;
      }
    | null;
}
interface Payout {
  readonly id: string;
  readonly amount: number;
  readonly arrival_date?: number;
}

const piOf = (t: BalanceTxn): string | null => {
  if (!t.source || typeof t.source === "string") return null;
  const pi = t.source.payment_intent;
  return typeof pi === "string" ? pi : (pi?.id ?? null);
};

type Kind = "charge" | "refund" | "fee" | "unmatched" | "other";
const CHARGE = new Set(["charge", "payment"]);
const REFUND = new Set(["refund", "payment_refund"]);
const FEE = new Set(["stripe_fee", "application_fee", "tax_fee", "network_cost"]);

export async function matchPayout(ctx: StripeEventContext): Promise<void> {
  const payload = ctx.event.payload as {
    account?: string;
    data?: { object?: { id?: string } };
  };
  const account = payload.account ?? ctx.event.account;
  const payoutId = payload.data?.object?.id;
  if (!account || !payoutId) return;
  const stripe = ctx.stripe.forTraining(ctx.training);
  const payout = await stripe.call<Payout>("reporting", "GET", `/v1/payouts/${payoutId}`, {
    account,
  });
  const txns: BalanceTxn[] = [];
  for (let after: string | undefined; ;) {
    const page = await stripe.call<{ data: BalanceTxn[]; has_more: boolean }>(
      "reporting",
      "GET",
      "/v1/balance_transactions",
      {
        account,
        params: {
          payout: payoutId,
          limit: 100,
          "expand[]": "data.source",
          ...(after ? { starting_after: after } : {}),
        },
      },
    );
    txns.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    after = page.data[page.data.length - 1]!.id;
  }

  // Each line, with the venue and payment it belongs to; the payout's own transaction isn't a line.
  const lines: { txn: BalanceTxn; kind: Kind; venueId: string; paymentId: string | null }[] = [];
  for (const t of txns) {
    if (t.type === "payout") continue;
    const pi = piOf(t);
    let kind: Kind = CHARGE.has(t.type)
      ? "charge"
      : REFUND.has(t.type)
        ? "refund"
        : FEE.has(t.type)
          ? "fee"
          : "other";
    let venueId = ctx.venueId;
    let paymentId: string | null = null;
    if ((kind === "charge" || kind === "refund") && pi) {
      const found = await ctx.inVenue((c) =>
        c.query<{ venue_id: string; payment_id: string }>(
          "select * from resolve_payment_intent($1, $2)",
          [account, pi],
        ),
      );
      if (found.rows[0]) {
        venueId = found.rows[0].venue_id;
        paymentId = found.rows[0].payment_id;
      } else if (kind === "charge") {
        // Stripe activity with no row of ours (a break-glass Tap to Pay payment): Unmatched payments.
        const intent = await stripe.call<Record<string, unknown>>(
          "reporting",
          "GET",
          `/v1/payment_intents/${pi}`,
          { account, params: { "expand[]": "latest_charge" } },
        );
        paymentId = await recordUnmatched(
          { pool: ctx.pool, stripe, clock: { now: () => ctx.now } } as never,
          ctx.venueId,
          intent as never,
          ctx.now,
        );
        if (!paymentId)
          paymentId =
            (
              await ctx.inVenue((c) =>
                c.query<{ id: string }>(
                  "select id from payments where venue_id = $1 and stripe_pi_id = $2",
                  [ctx.venueId, pi],
                ),
              )
            ).rows[0]?.id ?? null;
        kind = "unmatched";
      }
    } else if (kind === "charge" || kind === "refund") kind = "other";
    lines.push({ txn: t, kind, venueId, paymentId });
  }

  const net = lines.reduce((s, l) => s + l.txn.net, 0);
  const reconciled = net === payout.amount;
  const arrival = payout.arrival_date
    ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
    : null;
  const venues = [...new Set([ctx.venueId, ...lines.map((l) => l.venueId)])];
  for (const v of venues)
    await withVenue(
      ctx.pool,
      { venueId: v, requestId: `payout:${payoutId}` },
      async (c: Queryable) => {
        const made = await c.query<{ id: string }>(
          `insert into payouts (venue_id, stripe_payout_id, account, amount_cents, arrival_date, reconciled)
         values ($1, $2, $3, $4, $5, $6) on conflict (venue_id, stripe_payout_id) do nothing returning id`,
          [v, payoutId, account, payout.amount, arrival, reconciled],
        );
        const id = made.rows[0]?.id;
        if (!id) return; // the same event again: already matched
        for (const l of lines.filter((x) => x.venueId === v))
          await c.query(
            `insert into payout_lines (venue_id, payout_id, balance_txn_id, type, payment_id, gross_cents, fee_cents, net_cents)
           values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (venue_id, balance_txn_id) do nothing`,
            [v, id, l.txn.id, l.kind, l.paymentId, l.txn.amount, l.txn.fee, l.txn.net],
          );
        await emitEvent(c, {
          venueId: v,
          type: "payout.matched",
          entityId: id,
          audience: "managers",
        });
        if (!reconciled && v === ctx.venueId)
          await enqueuePush(c, {
            venueId: v,
            audience: { kind: "role", role: "owner" },
            message: {
              key: "push.payoutOff.body",
              params: { payout: payoutId },
              tag: `payout-${payoutId}`,
            },
            runAt: ctx.now as Temporal.Instant,
          });
      },
    );
}

stripeEventHandlers.set("payout.reconciliation_completed", matchPayout);
