import {
  checkById,
  emitEvent,
  insertComputedLine,
  insertRevision,
  readSetting,
  rulePackFor,
  type CheckLineRow,
  type CheckRow,
  type Queryable,
} from "@west4/db";
import {
  checkTotals,
  gratuityApplies,
  salesTaxRule,
  type TaxCategory,
  type Totals,
  type TotalsLine,
} from "@west4/rules";
import { Temporal } from "@west4/shared";
import { ApiError } from "../http/errors.js";
import { sessionViews } from "./sessions.js";

/**
 * Finalizing a check into revisions (M4-07; Data model · the money core;
 * Money rules 2, 8 and 9). The totals come from `packages/rules`; finalize
 * writes revision n + 1 in one transaction with the check row locked: the
 * computed lines (room time, tax, gratuity) whose amounts changed are
 * reversed line by line and written anew, each tax line with its rate,
 * jurisdiction code, base and rule-pack version, and `check_revisions` keeps
 * the totals, the settings versions and the billing basis.
 */
const COMPUTED = new Set(["room_time", "min_spend", "tax", "gratuity"]);
const TAX_WORDS: Readonly<Record<TaxCategory, string>> = {
  room_time: "room time",
  drink: "drinks",
  food: "food",
  song: "songs",
  damage: "damage",
  fee: "fees",
  surcharge: "card fee",
};

export interface Worked {
  readonly totals: Totals;
  readonly roomTimeCents: number;
  readonly minutes: number | null;
  readonly gratuityPct: number | null;
  readonly rate: number;
  readonly jurisdictionCode: string | null;
  readonly rulePackVersion: string;
  readonly payVersion: number;
  readonly pricesVersion: number;
  readonly gratuityBasis: Record<string, unknown> | null;
  readonly billingBasis: Record<string, unknown> | null;
}

/** What a check comes to now (its net lines plus room time so far), without writing anything. */
export async function workOut(
  c: Queryable,
  venueId: string,
  check: CheckRow,
  lines: readonly CheckLineRow[],
  now: Temporal.Instant,
): Promise<Worked> {
  const venue = (
    await c.query<{ rule_pack_id: string | null }>(
      "select rule_pack_id from venues where id = $1",
      [venueId],
    )
  ).rows[0];
  const date = Temporal.PlainDate.from(check.business_date);
  const packId = venue?.rule_pack_id ?? "us-ny-new-york-county";
  const [pack, pay, prices] = await Promise.all([
    rulePackFor(c, packId, date),
    readSetting(c, venueId, "pay", date),
    readSetting(c, venueId, "prices", date),
  ]);
  if (!pack) throw new ApiError("internal", `no usable rule pack ${packId} for ${date.toString()}`);
  if (!pay) throw new ApiError("internal", "the pay settings aren't set");
  const tax = salesTaxRule(pack.pack);
  const session = check.room_session_id
    ? (await sessionViews(c, venueId, now, check.room_session_id))[0]
    : undefined;
  const roomTime = session?.clock.roomTimeCents ?? 0;
  const net: TotalsLine[] = lines
    .filter((l) => !COMPUTED.has(l.kind))
    .map((l) => ({
      kind: l.kind,
      taxCategory: l.tax_category as TaxCategory | null,
      cents: l.amount_cents,
    }));
  // Room time first, as the money cases list it: a tied leftover cent goes to the first category.
  if (session) net.unshift({ kind: "room_time", taxCategory: "room_time", cents: roomTime });
  const g = pay.value.gratuity;
  const applies = gratuityApplies(
    g.auto,
    { kind: check.kind, partySize: session?.party_size ?? null },
    g.partyMin,
  );
  const totals = checkTotals(net, { tax, gratuityPct: applies ? g.pct : null });
  return {
    totals,
    roomTimeCents: roomTime,
    minutes: session?.clock.minutes ?? null,
    gratuityPct: applies ? g.pct : null,
    rate: tax.rate,
    jurisdictionCode: tax.jurisdictionCode,
    rulePackVersion: pack.version,
    payVersion: pay.version,
    pricesVersion: prices?.version ?? 0,
    gratuityBasis: applies
      ? { rule: g.auto, party_size: session?.party_size ?? null, pct: g.pct }
      : null,
    billingBasis: session
      ? {
          minutes: session.clock.minutes,
          room_time_cents: roomTime,
          segments: session.segments.map((s) => ({
            started_at: s.started_at,
            ended_at: s.ended_at,
            rate_kind: s.rate_kind,
            billable_guests: s.billable_guests,
            hourly_cents: s.hourly_cents,
            band_id: s.band_id,
            increment_min: s.increment_min,
            rounding: s.rounding,
            paused: s.paused,
          })),
        }
      : null,
  };
}

/** A rate as numeric(7, 6): 0.08875 → "0.088750". */
const rateText = (rate: number): string => {
  const [whole, frac = ""] = rate.toString().split(".");
  return `${whole}.${frac.padEnd(6, "0").slice(0, 6)}`;
};

