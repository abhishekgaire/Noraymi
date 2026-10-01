import type { Queryable } from "./tenancy.js";

/**
 * Unsent drinks (M3-07; spec 10 rule 8): one draft per person per tab, or
 * the quick sale (check null). A save carries the version it read; a stale
 * one changes nothing. Inside a venue transaction.
 */
export interface DraftRow {
  readonly lines: unknown[];
  readonly version: number;
  readonly updated_at: string;
}

export async function draftFor(
  c: Queryable,
  venueId: string,
  membershipId: string,
  checkId: string | null,
): Promise<DraftRow | null> {
  const r = await c.query<DraftRow>(
    `select lines, version, to_json(updated_at) #>> '{}' as updated_at from order_drafts
      where venue_id = $1 and membership_id = $2 and check_id is not distinct from $3`,
    [venueId, membershipId, checkId],
  );
  return r.rows[0] ?? null;
}

/** Saves a draft read at `version` (0: none yet). Returns the new version, or null when someone saved first. */
export async function saveDraft(
  c: Queryable,
  venueId: string,
  d: {
    membershipId: string;
    checkId: string | null;
    deviceId: string | null;
    lines: unknown[];
    version: number;
    at: string;
  },
): Promise<number | null> {
  const r =
    d.version === 0
      ? await c.query<{ version: number }>(
          `insert into order_drafts (venue_id, membership_id, check_id, device_id, lines, version, updated_at)
           values ($1, $2, $3, $4, $5, 1, $6)
           on conflict (venue_id, membership_id, check_id) do nothing returning version`,
          [venueId, d.membershipId, d.checkId, d.deviceId, JSON.stringify(d.lines), d.at],
        )
      : await c.query<{ version: number }>(
          `update order_drafts set lines = $5, device_id = $4, version = version + 1, updated_at = $7
            where venue_id = $1 and membership_id = $2 and check_id is not distinct from $3 and version = $6
            returning version`,
          [
            venueId,
            d.membershipId,
            d.checkId,
            d.deviceId,
            JSON.stringify(d.lines),
            d.version,
            d.at,
          ],
        );
  return r.rows[0]?.version ?? null;
}

/** Empties a person's draft for a tab once it's sent. Returns the new version, or null when there was none. */
export async function clearDraft(
  c: Queryable,
  venueId: string,
  membershipId: string,
  checkId: string | null,
  at: string,
): Promise<number | null> {
  const r = await c.query<{ version: number }>(
    `update order_drafts set lines = '[]', version = version + 1, updated_at = $4
      where venue_id = $1 and membership_id = $2 and check_id is not distinct from $3 returning version`,
    [venueId, membershipId, checkId, at],
  );
  return r.rows[0]?.version ?? null;
}
