import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { runInTransactionScope } from "./outside-calls.js";
import type { Queryable } from "./tenancy.js";

/**
 * Sign-in storage for owners and managers (M1-19): passkeys and authenticator
 * secrets, sessions and the ceremonies in flight. None of it belongs to a
 * venue, so the wall is the person: every query here runs with app.user_id
 * set to the account it concerns, and the two lookups that happen before
 * anyone is known (email → account, token → session) are definer functions.
 */

export type CredentialKind = "passkey" | "totp";
export type SessionAssurance = "passkey" | "authenticator" | "pin" | "badge";
export type SessionClient = "web" | "desktop" | "phone" | "shared";
export type ChallengePurpose =
  | "login_passkey"
  | "login_email"
  | "enroll_email"
  | "enroll_passkey"
  | "enroll_totp"
  | "step_up"
  | "step_up_token";

/** The platform venue id: what app.venue_id holds for work that belongs to no venue. */
export const NO_VENUE = "00000000-0000-0000-0000-000000000000";

/** A transaction as one person and no venue: the auth tables' policies check app_user_id(). */
export async function withUser<T>(
  pool: pg.Pool,
  context: { readonly userId: string; readonly requestId?: string | undefined },
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.venue_id', $1, true)", [NO_VENUE]);
    await client.query("select set_config('app.user_id', $1, true)", [context.userId]);
    await client.query("select set_config('app.request_id', $1, true)", [context.requestId ?? ""]);
    const result = await runInTransactionScope("user transaction", () => work(client));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---- Secrets at rest --------------------------------------------------------

/** Local development only: the key the API and the seed fall back to when AUTH_SECRET_KEY is unset and WEST4_ENV is local. Refused anywhere else. */
export const LOCAL_DEV_AUTH_KEY =
  "6c6f63616c2d6465762d6b65792d6e6f742d666f722d73746167696e672d2121";

/** AUTH_SECRET_KEY: 32 bytes as 64 hex characters, from the environment only. */
export function parseAuthSecretKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex))
    throw new Error("AUTH_SECRET_KEY must be 64 hex characters (32 bytes)");
  return Buffer.from(hex, "hex");
}

