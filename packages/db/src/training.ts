import type { Queryable } from "./tenancy.js";

/**
 * Training mode (M7-03; Security and data retention 15): a request is
 * practice when the person signed in (memberships.training) or the device it
 * comes from (devices.training) is in training. Asked once per request.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function trainingOf(
  c: Queryable,
  venueId: string,
  who: { membershipId?: string | null; deviceIds?: readonly (string | null | undefined)[] },
): Promise<boolean> {
  // Only real ids are asked about (a test's principal may carry a made-up one).
  const isId = (x: unknown): x is string => typeof x === "string" && UUID.test(x);
  const devices = (who.deviceIds ?? []).filter(isId);
  const membershipId = isId(who.membershipId) ? who.membershipId : null;
  if (!membershipId && devices.length === 0) return false;
  const r = await c.query<{ training: boolean }>(
    `select exists (select 1 from memberships where venue_id = $1 and id = $2 and training)
         or exists (select 1 from devices where venue_id = $1 and id = any($3::uuid[]) and training)
         as training`,
    [venueId, membershipId, devices],
  );
  return r.rows[0]?.training ?? false;
}
