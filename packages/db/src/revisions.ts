import type { Queryable } from "./tenancy.js";

/**
 * Check revisions (M4-07; Data model · the money core). Each finalize writes
 * revision n + 1: its computed lines (room time, minimum spend, tax,
 * gratuity) carry the revision, and `check_revisions` keeps the totals, the
 * settings versions and the billing basis. Inside a venue transaction.
 */
export interface RevisionRow {
  readonly rev: number;
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly gratuity_cents: number;
  readonly total_cents: number;
  readonly gratuity_basis: Record<string, unknown> | null;
  readonly billing_basis: Record<string, unknown> | null;
  readonly pay_version: number;
  readonly prices_version: number;
  readonly rule_pack_version: string;
  readonly finalized_at: string;
}

export async function latestRevision(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<RevisionRow | null> {
  const r = await c.query<RevisionRow>(
    `select rev, subtotal_cents::int, tax_cents::int, gratuity_cents::int, total_cents::int, gratuity_basis,
            billing_basis, pay_version, prices_version, rule_pack_version, to_json(finalized_at) #>> '{}' as finalized_at
       from check_revisions where venue_id = $1 and check_id = $2 order by rev desc limit 1`,
    [venueId, checkId],
  );
  return r.rows[0] ?? null;
}

export async function insertRevision(
  c: Queryable,
  venueId: string,
  checkId: string,
  r: Omit<RevisionRow, "finalized_at"> & { finalizedBy: string; finalizedAt: string },
): Promise<void> {
  await c.query(
    `insert into check_revisions (venue_id, check_id, rev, subtotal_cents, tax_cents, gratuity_cents, total_cents,
       gratuity_basis, billing_basis, pay_version, prices_version, rule_pack_version, finalized_by, finalized_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      venueId,
      checkId,
      r.rev,
      r.subtotal_cents,
      r.tax_cents,
      r.gratuity_cents,
      r.total_cents,
      r.gratuity_basis === null ? null : JSON.stringify(r.gratuity_basis),
      r.billing_basis === null ? null : JSON.stringify(r.billing_basis),
      r.pay_version,
      r.prices_version,
      r.rule_pack_version,
      r.finalizedBy,
      r.finalizedAt,
    ],
  );
}

export interface ComputedLineInput {
  readonly kind: "room_time" | "min_spend" | "tax" | "gratuity";
  readonly description: string;
  readonly amountCents: number;
  readonly revision: number;
  readonly businessDate: string;
  readonly taxCategory: string | null;
  readonly reversesId?: number | null;
  readonly taxRate?: string | null;
  readonly jurisdictionCode?: string | null;
  readonly taxableBaseCents?: number | null;
  readonly rulePackVersion?: string | null;
  readonly addedBy: string | null;
  readonly addedAt: string;
}

/** A computed line of a revision; never changes the check's version itself (finalize does, once). */
export async function insertComputedLine(
  c: Queryable,
  venueId: string,
  checkId: string,
  l: ComputedLineInput,
): Promise<number> {
  const r = await c.query<{ id: string }>(
    `insert into check_lines (venue_id, check_id, kind, revision, description, qty, unit_cents, amount_cents,
       tax_category, tax_rate, jurisdiction_code, taxable_base_cents, reverses_id, business_date, adjusts_business_date,
       rule_pack_version, added_by, added_at)
     values ($1, $2, $3, $4, $5, 1, $6, $6, $7, $8, $9, $10, $11, open_business_date($1, $12::date),
       nullif($12::date, open_business_date($1, $12::date)), $13, $14, $15) returning id`,
    [
      venueId,
      checkId,
      l.kind,
      l.revision,
      l.description,
      l.amountCents,
      l.taxCategory,
      l.taxRate ?? null,
      l.jurisdictionCode ?? null,
      l.taxableBaseCents ?? null,
      l.reversesId ?? null,
      l.businessDate,
      l.rulePackVersion ?? null,
      l.addedBy,
      l.addedAt,
    ],
  );
  return Number(r.rows[0]!.id);
}
