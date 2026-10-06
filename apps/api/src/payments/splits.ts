import {
  amountDue,
  checkById,
  emitEvent,
  endSplit,
  insertSplit,
  latestRevision,
  openSplit,
  rulePackFor,
  setShareState,
  shareOf,
  sharesOfPayment,
  type Queryable,
  type SplitRow,
} from "@west4/db";
import { checkTotals, salesTaxRule, splitByItem, splitEven, type TaxCategory } from "@west4/rules";
import { Temporal, cents, divideByWeights } from "@west4/shared";
import { ApiError } from "../http/errors.js";

/**
 * Splits (M4-14; Money rules 1 and 13; Payment flows · Split), kept on the
 * server. An even split divides what's left to pay into N shares, leftover
 * cents to the first; a split by item gives each person their own items and
 * an even part of room time and of lines nobody claimed, with tax and
 * gratuity by largest remainder. Each share pays with its own way to pay and
 * state; "Stop splitting" ends the split and keeps the paid shares.
 */
export type SplitRequest =
  | { readonly kind: "even"; readonly shares: number }
  | {
      readonly kind: "items";
      readonly people: number;
      readonly claims: Readonly<Record<string, number>>;
    };

export async function startSplit(
  c: Queryable,
  venueId: string,
  checkId: string,
  input: SplitRequest,
  by: { userId: string; now: Temporal.Instant },
): Promise<SplitRow> {
  const locked = await c.query<{ status: string }>(
    "select status from checks where venue_id = $1 and id = $2 for update",
    [venueId, checkId],
  );
  const status = locked.rows[0]?.status;
  if (!status) throw new ApiError("not_found", "no such check");
  if (status !== "finalized" && status !== "partly_paid")
    throw new ApiError("invalid_request", "present the check before splitting it", {
      details: { status },
    });
  const existing = await openSplit(c, venueId, checkId);
  if (existing)
    throw new ApiError("in_progress", "this check is split already", {
      details: { split_id: existing.id },
    });
  // What was left to pay when the split started: for a room, the presented check less what's paid; for a
  // bar tab, its total less what's paid, since its hold is only a guarantee (M6-10).
  const base = await amountDue(
    c,
    checkId,
    (await tabHoldOf(c, venueId, checkId))?.paymentId ?? null,
  );
  const rev = await latestRevision(c, venueId, checkId);
  if (!rev) throw new ApiError("invalid_request", "present the check before splitting it");
  const count = input.kind === "even" ? input.shares : input.people;
  if (!Number.isInteger(count) || count < 2 || count > 50)
    throw new ApiError("invalid_request", "split into 2 to 50 shares");

  let shares: {
    kind: "even" | "items";
    amountCents: number;
    taxCents: number;
    gratuityCents: number;
    lineIds?: number[];
  }[];
  if (input.kind === "even") {
    const amounts = splitEven(base, count);
    const taxes = splitEven(rev.tax_cents, count);
    const grats = splitEven(rev.gratuity_cents, count);
    shares = amounts.map((a, i) => ({
      kind: "even",
      amountCents: a,
      taxCents: taxes[i]!,
      gratuityCents: grats[i]!,
    }));
  } else {
    const found = (await checkById(c, venueId, checkId))!;
    const packId =
      (
        await c.query<{ p: string | null }>("select rule_pack_id as p from venues where id = $1", [
          venueId,
        ])
      ).rows[0]?.p ?? "us-ny-new-york-county";
    const pack = await rulePackFor(c, packId, Temporal.PlainDate.from(found.check.business_date));
    if (!pack) throw new ApiError("internal", "no usable rule pack");
    const tax = salesTaxRule(pack.pack);
    // The standing lines: every sale and correction, and the revision's room time (tax and gratuity are shared).
    const reversed = new Set(
      found.lines.map((l) => l.reverses_id).filter((x): x is number => x !== null),
    );
    const lines = found.lines
      .filter(
        (l) =>
          l.kind !== "tax" &&
          l.kind !== "gratuity" &&
          !(l.kind === "room_time" && (l.reverses_id !== null || reversed.has(l.id))),
      )
      .map((l) => ({
        kind: l.kind,
        taxCategory: l.tax_category as TaxCategory | null,
        cents: l.amount_cents,
        claimedBy: input.claims[String(l.id)] ?? null,
        id: l.id,
      }));
    for (const who of Object.values(input.claims))
      if (!Number.isInteger(who) || who < 0 || who >= count)
        throw new ApiError("invalid_request", "a claim names no one");
    const totals = checkTotals(lines, { tax, gratuityPct: null });
    const parts = splitByItem({
      people: count,
      lines,
      totals: {
        ...totals,
        taxCents: cents(rev.tax_cents),
        gratuityCents: cents(rev.gratuity_cents),
        totalCents: cents(rev.total_cents),
      },
      tax,
    });
    // What's already paid (the deposit, earlier payments) comes off each share in proportion, so the shares add up to what's left.
    const paid = rev.total_cents - base;
    const off =
      paid > 0
        ? divideByWeights(
            cents(paid),
            parts.map((p) => Math.max(0, p.totalCents)),
          )
        : parts.map(() => 0);
    shares = parts.map((p, i) => ({
      kind: "items",
      amountCents: p.totalCents - off[i]!,
      taxCents: p.taxCents,
      gratuityCents: p.gratuityCents,
      lineIds: lines.filter((l) => l.claimedBy === i).map((l) => l.id),
    }));
  }
  await insertSplit(c, venueId, {
    checkId,
    baseCents: base,
    createdBy: by.userId,
    at: by.now.toString(),
    shares,
  });
  await emitEvent(c, { venueId, type: "check.updated", entityId: checkId });
  return (await openSplit(c, venueId, checkId))!;
}

