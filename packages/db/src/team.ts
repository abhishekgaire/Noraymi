import { disableBadgesOf } from "./badges.js";
import type { Queryable } from "./tenancy.js";

/**
 * Offboarding (spec 02 · Offboarding, M1-27): one transaction sets the
 * membership deactivated, switches off its badges, revokes the person's
 * phones with their keys and push subscriptions, and ends their sessions.
 * Every record they made stays and still names them. There is no
 * reactivation step: the spec has none.
 */
export interface Offboarded {
  readonly userId: string;
  readonly badgesDisabled: number;
  readonly phonesRevoked: readonly string[];
  readonly sessionsEnded: number;
}

export async function offboardMembership(
  client: Queryable,
  args: { readonly venueId: string; readonly membershipId: string; readonly at: string },
): Promise<Offboarded | null> {
  const m = await client.query<{ user_id: string }>(
    `update memberships set status = 'deactivated', deactivated_at = $3
     where venue_id = $1 and id = $2 and status <> 'deactivated' returning user_id`,
    [args.venueId, args.membershipId, args.at],
  );
  const row = m.rows[0];
  if (!row) return null;
  const badgesDisabled = await disableBadgesOf(client, args.venueId, args.membershipId);
  const phones = await client.query<{ id: string }>(
    `update devices set revoked_at = coalesce(revoked_at, $3)
     where venue_id = $1 and user_id = $2 and kind = 'staff_phone' and revoked_at is null returning id`,
    [args.venueId, row.user_id, args.at],
  );
  const phoneIds = phones.rows.map((p) => p.id);
  if (phoneIds.length > 0) {
    await client.query(
      "update push_subscriptions set revoked_at = coalesce(revoked_at, $2) where venue_id = $1 and device_id = any($3)",
      [args.venueId, args.at, phoneIds],
    );
  }
  // Their sessions here (PIN and badge ones name the membership); their passkey sessions too,
  // unless they still work somewhere else, since those span venues.
  const sessions = await client.query(
    `update auth_sessions set ended_at = $3, end_reason = 'revoked'
     where ended_at is null and user_id = $1
       and (membership_id = $2
            or (membership_id is null and not exists (
                  select 1 from memberships o where o.user_id = $1 and o.status = 'active' and o.id <> $2)))`,
    [row.user_id, args.membershipId, args.at],
  );
  return {
    userId: row.user_id,
    badgesDisabled,
    phonesRevoked: phoneIds,
    sessionsEnded: sessions.rowCount ?? 0,
  };
}
