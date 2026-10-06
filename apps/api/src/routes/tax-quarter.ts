import type { FastifyInstance } from "fastify";
import { rulePackFor, type Queryable } from "@west4/db";
import { businessDate, taxQuarterOf } from "@west4/rules";
import { Temporal, cents, divideByWeights, type Clock } from "@west4/shared";
import { route } from "../http/conventions.js";
import { ApiError } from "../http/errors.js";
import { venueClock } from "../rooms/assignment.js";

/**
 * The sales-tax quarter (M7-17; Money rules 2 and 8; spec 08 · Reports and
 * exports `/reports/tax-quarter`): New York's quarters by business date, from
 * the tax lines as written (live views, so practice is left out). Taxable
 * base and tax per category and jurisdiction; the sales not taxed (the
 * gratuity); late adjustments in the quarter they post to; and the quarter's
 * last night's sales from midnight to the cutover on their own line, which
 * quarter they count in following the rule pack's `salesTax.quarterBoundary`
 * ("businessDate" until the accountant answers). `?format=csv` exports it and
 * asks for the passkey again.
 */
export interface TaxQuarterReport {
  readonly quarter: { readonly label: string; readonly start: string; readonly end: string };
  readonly boundary: "businessDate" | "calendarDate";
  readonly rows: readonly {
    readonly category: string;
    readonly jurisdiction: string;
    readonly rate: string;
    readonly taxable_base_cents: number;
    readonly tax_cents: number;
  }[];
  readonly tax_cents: number;
  readonly not_taxed: { readonly gratuity_cents: number };
  readonly adjustments: { readonly taxable_base_cents: number; readonly tax_cents: number };
  readonly after_midnight: {
    readonly business_date: string;
    readonly taxable_base_cents: number;
    readonly tax_cents: number;
  };
}

