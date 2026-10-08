import type { Queryable } from "./tenancy.js";

/**
 * ID checks (M2-12; spec 04 · id_checks; spec 12 · 6). Inside a venue
 * transaction. A scan's fields are sealed with the venue's key for the
 * business date: a random data key per night, held in the key store outside
 * the database (M8-14: `key_ref` names it, so no database backup carries
 * it). The API makes and reads the key between transactions; destroying it
 * after `idScan.keepDays` makes that night's scans unreadable everywhere.
 * `wrapped_key` is only for keys made before M8-14, sealed by the server key.
 */
export interface NightKeyRow {
  readonly id: string;
  readonly key_ref: string | null;
  readonly wrapped_key: string | null;
  readonly destroyed_at: string | null;
}

export async function nightKeyRow(
  c: Queryable,
  venueId: string,
  businessDate: string,
): Promise<NightKeyRow | null> {
  const r = await c.query<NightKeyRow>(
    `select id, key_ref, wrapped_key, destroyed_at::text from id_scan_keys
      where venue_id = $1 and business_date = $2`,
    [venueId, businessDate],
  );
  return r.rows[0] ?? null;
}

/** The key row an id_checks row was sealed with. */
export async function scanKeyRow(
  c: Queryable,
  venueId: string,
  idCheckId: string,
): Promise<(NightKeyRow & { scanned_fields: string }) | null> {
  const r = await c.query<NightKeyRow & { scanned_fields: string }>(
    `select k.id, k.key_ref, k.wrapped_key, k.destroyed_at::text, i.scanned_fields
       from id_checks i join id_scan_keys k on k.venue_id = i.venue_id and k.id = i.key_id
      where i.venue_id = $1 and i.id = $2 and i.method = 'scan'`,
    [venueId, idCheckId],
  );
  return r.rows[0] ?? null;
}

/**
 * Name the night's key, once: the first scan of the night stores its key in
 * the key store, then claims the night here. A concurrent first scan that
 * lost the claim gets the winner's row back (and drops its own key).
 */
export async function claimNightKey(
  c: Queryable,
  venueId: string,
  businessDate: string,
  keyRef: string,
): Promise<NightKeyRow> {
  await c.query(
    `insert into id_scan_keys (venue_id, business_date, key_ref) values ($1, $2, $3)
       on conflict (venue_id, business_date) do nothing`,
    [venueId, businessDate, keyRef],
  );
  return (await nightKeyRow(c, venueId, businessDate))!;
}

/**
 * Nights whose key is due to be destroyed on `today` (the venue's local
 * date): every scan sealed with it is past its own delete_after (the night
 * plus the rule pack's `idScan.keepDays`, set when it was taken). A key no
 * scan used (a lost first-scan race) goes `orphanDays` after the night.
 */
export async function dueNightKeys(
  c: Queryable,
  venueId: string,
  today: string,
  orphanDays: number,
): Promise<{ id: string; business_date: string; key_ref: string | null }[]> {
  const r = await c.query<{ id: string; business_date: string; key_ref: string | null }>(
    `select k.id, k.business_date::text, k.key_ref from id_scan_keys k
      where k.venue_id = $1 and k.destroyed_at is null
        and case when exists (select 1 from id_checks i where i.venue_id = k.venue_id and i.key_id = k.id)
                 then not exists (select 1 from id_checks i
                                   where i.venue_id = k.venue_id and i.key_id = k.id and i.delete_after > $2::date)
                 else k.business_date + $3::int <= $2::date end
      order by k.business_date`,
    [venueId, today, orphanDays],
  );
  return r.rows;
}

/** After the key store destroyed it: the row keeps the night and when, never a key. */
export async function markNightKeyDestroyed(
  c: Queryable,
  venueId: string,
  keyId: string,
  at: string,
): Promise<void> {
  await c.query(
    `update id_scan_keys set wrapped_key = null, destroyed_at = $3
      where venue_id = $1 and id = $2 and destroyed_at is null`,
    [venueId, keyId, at],
  );
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
    /** The four fields, already sealed with the night's key (outside the transaction). */
    sealed: string;
    keyId: string;
    checkedBy: string;
    at: string;
    businessDate: string;
    keepDays: number;
  },
): Promise<{ id: string; deleteAfter: string }> {
  const r = await c.query<{ id: string; delete_after: string }>(
    `insert into id_checks (venue_id, session_id, checked_by, checked_at, method, scanned_fields, key_id, delete_after)
       values ($1, $2, $3, $4, 'scan', $5, $6, $7::date + $8::int) returning id, delete_after::text`,
    [
      venueId,
      input.sessionId,
      input.checkedBy,
      input.at,
      input.sealed,
      input.keyId,
      input.businessDate,
      input.keepDays,
    ],
  );
  return { id: r.rows[0]!.id, deleteAfter: r.rows[0]!.delete_after };
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
