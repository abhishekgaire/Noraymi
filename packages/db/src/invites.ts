import type { Queryable } from "./tenancy.js";

/**
 * Invites and phone codes (M1-23, spec 02 · PINs). An invite is one link to
 * one membership, kept as a hash; a phone code confirms the person's number
 * once. Both live in the venue, and the token lookup before any venue is set
 * goes through a definer function.
 */
export interface InviteByToken {
  readonly inviteId: string;
  readonly venueId: string;
  readonly venueName: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: "owner" | "manager" | "bartender" | "front_desk" | "staff";
  readonly pinDigits: 4 | 6;
  readonly locale: "en" | "es";
  readonly phoneVerified: boolean;
  readonly expiresAt: string;
  readonly usedAt: string | null;
}

export async function inviteByToken(
  client: Queryable,
  tokenHash: string,
): Promise<InviteByToken | null> {
  const r = await client.query<{
    invite_id: string;
    venue_id: string;
    venue_name: string;
    membership_id: string;
    user_id: string;
    name: string;
    email: string | null;
    role: InviteByToken["role"];
    pin_digits: 4 | 6;
    locale: "en" | "es";
    phone_verified: boolean;
    expires_at: Date;
    used_at: Date | null;
  }>("select * from auth_invite_by_token($1)", [tokenHash]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    inviteId: row.invite_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    membershipId: row.membership_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    pinDigits: row.pin_digits,
    locale: row.locale,
    phoneVerified: row.phone_verified,
    expiresAt: row.expires_at.toISOString(),
    usedAt: row.used_at ? row.used_at.toISOString() : null,
  };
}

/** A new invite for a membership. Earlier open invites for it stop working at once. */
export async function createInvite(
  client: Queryable,
  args: {
    readonly venueId: string;
    readonly membershipId: string;
    readonly tokenHash: string;
    readonly createdBy: string | null;
    readonly expiresAt: string;
  },
): Promise<string> {
  await client.query(
    "update invites set used_at = now() where venue_id = $1 and membership_id = $2 and used_at is null",
    [args.venueId, args.membershipId],
  );
  const r = await client.query<{ id: string }>(
    `insert into invites (venue_id, membership_id, token_hash, created_by, expires_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [args.venueId, args.membershipId, args.tokenHash, args.createdBy, args.expiresAt],
  );
  return r.rows[0]!.id;
}

export async function markInviteUsed(
  client: Queryable,
  venueId: string,
  inviteId: string,
): Promise<void> {
  await client.query("update invites set used_at = now() where venue_id = $1 and id = $2", [
    venueId,
    inviteId,
  ]);
}

export interface PhoneCodeRow {
  readonly id: string;
  readonly phoneE164: string;
  readonly codeHash: string;
  readonly attempts: number;
  readonly expiresAt: string;
}

/** A new code for a number, replacing any open one for the membership. */
export async function createPhoneCode(
  client: Queryable,
  args: {
    readonly venueId: string;
    readonly membershipId: string;
    readonly phoneE164: string;
    readonly codeHash: string;
    readonly expiresAt: string;
  },
): Promise<string> {
  await client.query(
    "update phone_codes set expires_at = now() where venue_id = $1 and membership_id = $2 and verified_at is null and expires_at > now()",
    [args.venueId, args.membershipId],
  );
  const r = await client.query<{ id: string }>(
    `insert into phone_codes (venue_id, membership_id, phone_e164, code_hash, expires_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [args.venueId, args.membershipId, args.phoneE164, args.codeHash, args.expiresAt],
  );
  return r.rows[0]!.id;
}

/** The open code for a membership and number, if any; every call counts as a try. */
export async function tryPhoneCode(
  client: Queryable,
  venueId: string,
  membershipId: string,
  phoneE164: string,
  now: string,
): Promise<PhoneCodeRow | null> {
  const r = await client.query<{
    id: string;
    phone_e164: string;
    code_hash: string;
    attempts: number;
    expires_at: Date;
  }>(
    `update phone_codes set attempts = attempts + 1
     where id = (
       select id from phone_codes
       where venue_id = $1 and membership_id = $2 and phone_e164 = $3 and verified_at is null and expires_at > $4
       order by created_at desc limit 1)
     returning id, phone_e164, code_hash, attempts, expires_at`,
    [venueId, membershipId, phoneE164, now],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    phoneE164: row.phone_e164,
    codeHash: row.code_hash,
    attempts: row.attempts,
    expiresAt: row.expires_at.toISOString(),
  };
}

/** The number is confirmed: on the code and on the person. */
export async function markPhoneVerified(
  client: Queryable,
  venueId: string,
  phoneCodeId: string,
  userId: string,
  phoneE164: string,
): Promise<void> {
  await client.query("update phone_codes set verified_at = now() where venue_id = $1 and id = $2", [
    venueId,
    phoneCodeId,
  ]);
  await client.query("update users set phone_e164 = $2, phone_verified_at = now() where id = $1", [
    userId,
    phoneE164,
  ]);
}

/** The person's own PIN is set and the membership is active. */
export async function setPinVerifier(
  client: Queryable,
  venueId: string,
  membershipId: string,
  verifier: string | null,
  locale?: "en" | "es",
): Promise<void> {
  await client.query(
    `update memberships
     set pin_verifier = $3::text,
         status = case when $3::text is null then status else 'active' end,
         locale = coalesce($4::text, locale)
     where venue_id = $1 and id = $2`,
    [venueId, membershipId, verifier, locale ?? null],
  );
}