export async function taxQuarterReport(
  c: Queryable,
  venueId: string,
  date: string,
): Promise<TaxQuarterReport> {
  const quarter = taxQuarterOf(date);
  const { timeZone } = await venueClock(c, venueId);
  const v = (
    await c.query<{ rule_pack_id: string | null }>(
      "select rule_pack_id from venues where id = $1",
      [venueId],
    )
  ).rows[0];
  const pack = await rulePackFor(
    c,
    v?.rule_pack_id ?? "us-ny-new-york-county",
    Temporal.PlainDate.from(quarter.end),
  );
  const boundary = pack?.pack.salesTax.quarterBoundary ?? "businessDate";
  const range = [venueId, quarter.start, quarter.end];
  // Tax is written once per rate on each check (Money rules 8), so each check's tax is shared out over its
  // taxed categories by their bases, largest remainder: the categories add up to the tax lines to the cent.
  const taxed = new Set<string>(
    pack?.pack.salesTax.taxedCategories ?? ["room_time", "drink", "damage"],
  );
  const perCheck = await c.query<{
    check_id: string;
    jurisdiction: string;
    rate: string;
    tax: string;
    bases: Record<string, string> | null;
  }>(
    `select t.check_id, coalesce(t.jurisdiction_code, '') as jurisdiction, coalesce(t.tax_rate::text, '') as rate,
            sum(t.amount_cents)::text as tax,
            (select jsonb_object_agg(b.tax_category, b.base) from (
               select l.tax_category, sum(l.amount_cents)::text as base from live_check_lines l
                where l.venue_id = t.venue_id and l.check_id = t.check_id and l.tax_category is not null
                  and l.kind not in ('tax', 'gratuity') and l.adjusts_business_date is null
                group by l.tax_category) b) as bases
       from live_check_lines t
      where t.venue_id = $1 and t.kind = 'tax' and t.business_date between $2::date and $3::date
        and t.adjusts_business_date is null
      group by t.venue_id, t.check_id, t.jurisdiction_code, t.tax_rate`,
    range,
  );
  const sums = new Map<
    string,
    { category: string; jurisdiction: string; rate: string; base: number; tax: number }
  >();
  for (const k of perCheck.rows) {
    const cats = Object.entries(k.bases ?? {})
      .filter(([cat]) => taxed.has(cat))
      .map(([cat, base]) => [cat, Math.max(0, Number(base))] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const tax = Number(k.tax);
    const split = cats.length > 0 && cats.some(([, b]) => b > 0) && tax >= 0;
    const parts = split
      ? divideByWeights(
          cents(tax),
          cats.map(([, b]) => b),
        )
      : [cents(tax)];
    const named: readonly (readonly [string, number])[] = split ? cats : [["", 0]];
    named.forEach(([cat, base], n) => {
      const key = `${cat}|${k.jurisdiction}|${k.rate}`;
      const row = sums.get(key) ?? {
        category: cat,
        jurisdiction: k.jurisdiction,
        rate: k.rate,
        base: 0,
        tax: 0,
      };
      row.base += base;
      row.tax += parts[n]!;
      sums.set(key, row);
    });
  }
  const rows = [...sums.values()]
    .sort((a, b) =>
      a.category + a.jurisdiction + a.rate < b.category + b.jurisdiction + b.rate ? -1 : 1,
    )
    .map((r) => ({
      category: r.category,
      jurisdiction: r.jurisdiction,
      rate: r.rate,
      taxable_base_cents: r.base,
      tax_cents: r.tax,
    }));
  const gratuity = (
    await c.query<{ cents: string }>(
      `select coalesce(sum(amount_cents), 0)::text as cents from live_check_lines
        where venue_id = $1 and kind = 'gratuity' and business_date between $2::date and $3::date
          and adjusts_business_date is null`,
      range,
    )
  ).rows[0]!.cents;
  const adjustments = (
    await c.query<{ base: string; tax: string }>(
      `select coalesce(sum(taxable_base_cents), 0)::text as base, coalesce(sum(amount_cents), 0)::text as tax
         from live_check_lines
        where venue_id = $1 and kind = 'tax' and business_date between $2::date and $3::date
          and adjusts_business_date is not null`,
      range,
    )
  ).rows[0]!;
  // The last night's tax lines written after midnight in the venue's time: their own line.
  const after = (
    await c.query<{ base: string; tax: string }>(
      `select coalesce(sum(taxable_base_cents), 0)::text as base, coalesce(sum(amount_cents), 0)::text as tax
         from live_check_lines
        where venue_id = $1 and kind = 'tax' and business_date = $2::date and adjusts_business_date is null
          and (added_at at time zone $3)::date > business_date`,
      [venueId, quarter.end, timeZone],
    )
  ).rows[0]!;
  return {
    quarter,
    boundary,
    rows,
    tax_cents: rows.reduce((s, r) => s + r.tax_cents, 0) + Number(adjustments.tax),
    not_taxed: { gratuity_cents: Number(gratuity) },
    adjustments: {
      taxable_base_cents: Number(adjustments.base),
      tax_cents: Number(adjustments.tax),
    },
    after_midnight: {
      business_date: quarter.end,
      taxable_base_cents: Number(after.base),
      tax_cents: Number(after.tax),
    },
  };
}

function csv(r: TaxQuarterReport): string {
  const m = (c: number) => (c / 100).toFixed(2);
  const out = ["Quarter,Category,Jurisdiction,Rate,Taxable base,Tax"];
  for (const row of r.rows)
    out.push(
      [
        r.quarter.label,
        row.category,
        row.jurisdiction,
        row.rate,
        m(row.taxable_base_cents),
        m(row.tax_cents),
      ].join(","),
    );
  out.push(
    [
      r.quarter.label,
      "Late adjustments",
      "",
      "",
      m(r.adjustments.taxable_base_cents),
      m(r.adjustments.tax_cents),
    ].join(","),
  );
  out.push(
    [
      r.quarter.label,
      `After midnight on ${r.after_midnight.business_date}`,
      "",
      "",
      m(r.after_midnight.taxable_base_cents),
      m(r.after_midnight.tax_cents),
    ].join(","),
  );
  out.push(
    [r.quarter.label, "Not taxed: gratuity", "", "", m(r.not_taxed.gratuity_cents), ""].join(","),
  );
  out.push([r.quarter.label, "Total tax", "", "", "", m(r.tax_cents)].join(","));
  return `${out.join("\n")}\n`;
}

export function taxQuarterRoutes(app: FastifyInstance, options: { clock: Clock }): void {
  app.get<{ Params: { venueId: string }; Querystring: { date?: string; format?: string } }>(
    "/v1/venues/:venueId/reports/tax-quarter",
    { config: route({ principals: ["owner_manager"], module: "core", action: "admin.access" }) },
    async (request) => {
      const venueId = request.venueId!;
      if (request.query.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(request.query.date))
        throw new ApiError("invalid_request", "send ?date=YYYY-MM-DD, any date in the quarter");
      // Exporting asks for the passkey again (spec 02).
      if (request.query.format === "csv") await request.server.consumeStepUp!(request);
      return request.inVenue(async (c) => {
        const v = await venueClock(c, venueId);
        const date =
          request.query.date ??
          businessDate(options.clock.now(), v.timeZone, v.dayCutover).businessDate.toString();
        const report = await taxQuarterReport(c, venueId, date);
        return request.query.format === "csv"
          ? { filename: `west4-sales-tax-${report.quarter.label}.csv`, file: csv(report) }
          : report;
      });
    },
  );
}
