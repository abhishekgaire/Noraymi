import { readSetting, rulePackFor, rulePackVersions, type Queryable } from "@west4/db";
import {
  AUDIT_COVERS,
  auditCheck,
  auditRefunds,
  salesTaxRule,
  type AuditLine,
  type MoneyError,
  type MoneyErrorKind,
  type SalesTaxRule,
  type TaxCategory,
} from "@west4/rules";
import { Temporal } from "@west4/shared";
import { reconcileNight } from "./night.js";

/**
 * The nightly money audit (M9-15), built on the reconcile script (M7-19). On top of what
 * reconcileNight checks (the Z report, drawers, the tip ledger and pool, payouts, journals,
 * practice), it works every check of the night out again through packages/rules and compares it
 * with what's stored: each check's tax and gratuity against its lines, its stored revision against
 * its lines, the card fee (off at West 4), every paid check's payments against what it comes to (a
 * double or missed charge), every captured payment against a check or a booking, and every refund
 * against its cap. Reads only; recordAudit writes the result.
 */
export interface MoneyAudit {
  readonly night: string;
  readonly ok: boolean;
  readonly covered: readonly string[];
  readonly errors: readonly MoneyError[];
}

const RECONCILE_KIND: Record<string, MoneyErrorKind> = {
  closed: "report",
  z_report: "report",
  practice: "report",
  drawers: "drawer",
  tip_ledger: "tip",
  tip_pool: "tip",
  payouts: "payout",
  journals: "journal",
};

const n = (v: string | number | null | undefined) => Number(v ?? 0);

