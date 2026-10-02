import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "./tenancy.js";

/** Pay links (M4-15; Security 9): a 128-bit token, stored hashed, naming one payment. */
export const payTokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export interface PayLinkRow {
  readonly id: string;
  readonly check_id: string | null;
  readonly booking_id: string | null;
  readonly amount_cents: number;
  readonly payment_id: string | null;
  readonly purpose: string;
  readonly expires_at: string;
  readonly used_at: string | null;
}

export async function createPayLink(
  c: Queryable,
  venueId: string,
  input: {
    checkId?: string | null;
    bookingId?: string | null;
    amountCents: number;
    expiresAt: string;
    createdBy?: string | null;
    purpose?: "balance" | "deposit" | "link";
  },
): Promise<{ id: string; token: string }> {
  const token = randomBytes(16).toString("base64url");
  const r = await c.query<{ id: string }>(
    `insert into pay_links (venue_id, token_hash, check_id, booking_id, amount_cents, expires_at, created_by, purpose)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      venueId,
      payTokenHash(token),
      input.checkId ?? null,
      input.bookingId ?? null,
      input.amountCents,
      input.expiresAt,
      input.createdBy ?? null,
      input.purpose ?? "balance",
    ],
  );
  return { id: r.rows[0]!.id, token };
}

/** The venue behind a token's hash, without a venue set (the definer function). */
export async function venueForPayToken(c: Queryable, tokenHash: string): Promise<string | null> {
  const r = await c.query<{ venue: string | null }>("select resolve_pay_link($1) as venue", [
    tokenHash,
  ]);
  return r.rows[0]?.venue ?? null;
}

export async function payLinkByHash(
  c: Queryable,
  venueId: string,
  tokenHash: string,
  lock = false,
): Promise<PayLinkRow | null> {
  const r = await c.query<PayLinkRow>(
    `select id, check_id, booking_id, amount_cents::int, payment_id, purpose,
            to_json(expires_at) #>> '{}' as expires_at, to_json(used_at) #>> '{}' as used_at
       from pay_links where venue_id = $1 and token_hash = $2${lock ? " for update" : ""}`,
    [venueId, tokenHash],
  );
  return r.rows[0] ?? null;
}

export async function setPayLinkPayment(
  c: Queryable,
  venueId: string,
  linkId: string,
  paymentId: string,
): Promise<void> {
  await c.query("update pay_links set payment_id = $3 where venue_id = $1 and id = $2", [
    venueId,
    linkId,
    paymentId,
  ]);
}