export async function finalizeCheck(
  c: Queryable,
  venueId: string,
  checkId: string,
  input: { userId: string; now: Temporal.Instant; ifMatch?: number },
): Promise<{ revision: number; worked: Worked; version: number }> {
  const locked = await c.query<{ version: number; status: string }>(
    "select version, status from checks where venue_id = $1 and id = $2 for update",
    [venueId, checkId],
  );
  const row = locked.rows[0];
  if (!row) throw new ApiError("not_found", "no such check");
  if (input.ifMatch !== undefined && row.version !== input.ifMatch)
    throw new ApiError("version_conflict", "someone changed this check first", {
      details: { version: row.version },
    });
  if (row.status === "paid" || row.status === "void")
    throw new ApiError("invalid_request", `this check is ${row.status}`);
  const found = (await checkById(c, venueId, checkId))!;
  const worked = await workOut(c, venueId, found.check, found.lines, input.now);
  const rev = found.check.revision + 1;
  const at = input.now.toString();
  const date = found.check.business_date;

  // What stands now: the computed lines nothing has reversed yet.
  const reversed = new Set(
    found.lines.map((l) => l.reverses_id).filter((x): x is number => x !== null),
  );
  const standing = found.lines.filter(
    (l) => COMPUTED.has(l.kind) && l.reverses_id === null && !reversed.has(l.id),
  );
  const next: {
    kind: "room_time" | "tax" | "gratuity";
    category: TaxCategory | null;
    cents: number;
  }[] = [];
  if (found.check.room_session_id)
    next.push({ kind: "room_time", category: "room_time", cents: worked.roomTimeCents });
  for (const [cat, cents] of Object.entries(worked.totals.taxByCategoryCents) as [
    TaxCategory,
    number,
  ][])
    if (cents !== 0) next.push({ kind: "tax", category: cat, cents });
  if (worked.totals.gratuityCents > 0)
    next.push({ kind: "gratuity", category: null, cents: worked.totals.gratuityCents });

  const describe = (n: (typeof next)[number]): string =>
    n.kind === "room_time"
      ? `Room time · ${worked.minutes ?? 0} min`
      : n.kind === "tax"
        ? `Tax · ${TAX_WORDS[n.category!]}`
        : `Gratuity (${worked.gratuityPct ?? 0}%)`;
  // A kind is rewritten only when what it comes to changed (each line's words and amount).
  const signature = (items: { description: string; cents: number }[]) =>
    items
      .map((x) => `${x.description}:${x.cents}`)
      .sort()
      .join("|");
  for (const kind of ["room_time", "tax", "gratuity"] as const) {
    const before = standing.filter((l) => l.kind === kind);
    const after = next.filter((n) => n.kind === kind);
    // Room time counts by amount alone: its words carry the minutes, which can change at the same amount.
    const same =
      signature(
        before.map((l) => ({
          description: kind === "room_time" ? "" : l.description,
          cents: l.amount_cents,
        })),
      ) ===
      signature(
        after.map((n) => ({
          description: kind === "room_time" ? "" : describe(n),
          cents: n.cents,
        })),
      );
    if (same) continue;
    for (const l of before)
      await insertComputedLine(c, venueId, checkId, {
        kind,
        description: l.description,
        amountCents: -l.amount_cents,
        revision: rev,
        businessDate: date,
        taxCategory: l.tax_category,
        reversesId: l.id,
        taxRate: l.tax_rate,
        taxableBaseCents: l.taxable_base_cents === null ? null : -l.taxable_base_cents,
        rulePackVersion: l.rule_pack_version,
        addedBy: input.userId,
        addedAt: at,
      });
    for (const n of after) {
      const base =
        n.kind === "tax"
          ? Number(
              found.lines
                .filter((l) => !COMPUTED.has(l.kind) && l.tax_category === n.category)
                .reduce((s, l) => s + l.amount_cents, 0) +
                (n.category === "room_time" ? worked.roomTimeCents : 0),
            )
          : null;
      await insertComputedLine(c, venueId, checkId, {
        kind: n.kind,
        description: describe(n),
        amountCents: n.cents,
        revision: rev,
        businessDate: date,
        // A tax line names no category of its own (Data model); its description says what it taxes.
        taxCategory: n.kind === "room_time" ? "room_time" : null,
        ...(n.kind === "tax"
          ? {
              taxRate: rateText(worked.rate),
              jurisdictionCode: worked.jurisdictionCode,
              taxableBaseCents: base,
              rulePackVersion: worked.rulePackVersion,
            }
          : {}),
        addedBy: input.userId,
        addedAt: at,
      });
    }
  }
  await insertRevision(c, venueId, checkId, {
    rev,
    subtotal_cents: worked.totals.subtotalCents,
    tax_cents: worked.totals.taxCents,
    gratuity_cents: worked.totals.gratuityCents,
    total_cents: worked.totals.totalCents,
    gratuity_basis: worked.gratuityBasis,
    billing_basis: worked.billingBasis,
    pay_version: worked.payVersion,
    prices_version: worked.pricesVersion,
    rule_pack_version: worked.rulePackVersion,
    finalizedBy: input.userId,
    finalizedAt: at,
  });
  const updated = await c.query<{ version: number }>(
    "update checks set revision = $3, version = version + 1 where venue_id = $1 and id = $2 returning version",
    [venueId, checkId, rev],
  );
  await emitEvent(c, {
    venueId,
    type: "check.updated",
    entityId: checkId,
    entityVersion: updated.rows[0]!.version,
  });
  return { revision: rev, worked, version: updated.rows[0]!.version };
}