export async function auditNight(
  c: Queryable,
  venueId: string,
  date: string,
  now: Temporal.Instant,
): Promise<MoneyAudit> {
  const errors: MoneyError[] = [];
  const recon = await reconcileNight(c, venueId, date, now);
  for (const d of recon.differences)
    errors.push({
      kind: RECONCILE_KIND[d.rule] ?? "report",
      night: date,
      ...(d.check ? { ref: d.check } : {}),
      detail: `${d.rule}: ${d.detail}`,
    });

  const day = Temporal.PlainDate.from(date);
  const packId =
    (
      await c.query<{ rule_pack_id: string | null }>(
        "select rule_pack_id from venues where id = $1",
        [venueId],
      )
    ).rows[0]?.rule_pack_id ?? "us-ny-new-york-county";
  const versions = await rulePackVersions(c, packId);
  const fallback = await rulePackFor(c, packId, day);
  const taxFor = new Map<string, SalesTaxRule>();
  const taxOf = (version: string | null): SalesTaxRule | null => {
    const key = version ?? fallback?.version ?? "";
    if (!taxFor.has(key)) {
      const pack = versions.find((v) => v.version === key)?.pack ?? fallback?.pack;
      if (!pack) return null;
      taxFor.set(key, salesTaxRule(pack));
    }
    return taxFor.get(key)!;
  };
  const pay = await readSetting(c, venueId, "pay", day);
  const cardFee = pay?.value.cardFee.mode ?? "off";
  const feeMode = cardFee === "discount" ? "cashDiscount" : cardFee;

  // Every check of the night that has been worked out: its lines, its last revision, its payments.
  const checks = await c.query<{
    id: string;
    number: string;
    status: "finalized" | "partly_paid" | "paid";
    tax: string | null;
    gratuity: string | null;
    total: string | null;
    pct: string | null;
    pack_version: string | null;
    paid: string;
  }>(
    `select k.id, k.number::text, k.status,
            r.tax_cents::text as tax, r.gratuity_cents::text as gratuity, r.total_cents::text as total,
            r.gratuity_basis ->> 'pct' as pct, r.rule_pack_version as pack_version,
            (select coalesce(sum(a.amount_cents), 0) from payment_allocations a
               join live_payments p on p.venue_id = a.venue_id and p.id = a.payment_id
              where a.venue_id = k.venue_id and a.check_id = k.id
                and a.kind = 'payment' and a.state = 'captured')::text as paid
       from live_checks k
       left join check_revisions r on r.venue_id = k.venue_id and r.check_id = k.id and r.rev = k.revision
      where k.venue_id = $1 and k.business_date = $2::date
        and k.status in ('finalized', 'partly_paid', 'paid')
      order by k.number`,
    [venueId, date],
  );
  const lines = await c.query<{
    check_id: string;
    kind: string;
    tax_category: TaxCategory | null;
    cents: string;
  }>(
    `select l.check_id, l.kind, l.tax_category, l.amount_cents::text as cents
       from live_check_lines l join live_checks k on k.venue_id = l.venue_id and k.id = l.check_id
      where k.venue_id = $1 and k.business_date = $2::date and l.kind <> 'refund'
      order by l.id`,
    [venueId, date],
  );
  const byCheck = new Map<string, AuditLine[]>();
  for (const l of lines.rows) {
    const list = byCheck.get(l.check_id) ?? [];
    list.push({ kind: l.kind, taxCategory: l.tax_category, cents: n(l.cents) });
    byCheck.set(l.check_id, list);
  }
  for (const k of checks.rows) {
    const tax = taxOf(k.pack_version);
    const ref = `#${k.number}`;
    if (!tax) {
      errors.push({ kind: "tax", night: date, ref, detail: "no usable rule pack to work it out" });
      continue;
    }
    errors.push(
      ...auditCheck({
        night: date,
        ref,
        status: k.status,
        lines: byCheck.get(k.id) ?? [],
        tax,
        gratuityPct: k.pct === null ? null : Number(k.pct),
        revision:
          k.total === null
            ? null
            : { taxCents: n(k.tax), gratuityCents: n(k.gratuity), totalCents: n(k.total) },
        cardFee: feeMode,
        paidCents: n(k.paid),
      }),
    );
  }

  // Every captured payment of the night belongs to a check or a booking; a surcharge only with the fee on.
  const payments = await c.query<{ id: string; surcharge: string; placed: boolean }>(
    `select p.id, p.surcharge_cents::text as surcharge,
            (p.booking_id is not null or exists (
               select 1 from payment_allocations a where a.venue_id = p.venue_id and a.payment_id = p.id
                  and a.kind = 'payment' and a.state = 'captured')) as placed
       from live_payments p
      where p.venue_id = $1 and p.business_date = $2::date and p.adjusts_business_date is null
        and p.status in ('captured', 'partly_refunded', 'refunded')`,
    [venueId, date],
  );
  for (const p of payments.rows) {
    if (!p.placed)
      errors.push({
        kind: "charge",
        night: date,
        ref: p.id,
        detail: "a captured payment on no check and no booking",
      });
    if (cardFee === "off" && n(p.surcharge) !== 0)
      errors.push({
        kind: "card_fee",
        night: date,
        ref: p.id,
        detail: `a surcharge of ${p.surcharge} with the card fee off`,
        expectedCents: 0,
        actualCents: n(p.surcharge),
        diffCents: n(p.surcharge),
      });
  }

  // Every payment refunded this night: all its refunds, oldest first, under its capture.
  const refunded = await c.query<{ id: string; captured: string; refunds: string[] }>(
    `select p.id, (p.amount_cents + p.tip_cents + p.surcharge_cents)::text as captured,
            array_agg(r.amount_cents::text order by r.n) as refunds
       from live_payments p join refunds r on r.venue_id = p.venue_id and r.payment_id = p.id
      where p.venue_id = $1 and r.status in ('pending', 'succeeded')
        and p.id in (select payment_id from refunds where venue_id = $1 and business_date = $2::date)
      group by p.id, p.amount_cents, p.tip_cents, p.surcharge_cents`,
    [venueId, date],
  );
  for (const p of refunded.rows)
    errors.push(
      ...auditRefunds({
        night: date,
        paymentRef: p.id,
        capturedCents: n(p.captured),
        refundsCents: p.refunds.map(n),
      }),
    );

  const covered = [...recon.checked, "checks", "charges", "refunds", `card_fee (${cardFee})`];
  return {
    night: date,
    ok: errors.length === 0,
    covered,
    errors: errors.map((e) => JSON.parse(JSON.stringify(e)) as MoneyError),
  };
}

/** The definition's verbs this audit covered, for the evidence and the summary. */
export const auditCovers = AUDIT_COVERS;