/** "Stop splitting · charge the rest to …": the split ends, its paid shares stay paid. */
export async function stopSplit(
  c: Queryable,
  venueId: string,
  splitId: string,
  by: { userId: string; now: Temporal.Instant },
): Promise<{ check_id: string }> {
  const r = await c.query<{ check_id: string }>(
    "select check_id from check_splits where venue_id = $1 and id = $2 and ended_at is null for update",
    [venueId, splitId],
  );
  const split = r.rows[0];
  if (!split) throw new ApiError("not_found", "no such split");
  const paying = await c.query(
    "select 1 from split_shares where venue_id = $1 and split_id = $2 and state = 'paying'",
    [venueId, splitId],
  );
  if (paying.rowCount) throw new ApiError("in_progress", "a share is being paid right now");
  await endSplit(c, venueId, splitId, by.userId, by.now.toString());
  await emitEvent(c, { venueId, type: "check.updated", entityId: split.check_id });
  return split;
}

/**
 * A bar tab's hold standing on this check (M6-10): an authorized card that guarantees what's left. Its
 * allocation follows the lines, so it's left out of what a split's shares owe.
 */
export async function tabHoldOf(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<{ tabId: string; paymentId: string } | null> {
  const r = await c.query<{ tab_id: string; payment_id: string }>(
    `select t.id as tab_id, t.payment_id from tabs t
       join payments p on p.venue_id = t.venue_id and p.id = t.payment_id
      where t.venue_id = $1 and t.check_id = $2 and p.status = 'authorized'`,
    [venueId, checkId],
  );
  const row = r.rows[0];
  return row ? { tabId: row.tab_id, paymentId: row.payment_id } : null;
}

/**
 * Before a payment takes a share: it must be a share of this check's open split, not paid or being
 * paid, and the amount is the share's. On a bar tab with a hold, the held card's share is captured last
 * (M6-10), so the last share left is never paid another way while the hold stands; the payment's
 * allocation leaves the hold out of what's due (the answer).
 */
export async function claimShare(
  c: Queryable,
  venueId: string,
  checkId: string,
  shareId: string,
  amountCents: number,
  state: "paying" | "paid",
): Promise<{ leaveOut: string | null }> {
  const share = await shareOf(c, venueId, checkId, shareId);
  if (!share) throw new ApiError("not_found", "no such share on this check's split");
  if (share.state !== "open")
    throw new ApiError(
      "in_progress",
      share.state === "paid" ? "this share is paid" : "this share is being paid",
    );
  if (amountCents !== share.amount_cents)
    throw new ApiError("invalid_request", "a share pays its own amount", {
      details: { amount_cents: share.amount_cents },
    });
  const hold = await tabHoldOf(c, venueId, checkId);
  if (hold) {
    const others = await c.query(
      "select 1 from split_shares where venue_id = $1 and split_id = $2 and id <> $3 and state = 'open'",
      [venueId, share.split_id, shareId],
    );
    if (!others.rowCount)
      throw new ApiError("invalid_request", "the last share goes on the held card", {
        details: { reason: "held_card_last" },
      });
  }
  await setShareState(c, venueId, shareId, state);
  return { leaveOut: hold?.paymentId ?? null };
}

/** After a payment moves: its shares are paid, or open again when it's canceled or failed. */
export async function settleShares(
  c: Queryable,
  venueId: string,
  paymentId: string,
  status: string,
): Promise<void> {
  const shares = await sharesOfPayment(c, venueId, paymentId);
  for (const id of shares) {
    if (status === "captured") await setShareState(c, venueId, id, "paid");
    else if (status === "canceled" || status === "failed")
      await c.query(
        "update split_shares set state = 'open' where venue_id = $1 and id = $2 and state = 'paying'",
        [venueId, id],
      );
  }
}