/** AES-256-GCM: iv.tag.ciphertext, base64url. A different iv every time. */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, body].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(key: Buffer, sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !body) throw new Error("sealed secret is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A session, step-up or manage token: 256 random bits, shown once and stored hashed. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A 6-digit code for email, with leading zeros kept. */
export function newEmailCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

// ---- Accounts ---------------------------------------------------------------

export interface AccountByEmail {
  readonly userId: string;
  readonly name: string;
  readonly locale: "en" | "es";
  readonly venueId: string;
  readonly venueName: string;
  readonly mfaRequired: boolean;
}

export async function accountByEmail(
  client: Queryable,
  email: string,
): Promise<AccountByEmail | null> {
  const r = await client.query<{
    user_id: string;
    name: string;
    locale: "en" | "es";
    venue_id: string;
    venue_name: string;
    mfa_required: boolean;
  }>("select * from auth_user_by_email($1)", [email.trim()]);
  const row = r.rows[0];
  return row
    ? {
        userId: row.user_id,
        name: row.name,
        locale: row.locale,
        venueId: row.venue_id,
        venueName: row.venue_name,
        mfaRequired: row.mfa_required,
      }
    : null;
}

// ---- Credentials ------------------------------------------------------------

export interface CredentialRow {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly name: string | null;
  readonly credentialId: string | null;
  readonly publicKey: string | null;
  readonly signCount: number;
  readonly transports: string[] | null;
  readonly secretEnc: string | null;
  readonly totpLastStep: number | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

const credentialColumns = `id, kind, name, credential_id, public_key, sign_count::int as sign_count, transports,
  secret_enc, totp_last_step::int as totp_last_step, created_at::text as created_at, last_used_at::text as last_used_at`;

function toCredential(row: Record<string, unknown>): CredentialRow {
  return {
    id: row["id"] as string,
    kind: row["kind"] as CredentialKind,
    name: row["name"] as string | null,
    credentialId: row["credential_id"] as string | null,
    publicKey: row["public_key"] as string | null,
    signCount: row["sign_count"] as number,
    transports: row["transports"] as string[] | null,
    secretEnc: row["secret_enc"] as string | null,
    totpLastStep: row["totp_last_step"] as number | null,
    createdAt: row["created_at"] as string,
    lastUsedAt: row["last_used_at"] as string | null,
  };
}

/** The person's live credentials (app.user_id must be them). */
export async function activeCredentials(
  client: Queryable,
  userId: string,
): Promise<CredentialRow[]> {
  const r = await client.query(
    `select ${credentialColumns} from auth_credentials
     where user_id = $1 and revoked_at is null order by created_at`,
    [userId],
  );
  return r.rows.map((row) => toCredential(row as Record<string, unknown>));
}

export async function addPasskey(
  client: Queryable,
  input: {
    userId: string;
    name: string | null;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[] | null;
    at: string;
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into auth_credentials (user_id, kind, name, credential_id, public_key, sign_count, transports, created_at)
     values ($1, 'passkey', $2, $3, $4, $5, $6, $7) returning id`,
    [
      input.userId,
      input.name,
      input.credentialId,
      input.publicKey,
      input.signCount,
      input.transports === null ? null : JSON.stringify(input.transports),
      input.at,
    ],
  );
  return r.rows[0]!.id;
}

export async function addTotp(
  client: Queryable,
  input: { userId: string; name: string | null; secretEnc: string; at: string },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into auth_credentials (user_id, kind, name, secret_enc, created_at)
     values ($1, 'totp', $2, $3, $4) returning id`,
    [input.userId, input.name, input.secretEnc, input.at],
  );
  return r.rows[0]!.id;
}

/** After a passkey signed in: the counter moves forward, or the sign-in is refused (a cloned key). */
export async function markPasskeyUsed(
  client: Queryable,
  input: { id: string; signCount: number; at: string },
): Promise<void> {
  await client.query(
    "update auth_credentials set sign_count = $2, last_used_at = $3 where id = $1",
    [input.id, input.signCount, input.at],
  );
}

/** After a code was accepted: remember the step so the same code never works twice. */
export async function markTotpUsed(
  client: Queryable,
  input: { id: string; step: number; at: string },
): Promise<void> {
  await client.query(
    "update auth_credentials set totp_last_step = $2, last_used_at = $3 where id = $1",
    [input.id, input.step, input.at],
  );
}

export async function revokeCredential(
  client: Queryable,
  id: string,
  at: string,
): Promise<boolean> {
  const r = await client.query(
    "update auth_credentials set revoked_at = $2 where id = $1 and revoked_at is null",
    [id, at],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---- Sessions ---------------------------------------------------------------

export interface OpenSessionInput {
  readonly userId: string;
  readonly principal: "owner_manager" | "staff";
  readonly assurance: SessionAssurance;
  readonly client: SessionClient;
  readonly membershipId?: string | null;
  readonly deviceId?: string | null;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/** Opens a session and returns the token, shown once. */
export async function openSession(
  client: Queryable,
  input: OpenSessionInput,
): Promise<{ id: string; token: string }> {
  const token = newToken();
  const r = await client.query<{ id: string }>(
    `insert into auth_sessions (principal, user_id, membership_id, device_id, assurance, client, token_hash,
       started_at, last_seen_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) returning id`,
    [
      input.principal,
      input.userId,
      input.membershipId ?? null,
      input.deviceId ?? null,
      input.assurance,
      input.client,
      sha256Hex(token),
      input.startedAt,
      input.expiresAt,
    ],
  );
  return { id: r.rows[0]!.id, token };
}

export type SessionState = "ok" | "locked" | "expired" | "ended";

export interface ResolvedSession {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly userId: string;
  readonly userName: string;
  readonly assurance: SessionAssurance;
  readonly expiresAt: string;
  readonly memberships: readonly { venueId: string; membershipId: string; role: string }[];
  /** A PIN or badge session's one membership and the device it was opened on (M1-24). */
  readonly membershipId: string | null;
  readonly deviceId: string | null;
}

/** Token → session, moving last_seen_at, locking or ending it as the clock says. */
export async function resolveSession(
  client: Queryable,
  input: { token: string; now: string; idleMinutes: number; maxHours: number },
): Promise<ResolvedSession | null> {
  const r = await client.query<{
    session_id: string;
    state: SessionState;
    user_id: string;
    user_name: string;
    assurance: SessionAssurance;
    expires_at: string;
    venue_id: string | null;
    membership_id: string | null;
    role: string | null;
    session_membership_id: string | null;
    session_device_id: string | null;
  }>(
    `select session_id, state, user_id, user_name, assurance, expires_at::text as expires_at, venue_id, membership_id, role, session_membership_id, session_device_id
     from auth_resolve_session($1, $2::timestamptz, make_interval(mins => $3), make_interval(hours => $4))`,
    [sha256Hex(input.token), input.now, input.idleMinutes, input.maxHours],
  );
  const first = r.rows[0];
  if (!first) return null;
  return {
    sessionId: first.session_id,
    state: first.state,
    userId: first.user_id,
    userName: first.user_name,
    assurance: first.assurance,
    expiresAt: first.expires_at,
    memberships: r.rows
      .filter((row) => row.venue_id !== null)
      .map((row) => ({
        venueId: row.venue_id!,
        membershipId: row.membership_id!,
        role: row.role!,
      })),
    membershipId: first.session_membership_id,
    deviceId: first.session_device_id,
  };
}

export async function endSession(
  client: Queryable,
  input: { id: string; at: string; reason: "signed_out" | "revoked" | "replaced" },
): Promise<void> {
  await client.query(
    "update auth_sessions set ended_at = $2, end_reason = $3 where id = $1 and ended_at is null",
    [input.id, input.at, input.reason],
  );
}

/** Every live session of a person, for offboarding (M1-27) and revocation. */
export async function endAllSessions(
  client: Queryable,
  input: { userId: string; at: string; reason: "revoked" | "replaced" },
): Promise<number> {
  const r = await client.query(
    "update auth_sessions set ended_at = $2, end_reason = $3 where user_id = $1 and ended_at is null",
    [input.userId, input.at, input.reason],
  );
  return r.rowCount ?? 0;
}

// ---- Challenges -------------------------------------------------------------

export interface ChallengeRow {
  readonly id: string;
  readonly purpose: ChallengePurpose;
  readonly challenge: string | null;
  readonly codeHash: string | null;
  readonly secretEnc: string | null;
  readonly sessionId: string | null;
  readonly attempts: number;
  readonly expiresAt: string;
  readonly usedAt: string | null;
}

const challengeColumns = `id, purpose, challenge, code_hash, secret_enc, session_id, attempts,
  expires_at::text as expires_at, used_at::text as used_at`;

function toChallenge(row: Record<string, unknown>): ChallengeRow {
  return {
    id: row["id"] as string,
    purpose: row["purpose"] as ChallengePurpose,
    challenge: row["challenge"] as string | null,
    codeHash: row["code_hash"] as string | null,
    secretEnc: row["secret_enc"] as string | null,
    sessionId: row["session_id"] as string | null,
    attempts: row["attempts"] as number,
    expiresAt: row["expires_at"] as string,
    usedAt: row["used_at"] as string | null,
  };
}

export async function createChallenge(
  client: Queryable,
  input: {
    userId: string;
    purpose: ChallengePurpose;
    challenge?: string | null;
    codeHash?: string | null;
    secretEnc?: string | null;
    sessionId?: string | null;
    at: string;
    expiresAt: string;
  },
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into auth_challenges (user_id, purpose, challenge, code_hash, secret_enc, session_id, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      input.userId,
      input.purpose,
      input.challenge ?? null,
      input.codeHash ?? null,
      input.secretEnc ?? null,
      input.sessionId ?? null,
      input.at,
      input.expiresAt,
    ],
  );
  return r.rows[0]!.id;
}

/** The newest unused, unexpired challenge of a purpose, locked for this transaction. */
export async function openChallenge(
  client: Queryable,
  input: { userId: string; purpose: ChallengePurpose; now: string; challenge?: string },
): Promise<ChallengeRow | null> {
  const r = await client.query(
    `select ${challengeColumns} from auth_challenges
     where user_id = $1 and purpose = $2 and used_at is null and expires_at > $3::timestamptz
       and ($4::text is null or challenge = $4)
     order by created_at desc limit 1 for update`,
    [input.userId, input.purpose, input.now, input.challenge ?? null],
  );
  const row = r.rows[0];
  return row ? toChallenge(row as Record<string, unknown>) : null;
}

export async function countAttempt(client: Queryable, id: string): Promise<number> {
  const r = await client.query<{ attempts: number }>(
    "update auth_challenges set attempts = attempts + 1 where id = $1 returning attempts",
    [id],
  );
  return r.rows[0]!.attempts;
}

export async function useChallenge(client: Queryable, id: string, at: string): Promise<void> {
  await client.query("update auth_challenges set used_at = $2 where id = $1", [id, at]);
}

/** Earlier unused challenges of the same purpose stop working once a new one is issued. */
export async function expireChallenges(
  client: Queryable,
  input: { userId: string; purpose: ChallengePurpose; at: string },
): Promise<void> {
  await client.query(
    "update auth_challenges set used_at = $3 where user_id = $1 and purpose = $2 and used_at is null",
    [input.userId, input.purpose, input.at],
  );
}

// ---- Recovery codes and owner recovery (M1-20) ------------------------------

export const RECOVERY_CODE_COUNT = 10;
/** No 0/O or 1/I, so a code read off paper can't be misread. 10 characters give 50 bits. */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A recovery code as shown once: XXXXX-XXXXX. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (let i = 0; i < 10; i += 1) {
    code += RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length];
    if (i === 4) code += "-";
  }
  return code;
}

/** A code as typed: case and punctuation don't matter. */
export function normalizeRecoveryCode(typed: string): string {
  return typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function recoveryCodeHash(code: string): string {
  return sha256Hex(`recovery:${normalizeRecoveryCode(code)}`);
}

/** Retires every live code and issues a fresh set. The codes are returned once, never stored. */
export async function replaceRecoveryCodes(
  client: Queryable,
  input: { userId: string; at: string; count?: number },
): Promise<string[]> {
  await client.query(
    "update recovery_codes set revoked_at = $2 where user_id = $1 and used_at is null and revoked_at is null",
    [input.userId, input.at],
  );
  const codes = Array.from({ length: input.count ?? RECOVERY_CODE_COUNT }, () => newRecoveryCode());
  await client.query(
    `insert into recovery_codes (user_id, code_hash, created_at)
     select $1, unnest($2::text[]), $3`,
    [input.userId, codes.map(recoveryCodeHash), input.at],
  );
  return codes;
}

/** Spends a live code. False when it's unknown, already used or retired. */
export async function useRecoveryCode(
  client: Queryable,
  input: { userId: string; code: string; at: string },
): Promise<boolean> {
  const r = await client.query(
    `update recovery_codes set used_at = $3
     where user_id = $1 and code_hash = $2 and used_at is null and revoked_at is null`,
    [input.userId, recoveryCodeHash(input.code), input.at],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function countRecoveryCodes(client: Queryable, userId: string): Promise<number> {
  const r = await client.query<{ n: string }>(
    "select count(*)::text as n from recovery_codes where user_id = $1 and used_at is null and revoked_at is null",
    [userId],
  );
  return Number(r.rows[0]!.n);
}

export type RecoveryMethod = "recovery_code" | "second_owner";

export interface OwnerRecoveryRow {
  readonly id: string;
  readonly userId: string;
  readonly method: RecoveryMethod;
  readonly requestedBy: string | null;
  readonly requestedAt: string;
  readonly readyAt: string;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
}

const recoveryColumns = `id, user_id, method, requested_by, requested_at::text as requested_at,
  ready_at::text as ready_at, completed_at::text as completed_at, cancelled_at::text as cancelled_at`;

function toRecovery(row: Record<string, unknown>): OwnerRecoveryRow {
  return {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    method: row["method"] as RecoveryMethod,
    requestedBy: row["requested_by"] as string | null,
    requestedAt: row["requested_at"] as string,
    readyAt: row["ready_at"] as string,
    completedAt: row["completed_at"] as string | null,
    cancelledAt: row["cancelled_at"] as string | null,
  };
}

/** The one recovery neither completed nor cancelled, locked for this transaction. */
export async function openOwnerRecovery(
  client: Queryable,
  userId: string,
): Promise<OwnerRecoveryRow | null> {
  const r = await client.query(
    `select ${recoveryColumns} from owner_recoveries
     where user_id = $1 and completed_at is null and cancelled_at is null
     order by requested_at desc limit 1 for update`,
    [userId],
  );
  const row = r.rows[0];
  return row ? toRecovery(row as Record<string, unknown>) : null;
}

export async function ownerRecoveryById(
  client: Queryable,
  id: string,
): Promise<OwnerRecoveryRow | null> {
  const r = await client.query(
    `select ${recoveryColumns} from owner_recoveries where id = $1 for update`,
    [id],
  );
  const row = r.rows[0];
  return row ? toRecovery(row as Record<string, unknown>) : null;
}

export async function startOwnerRecovery(
  client: Queryable,
  input: {
    userId: string;
    method: RecoveryMethod;
    requestedBy?: string | null;
    at: string;
    readyAt: string;
  },
): Promise<OwnerRecoveryRow> {
  const r = await client.query(
    `insert into owner_recoveries (user_id, method, requested_by, requested_at, ready_at)
     values ($1, $2, $3, $4, $5) returning ${recoveryColumns}`,
    [input.userId, input.method, input.requestedBy ?? null, input.at, input.readyAt],
  );
  return toRecovery(r.rows[0] as Record<string, unknown>);
}

export async function completeOwnerRecovery(
  client: Queryable,
  input: { id: string; at: string },
): Promise<void> {
  await client.query(
    "update owner_recoveries set completed_at = $2 where id = $1 and completed_at is null and cancelled_at is null",
    [input.id, input.at],
  );
}

export async function cancelOwnerRecovery(
  client: Queryable,
  input: { id: string; by: string; at: string },
): Promise<boolean> {
  const r = await client.query(
    `update owner_recoveries set cancelled_at = $2, cancelled_by = $3
     where id = $1 and completed_at is null and cancelled_at is null`,
    [input.id, input.at, input.by],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Does the caller (app.user_id) co-own a venue with this person? */
export async function isCoOwner(client: Queryable, userId: string): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>("select auth_co_owner($1) as ok", [userId]);
  return r.rows[0]!.ok;
}

/** Is the caller (app.user_id) an active owner anywhere? */
export async function isOwnerAnywhere(client: Queryable): Promise<boolean> {
  const r = await client.query<{ n: number }>("select cardinality(owner_venues()) as n");
  return r.rows[0]!.n > 0;
}

export interface RecoveryContact {
  readonly venueId: string;
  readonly venueName: string;
  readonly timeZone: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: "owner" | "manager";
  readonly locale: "en" | "es";
}

/** Every owner and manager at every venue this person owns. Empty when they own none. */
export async function ownerRecoveryContacts(
  client: Queryable,
  userId: string,
): Promise<RecoveryContact[]> {
  const r = await client.query<{
    venue_id: string;
    venue_name: string;
    time_zone: string;
    user_id: string;
    name: string;
    email: string | null;
    role: "owner" | "manager";
    locale: "en" | "es";
  }>("select * from auth_owner_recovery_contacts($1)", [userId]);
  return r.rows.map((row) => ({
    venueId: row.venue_id,
    venueName: row.venue_name,
    timeZone: row.time_zone,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    locale: row.locale,
  }));
}

/** One venue the person works at, with the language and clock the shell needs (M1-21). */
export interface MembershipHome {
  readonly membershipId: string;
  readonly venueId: string;
  readonly venueName: string;
  readonly timeZone: string;
  /** "06:00": the business date turns over here (spec 01). */
  readonly dayCutover: string;
  readonly role: "owner" | "manager" | "bartender" | "front_desk" | "staff";
  readonly locale: "en" | "es";
}

/** Every active membership of a person, oldest first, read across venues by a definer function. */
export async function membershipsOf(client: Queryable, userId: string): Promise<MembershipHome[]> {
  const r = await client.query<{
    membership_id: string;
    venue_id: string;
    venue_name: string;
    time_zone: string;
    day_cutover: string;
    role: MembershipHome["role"];
    locale: MembershipHome["locale"];
  }>("select * from auth_memberships_of($1)", [userId]);
  return r.rows.map((row) => ({
    membershipId: row.membership_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    timeZone: row.time_zone,
    dayCutover: row.day_cutover,
    role: row.role,
    locale: row.locale,
  }));
}

/**
 * The person's own language at one venue (spec 02 · Languages). Runs in the
 * venue's context, so the row policy keeps it to that venue, and the check
 * that the venue offers the language is the caller's (the `languages` setting).
 */
export async function setOwnLocale(
  client: Queryable,
  membershipId: string,
  userId: string,
  locale: "en" | "es",
): Promise<boolean> {
  const r = await client.query(
    "update memberships set locale = $3 where id = $1 and user_id = $2 and status = 'active'",
    [membershipId, userId, locale],
  );
  return (r.rowCount ?? 0) === 1;
}

/** A shared screen's sessions end when the device locks or another person takes over (M1-24). */
export async function endSessionsOnDevice(
  client: Queryable,
  input: { deviceId: string; at: string; reason: "signed_out" | "replaced" | "revoked" },
): Promise<number> {
  const r = await client.query(
    "update auth_sessions set ended_at = $2, end_reason = $3 where device_id = $1 and ended_at is null",
    [input.deviceId, input.at, input.reason],
  );
  return r.rowCount ?? 0;
}
