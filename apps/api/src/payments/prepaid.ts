import { allocate, insertPayment, type Queryable } from "@west4/db";
import { ApiError } from "../http/errors.js";

/**
 * The prepaid-value ledger (M4-28; Money rules 11, 12 and 16; D83). Service
 * functions only: no route and no screen yet (gift cards are phase 2, stored
 * value phase 3, and M6's song credit uses them). A balance is always the sum
 * of the account's ledger rows; every move locks the account first, so no two
 * moves can take it below zero.
 */
export type PrepaidKind = "gift_card" | "stored_value" | "prepaid_hours" | "song_credit";

/** Where M7's nightly journal posts each ledger kind: all of them move the prepaid-value liability. */
export const PREPAID_JOURNAL_ACCOUNT = {
  issued: "prepaid_value",
  redeemed: "prepaid_value",
  expired: "prepaid_value",
  refunded: "prepaid_value",
} as const;

async function locked(c: Queryable, venueId: string, accountId: string) {
  const a = (
    await c.query<{ status: string }>(
      "select status from prepaid_accounts where venue_id = $1 and id = $2 for update",
      [venueId, accountId],
    )
  ).rows[0];
  if (!a) throw new ApiError("not_found", "no such prepaid account");
  return a;
}

export async function prepaidBalance(c: Queryable, venueId: string, accountId: string) {
  const r = await c.query<{ b: string }>(
    "select coalesce(sum(amount_cents), 0) as b from prepaid_ledger where venue_id = $1 and account_id = $2",
    [venueId, accountId],
  );
  return Number(r.rows[0]!.b);
}

async function post(
  c: Queryable,
  venueId: string,
  row: {
    accountId: string;
    kind: "issued" | "redeemed" | "expired" | "refunded";
    amountCents: number;
    paymentId?: string | null;
    checkId?: string | null;
    by: string | null;
    at: string;
    businessDate: string;
  },
) {
  await c.query(
    `insert into prepaid_ledger (venue_id, account_id, kind, amount_cents, payment_id, check_id, by_user, at, business_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      venueId,
      row.accountId,
      row.kind,
      row.amountCents,
      row.paymentId ?? null,
      row.checkId ?? null,
      row.by,
      row.at,
      row.businessDate,
    ],
  );
}

/** Issue: money paid in (by `paymentId`) becomes a balance, a liability until it's used. */
export async function issuePrepaid(
  c: Queryable,
  venueId: string,
  input: {
    kind: PrepaidKind;
    amountCents: number;
    paymentId: string | null;
    guestId?: string | null;
    singerId?: string | null;
    codeHash?: string | null;
    expiresOn?: string | null;
    by: string | null;
    at: string;
    businessDate: string;
  },
): Promise<string> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    throw new ApiError("invalid_request", "issue a positive amount");
  const id = (
    await c.query<{ id: string }>(
      `insert into prepaid_accounts (venue_id, kind, code_hash, guest_id, singer_id, issued_at, expires_on)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        venueId,
        input.kind,
        input.codeHash ?? null,
        input.guestId ?? null,
        input.singerId ?? null,
        input.at,
        input.expiresOn ?? null,
      ],
    )
  ).rows[0]!.id;
  await post(c, venueId, {
    accountId: id,
    kind: "issued",
    amountCents: input.amountCents,
    paymentId: input.paymentId,
    by: input.by,
    at: input.at,
    businessDate: input.businessDate,
  });
  return id;
}

