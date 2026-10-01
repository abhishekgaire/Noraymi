import type { Queryable } from "./tenancy.js";

/** The walk-in waitlist (M2-25; spec 04 · waitlist_entries). */
export type WaitlistStatus = "waiting" | "offered" | "seated" | "declined" | "expired" | "left";

export interface WaitlistRow {
  readonly id: string;
  readonly guest_id: string;
  readonly name: string;
  readonly phone_e164: string | null;
  readonly party_size: number;
  readonly size_tier_needed: string;
  readonly joined_at: string;
  readonly quoted_min: number | null;
  readonly status: WaitlistStatus;
  readonly offered_room_id: string | null;
  readonly offered_room_name: string | null;
  readonly offer_expires_at: string | null;
  readonly source: "staff" | "door";
  /** Parties ahead in the live list (waiting or offered, joined earlier). */
  readonly ahead: number;
}

const ROW = `select w.id, w.guest_id, g.name, g.phone_e164, w.party_size, w.size_tier_needed,
    to_json(w.joined_at) #>> '{}' as joined_at, w.quoted_min, w.status, w.offered_room_id, r.name as offered_room_name,
    to_json(w.offer_expires_at) #>> '{}' as offer_expires_at, w.source,
    (select count(*)::int from waitlist_entries x
      where x.venue_id = w.venue_id and x.status in ('waiting', 'offered')
        and (x.joined_at, x.id) < (w.joined_at, w.id)) as ahead
  from waitlist_entries w
  join guests g on g.venue_id = w.venue_id and g.id = w.guest_id
  left join rooms r on r.venue_id = w.venue_id and r.id = w.offered_room_id`;

export async function resolveVenueSlug(c: Queryable, slug: string): Promise<string | null> {
  const r = await c.query<{ id: string | null }>("select resolve_venue_slug($1) as id", [slug]);
  return r.rows[0]?.id ?? null;
}

export async function resolveWaitlistToken(
  c: Queryable,
  tokenHash: string,
  now: string,
): Promise<{ venueId: string; entryId: string } | null> {
  const r = await c.query<{ venue_id: string; entry_id: string }>(
    "select venue_id, entry_id from resolve_waitlist_token($1, $2)",
    [tokenHash, now],
  );
  const row = r.rows[0];
  return row ? { venueId: row.venue_id, entryId: row.entry_id } : null;
}

export async function insertWaitlistEntry(
  c: Queryable,
  venueId: string,
  input: {
    guestId: string;
    partySize: number;
    sizeTierNeeded: string;
    joinedAt: string;
    quotedMin: number | null;
    source: "staff" | "door";
    linkTokenHash: string | null;
    linkExpiresAt: string | null;
    id?: string;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into waitlist_entries (id, venue_id, guest_id, party_size, size_tier_needed, joined_at, quoted_min, source,
                                   link_token_hash, link_expires_at)
       values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [
      input.id ?? null,
      venueId,
      input.guestId,
      input.partySize,
      input.sizeTierNeeded,
      input.joinedAt,
      input.quotedMin,
      input.source,
      input.linkTokenHash,
      input.linkExpiresAt,
    ],
  );
  return r.rows[0]!.id;
}

/** The live list (waiting and offered), first in line first. */
export async function liveWaitlist(c: Queryable, venueId: string): Promise<WaitlistRow[]> {
  const r = await c.query<WaitlistRow>(
    `${ROW} where w.venue_id = $1 and w.status in ('waiting', 'offered') order by w.joined_at, w.id`,
    [venueId],
  );
  return r.rows;
}

export async function waitlistEntry(
  c: Queryable,
  venueId: string,
  id: string,
): Promise<WaitlistRow | null> {
  const r = await c.query<WaitlistRow>(`${ROW} where w.venue_id = $1 and w.id = $2`, [venueId, id]);
  return r.rows[0] ?? null;
}

/** Ends an entry (left, declined, expired, seated); only a live one moves. */
export async function endWaitlistEntry(
  c: Queryable,
  venueId: string,
  id: string,
  status: Exclude<WaitlistStatus, "waiting" | "offered">,
  at: string,
): Promise<boolean> {
  const r = await c.query(
    `update waitlist_entries set status = $3, ended_at = $4, offered_room_id = null, offer_expires_at = null
      where venue_id = $1 and id = $2 and status in ('waiting', 'offered')`,
    [venueId, id, status, at],
  );
  return r.rowCount === 1;
}

export async function setWaitlistQuote(
  c: Queryable,
  venueId: string,
  id: string,
  quotedMin: number | null,
): Promise<boolean> {
  const r = await c.query(
    "update waitlist_entries set quoted_min = $3 where venue_id = $1 and id = $2 and status in ('waiting', 'offered')",
    [venueId, id, quotedMin],
  );
  return r.rowCount === 1;
}
