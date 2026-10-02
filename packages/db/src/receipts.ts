import type { Queryable } from "./tenancy.js";

/** Receipts (M4-19): a row per print, text, email or web link, with its link token's hash. */
export interface ReceiptRow {
  readonly id: string;
  readonly check_id: string;
  readonly payment_id: string | null;
  readonly channel: "print" | "text" | "email" | "web";
  readonly sent_at: string;
  readonly expires_at: string;
}

const COLS = `id, check_id, payment_id, channel, to_json(sent_at) #>> '{}' as sent_at,
  to_json(expires_at) #>> '{}' as expires_at`;

export async function insertReceipt(
  c: Queryable,
  venueId: string,
  r: {
    id: string;
    checkId: string;
    paymentId: string | null;
    tokenHash: string;
    channel: ReceiptRow["channel"];
    sentAt: string;
    expiresAt: string;
    sentBy: string | null;
  },
): Promise<void> {
  await c.query(
    `insert into receipts (id, venue_id, check_id, payment_id, token_hash, channel, sent_at, expires_at, sent_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict do nothing`,
    [
      r.id,
      venueId,
      r.checkId,
      r.paymentId,
      r.tokenHash,
      r.channel,
      r.sentAt,
      r.expiresAt,
      r.sentBy,
    ],
  );
}

/** The check's web receipt, the one link its guests' phones show once it's paid. */
export async function webReceiptOf(
  c: Queryable,
  venueId: string,
  checkId: string,
): Promise<ReceiptRow | null> {
  const r = await c.query<ReceiptRow>(
    `select ${COLS} from receipts where venue_id = $1 and check_id = $2 and channel = 'web'`,
    [venueId, checkId],
  );
  return r.rows[0] ?? null;
}

export async function receiptByHash(
  c: Queryable,
  venueId: string,
  tokenHash: string,
): Promise<ReceiptRow | null> {
  const r = await c.query<ReceiptRow>(
    `select ${COLS} from receipts where venue_id = $1 and token_hash = $2`,
    [venueId, tokenHash],
  );
  return r.rows[0] ?? null;
}

/** The venue behind a receipt link's token hash, without a venue set (the definer function). */
export async function venueForReceiptToken(
  c: Queryable,
  tokenHash: string,
): Promise<string | null> {
  const r = await c.query<{ venue: string | null }>("select resolve_receipt($1) as venue", [
    tokenHash,
  ]);
  return r.rows[0]?.venue ?? null;
}
