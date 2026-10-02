import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "./auth.js";
import type { Queryable } from "./tenancy.js";

/**
 * ID checks (M2-12; spec 04 · id_checks; spec 12 · 6). Inside a venue
 * transaction. A scan's fields are sealed with the venue's key for the
 * business date: a random data key per night, wrapped by the server's key
 * (the key service in staging and production), so destroying the night's
 * wrapped key after 7 days (M8) makes its scans unreadable.
 */
export async function nightKey(
  c: Queryable,
  venueId: string,
  businessDate: string,
  wrappingKey: Buffer,
): Promise<{ id: string; key: Buffer }> {
  const existing = await c.query<{ id: string; wrapped_key: string | null }>(
    "select id, wrapped_key from id_scan_keys where venue_id = $1 and business_date = $2",
    [venueId, businessDate],
  );
  const row = existing.rows[0];
  if (row) {
    if (!row.wrapped_key) throw new Error("that night's ID key has been destroyed");
    return { id: row.id, key: Buffer.from(decryptSecret(wrappingKey, row.wrapped_key), "base64") };
  }
  const key = randomBytes(32);
  const r = await c.query<{ id: string }>(
    `insert into id_scan_keys (venue_id, business_date, wrapped_key) values ($1, $2, $3)
       on conflict (venue_id, business_date) do nothing returning id`,
    [venueId, businessDate, encryptSecret(wrappingKey, key.toString("base64"))],
  );
  if (!r.rows[0]) return nightKey(c, venueId, businessDate, wrappingKey); // a concurrent first scan made it
  return { id: r.rows[0].id, key };
}

export async function addVisualChecks(
  c: Queryable,
  venueId: string,
  input: {
    sessionId: string;
    count: number;
    checkedBy: string;
    at: string;
    /** The order a runner checked an ID for, at the room (M3-18). */
    orderId?: string | null;
  },
): Promise<void> {
  for (let i = 0; i < input.count; i++)
    await c.query(
      `insert into id_checks (venue_id, session_id, checked_by, checked_at, method, order_id) values ($1, $2, $3, $4, 'visual', $5)`,
      [venueId, input.sessionId, input.checkedBy, input.at, input.orderId ?? null],
    );
}

export async function addScanCheck(
  c: Queryable,
  venueId: string,
  input: {
    sessionId: string;
    fields: Readonly<Record<string, string>>;
    checkedBy: string;
    at: string;
    businessDate: string;
    keepDays: number;
    wrappingKey: Buffer;
  },
): Promise<{ id: string; keyId: string; deleteAfter: string }> {
  const key = await nightKey(c, venueId, input.businessDate, input.wrappingKey);
  const sealed = encryptSecret(key.key, JSON.stringify(input.fields));
  const r = await c.query<{ id: string; delete_after: string }>(
    `insert into id_checks (venue_id, session_id, checked_by, checked_at, method, scanned_fields, key_id, delete_after)
       values ($1, $2, $3, $4, 'scan', $5, $6, $7::date + $8::int) returning id, delete_after::text`,
    [
      venueId,
      input.sessionId,
      input.checkedBy,
      input.at,
      sealed,
      key.id,
      input.businessDate,
      input.keepDays,
    ],
  );
  return { id: r.rows[0]!.id, keyId: key.id, deleteAfter: r.rows[0]!.delete_after };
}

/** How many IDs each session has checked: the "ID ✓ x of n" chip. */
export async function idCounts(
  c: Queryable,
  venueId: string,
  sessionIds: readonly string[],
): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const r = await c.query<{ session_id: string; n: number }>(
    `select session_id, count(*)::int as n from id_checks where venue_id = $1 and session_id = any($2::uuid[]) group by session_id`,
    [venueId, sessionIds],
  );
  return new Map(r.rows.map((x) => [x.session_id, x.n]));
}
