import { createHash } from "node:crypto";
import type { Queryable } from "./tenancy.js";

/** The current key version new badges are paired under. A rotation bumps it; old badges keep theirs. */
export const BADGE_KEY_VERSION = 1;

/** The tag's UID, hashed with the venue so a UID read elsewhere can't be matched to a person. */
export function badgeUidHash(venueId: string, uid: Buffer): string {
  return createHash("sha256").update(`${venueId}‖`).update(uid).digest("hex");
}

export interface BadgeRow {
  readonly id: string;
  readonly membershipId: string;
  readonly keyVersion: number;
  readonly lastCounter: number;
  readonly label: string;
  readonly pairedAt: string;
  readonly lastTapAt: string | null;
  readonly disabledAt: string | null;
}

const COLS =
  "id, membership_id, key_version, last_counter, label, paired_at::text, last_tap_at::text, disabled_at::text";

const toRow = (r: {
  id: string;
  membership_id: string;
  key_version: number;
  last_counter: number;
  label: string;
  paired_at: string;
  last_tap_at: string | null;
  disabled_at: string | null;
}): BadgeRow => ({
  id: r.id,
  membershipId: r.membership_id,
  keyVersion: r.key_version,
  lastCounter: r.last_counter,
  label: r.label,
  pairedAt: r.paired_at,
  lastTapAt: r.last_tap_at,
  disabledAt: r.disabled_at,
});

type Raw = Parameters<typeof toRow>[0];

/** The key versions in use at the venue, newest first: which meta-read keys a tap might be under. */
export async function badgeKeyVersions(client: Queryable, venueId: string): Promise<number[]> {
  const r = await client.query<{ key_version: number }>(
    "select distinct key_version from staff_badges where venue_id = $1 and disabled_at is null order by key_version desc",
    [venueId],
  );
  return r.rows.map((row) => row.key_version);
}

export async function badgeByUid(
  client: Queryable,
  venueId: string,
  uid: Buffer,
): Promise<BadgeRow | null> {
  const r = await client.query<Raw>(
    `select ${COLS} from staff_badges where venue_id = $1 and uid_hash = $2`,
    [venueId, badgeUidHash(venueId, uid)],
  );
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** Pair a tag to a person. A tag already paired and live at the venue is refused (null). */
export async function pairBadge(
  client: Queryable,
  args: {
    readonly venueId: string;
    readonly membershipId: string;
    readonly uid: Buffer;
    readonly counter: number;
    readonly label: string;
    readonly pairedBy: string | null;
    readonly keyVersion?: number;
  },
): Promise<BadgeRow | null> {
  const r = await client.query<Raw>(
    `insert into staff_badges (venue_id, membership_id, uid_hash, key_version, last_counter, label, paired_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (venue_id, uid_hash) do update
       set membership_id = excluded.membership_id, key_version = excluded.key_version,
           last_counter = excluded.last_counter, label = excluded.label, paired_by = excluded.paired_by,
           paired_at = now(), last_tap_at = null, disabled_at = null
       where staff_badges.disabled_at is not null
     returning ${COLS}`,
    [
      args.venueId,
      args.membershipId,
      badgeUidHash(args.venueId, args.uid),
      args.keyVersion ?? BADGE_KEY_VERSION,
      args.counter,
      args.label,
      args.pairedBy,
    ],
  );
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

/** A tap counted: the counter only ever goes up. Returns false when it didn't (a replay or an older read). */
export async function recordBadgeTap(
  client: Queryable,
  venueId: string,
  badgeId: string,
  counter: number,
  at: string,
): Promise<boolean> {
  const r = await client.query(
    `update staff_badges set last_counter = $3, last_tap_at = $4
     where venue_id = $1 and id = $2 and disabled_at is null and last_counter < $3`,
    [venueId, badgeId, counter, at],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function disableBadge(
  client: Queryable,
  venueId: string,
  badgeId: string,
): Promise<boolean> {
  const r = await client.query(
    "update staff_badges set disabled_at = coalesce(disabled_at, now()) where venue_id = $1 and id = $2",
    [venueId, badgeId],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Every badge of a membership (Admin → Team), live and disabled. */
export async function badgesOf(
  client: Queryable,
  venueId: string,
  membershipId: string,
): Promise<BadgeRow[]> {
  const r = await client.query<Raw>(
    `select ${COLS} from staff_badges where venue_id = $1 and membership_id = $2 order by paired_at`,
    [venueId, membershipId],
  );
  return r.rows.map(toRow);
}

/** Deactivating a person switches off their badges with everything else (spec 02 · Offboarding, M1-27). */
export async function disableBadgesOf(
  client: Queryable,
  venueId: string,
  membershipId: string,
): Promise<number> {
  const r = await client.query(
    "update staff_badges set disabled_at = coalesce(disabled_at, now()) where venue_id = $1 and membership_id = $2",
    [venueId, membershipId],
  );
  return r.rowCount ?? 0;
}