/** Redeem onto a check: a `prepaid` payment and its allocation, never more than the balance. */
export async function redeemPrepaid(
  c: Queryable,
  venueId: string,
  input: {
    accountId: string;
    checkId: string;
    amountCents: number;
    by: string | null;
    at: string;
    businessDate: string;
  },
): Promise<string> {
  const a = await locked(c, venueId, input.accountId);
  if (a.status !== "active") throw new ApiError("invalid_request", "this account is closed");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    throw new ApiError("invalid_request", "redeem a positive amount");
  const balance = await prepaidBalance(c, venueId, input.accountId);
  if (input.amountCents > balance)
    throw new ApiError("invalid_request", "more than the balance", {
      details: { balance_cents: balance },
    });
  const paymentId = await insertPayment(c, venueId, {
    method: "prepaid",
    status: "captured",
    businessDate: input.businessDate,
    amountCents: input.amountCents,
  });
  await allocate(c, venueId, {
    paymentId,
    checkId: input.checkId,
    amountCents: input.amountCents,
    state: "captured",
  });
  await post(c, venueId, {
    accountId: input.accountId,
    kind: "redeemed",
    amountCents: -input.amountCents,
    paymentId,
    checkId: input.checkId,
    by: input.by,
    at: input.at,
    businessDate: input.businessDate,
  });
  return paymentId;
}

/**
 * Value spent with no check to pay (M6-19): a singer with no tab starting a song on prepaid song credit.
 * The ledger takes the value out as redeemed (the sale M7's journal records), with no payment and no check.
 */
export async function spendPrepaid(
  c: Queryable,
  venueId: string,
  input: {
    accountId: string;
    amountCents: number;
    by: string | null;
    at: string;
    businessDate: string;
  },
): Promise<void> {
  const a = await locked(c, venueId, input.accountId);
  if (a.status !== "active") throw new ApiError("invalid_request", "this account is closed");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    throw new ApiError("invalid_request", "redeem a positive amount");
  const balance = await prepaidBalance(c, venueId, input.accountId);
  if (input.amountCents > balance)
    throw new ApiError("invalid_request", "more than the balance", {
      details: { balance_cents: balance },
    });
  await post(c, venueId, {
    accountId: input.accountId,
    kind: "redeemed",
    amountCents: -input.amountCents,
    by: input.by,
    at: input.at,
    businessDate: input.businessDate,
  });
}

/** Expire what's left (or part of it), as the venue's terms allow. */
export async function expirePrepaid(
  c: Queryable,
  venueId: string,
  input: {
    accountId: string;
    amountCents?: number;
    by: string | null;
    at: string;
    businessDate: string;
  },
): Promise<number> {
  await locked(c, venueId, input.accountId);
  const balance = await prepaidBalance(c, venueId, input.accountId);
  const amount = Math.min(balance, input.amountCents ?? balance);
  if (amount <= 0) return 0;
  await post(c, venueId, {
    accountId: input.accountId,
    kind: "expired",
    amountCents: -amount,
    by: input.by,
    at: input.at,
    businessDate: input.businessDate,
  });
  return amount;
}

/**
 * Refund: the balance comes off the ledger and the answer names the payment that bought it, for the
 * refund engine to give back to that card when gift cards ship (phase 2); never more than the balance.
 */
export async function refundPrepaid(
  c: Queryable,
  venueId: string,
  input: {
    accountId: string;
    amountCents: number;
    by: string | null;
    at: string;
    businessDate: string;
  },
): Promise<{ paymentId: string | null; amountCents: number }> {
  await locked(c, venueId, input.accountId);
  const balance = await prepaidBalance(c, venueId, input.accountId);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > balance)
    throw new ApiError("invalid_request", "more than the balance", {
      details: { balance_cents: balance },
    });
  const bought = (
    await c.query<{ payment_id: string | null }>(
      "select payment_id from prepaid_ledger where venue_id = $1 and account_id = $2 and kind = 'issued' order by at limit 1",
      [venueId, input.accountId],
    )
  ).rows[0];
  await post(c, venueId, {
    accountId: input.accountId,
    kind: "refunded",
    amountCents: -input.amountCents,
    paymentId: bought?.payment_id ?? null,
    by: input.by,
    at: input.at,
    businessDate: input.businessDate,
  });
  return { paymentId: bought?.payment_id ?? null, amountCents: input.amountCents };
}
