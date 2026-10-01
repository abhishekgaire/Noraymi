import { newToken, sha256Hex } from "./auth.js";
import type { Queryable } from "./tenancy.js";

/**
 * The Console's own staff (M1-35, spec 12 · 7): accounts, FIDO2 security
 * keys, sessions and the single sign-on handshake. Platform-level rows, no
 * venue.
 */
export interface ConsoleStaff {
  readonly id: string;
  readonly ssoSubject: string | null;
  readonly name: string;
  readonly email: string;
  readonly active: boolean;
}

export interface ConsoleCredential {
  readonly id: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly transports: string[] | null;
  readonly name: string | null;
}

const STAFF_COLS = "id, sso_subject, name, email, active";
const toStaff = (r: Record<string, unknown>): ConsoleStaff => ({
  id: r["id"] as string,
  ssoSubject: (r["sso_subject"] as string | null) ?? null,
  name: r["name"] as string,
  email: r["email"] as string,
  active: r["active"] as boolean,
});

export async function consoleStaffById(c: Queryable, id: string): Promise<ConsoleStaff | null> {
  const r = await c.query(`select ${STAFF_COLS} from console_staff where id = $1`, [id]);
  return r.rows[0] ? toStaff(r.rows[0] as Record<string, unknown>) : null;
}

/** The staff member an identity provider's subject names, or, until a subject is linked, their email. */
export async function consoleStaffForSso(
  c: Queryable,
  input: { subject: string; email: string | null },
): Promise<ConsoleStaff | null> {
  const bySubject = await c.query(
    `select ${STAFF_COLS} from console_staff where sso_subject = $1 and active`,
    [input.subject],
  );
  if (bySubject.rows[0]) return toStaff(bySubject.rows[0] as Record<string, unknown>);
  if (!input.email) return null;
  const byEmail = await c.query(
    `update console_staff set sso_subject = $1
      where lower(email) = lower($2) and sso_subject is null and active
      returning ${STAFF_COLS}`,
    [input.subject, input.email],
  );
  return byEmail.rows[0] ? toStaff(byEmail.rows[0] as Record<string, unknown>) : null;
}

export async function consoleStaffByEmail(
  c: Queryable,
  email: string,
): Promise<ConsoleStaff | null> {
  const r = await c.query(
    `select ${STAFF_COLS} from console_staff where lower(email) = lower($1) and active`,
    [email],
  );
  return r.rows[0] ? toStaff(r.rows[0] as Record<string, unknown>) : null;
}

export async function addConsoleStaff(
  c: Queryable,
  input: { name: string; email: string; ssoSubject?: string | null },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into console_staff (name, email, sso_subject) values ($1, $2, $3)
       on conflict ((lower(email))) do update set name = excluded.name, active = true
       returning id`,
    [input.name, input.email, input.ssoSubject ?? null],
  );
  return r.rows[0]!.id;
}

const CRED_COLS = "id, credential_id, public_key, sign_count, transports, name";
const toCredential = (r: Record<string, unknown>): ConsoleCredential => ({
  id: r["id"] as string,
  credentialId: r["credential_id"] as string,
  publicKey: r["public_key"] as string,
  signCount: Number(r["sign_count"]),
  transports: (r["transports"] as string[] | null) ?? null,
  name: (r["name"] as string | null) ?? null,
});

export async function consoleKeys(c: Queryable, staffId: string): Promise<ConsoleCredential[]> {
  const r = await c.query(
    `select ${CRED_COLS} from console_credentials where staff_id = $1 and revoked_at is null order by created_at`,
    [staffId],
  );
  return r.rows.map((row) => toCredential(row as Record<string, unknown>));
}

export async function addConsoleKey(
  c: Queryable,
  input: {
    staffId: string;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[] | null;
    name: string | null;
  },
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into console_credentials (staff_id, credential_id, public_key, sign_count, transports, name)
       values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      input.staffId,
      input.credentialId,
      input.publicKey,
      input.signCount,
      input.transports,
      input.name,
    ],
  );
  return r.rows[0]!.id;
}

export async function bumpConsoleKeyCounter(
  c: Queryable,
  id: string,
  count: number,
): Promise<void> {
  await c.query(`update console_credentials set sign_count = $2 where id = $1`, [id, count]);
}

export async function createConsoleChallenge(
  c: Queryable,
  input: { staffId: string; purpose: "register" | "login"; challenge: string; expiresAt: string },
): Promise<void> {
  await c.query(
    `update console_challenges set used_at = now() where staff_id = $1 and purpose = $2 and used_at is null`,
    [input.staffId, input.purpose],
  );
  await c.query(
    `insert into console_challenges (staff_id, purpose, challenge, expires_at) values ($1, $2, $3, $4)`,
    [input.staffId, input.purpose, input.challenge, input.expiresAt],
  );
}

/** The open challenge of a purpose, consumed on the way out: one ceremony per challenge. */
export async function takeConsoleChallenge(
  c: Queryable,
  input: { staffId: string; purpose: "register" | "login"; now: string },
): Promise<string | null> {
  const r = await c.query<{ challenge: string }>(
    `update console_challenges set used_at = $3
      where id = (select id from console_challenges
                   where staff_id = $1 and purpose = $2 and used_at is null and expires_at > $3::timestamptz
                   order by created_at desc limit 1)
      returning challenge`,
    [input.staffId, input.purpose, input.now],
  );
  return r.rows[0]?.challenge ?? null;
}

export async function openConsoleSession(
  c: Queryable,
  input: { staffId: string; startedAt: string; expiresAt: string },
): Promise<{ id: string; token: string }> {
  const token = newToken();
  const r = await c.query<{ id: string }>(
    `insert into console_sessions (staff_id, token_hash, started_at, last_seen_at, expires_at)
       values ($1, $2, $3, $3, $4) returning id`,
    [input.staffId, sha256Hex(token), input.startedAt, input.expiresAt],
  );
  return { id: r.rows[0]!.id, token };
}

export async function resolveConsoleSession(
  c: Queryable,
  input: { token: string; now: string; idleMinutes: number },
): Promise<{ sessionId: string; staff: ConsoleStaff } | null> {
  const r = await c.query(
    `update console_sessions s set last_seen_at = $2
       from console_staff st
      where s.token_hash = $1 and st.id = s.staff_id and st.active
        and s.ended_at is null and s.expires_at > $2::timestamptz
        and s.last_seen_at > $2::timestamptz - make_interval(mins => $3)
      returning s.id as session_id, st.${STAFF_COLS.replaceAll(", ", ", st.")}`,
    [sha256Hex(input.token), input.now, input.idleMinutes],
  );
  const row = r.rows[0] as (Record<string, unknown> & { session_id: string }) | undefined;
  return row ? { sessionId: row.session_id, staff: toStaff(row) } : null;
}

export async function endConsoleSession(c: Queryable, id: string, at: string): Promise<void> {
  await c.query(`update console_sessions set ended_at = $2 where id = $1 and ended_at is null`, [
    id,
    at,
  ]);
}

export async function createSsoState(
  c: Queryable,
  input: { state: string; verifier: string; expiresAt: string },
): Promise<void> {
  await c.query(
    `insert into console_sso_states (state_hash, verifier, expires_at) values ($1, $2, $3)`,
    [sha256Hex(input.state), input.verifier, input.expiresAt],
  );
}

export async function takeSsoState(
  c: Queryable,
  input: { state: string; now: string },
): Promise<string | null> {
  const r = await c.query<{ verifier: string }>(
    `update console_sso_states set used_at = $2
      where state_hash = $1 and used_at is null and expires_at > $2::timestamptz
      returning verifier`,
    [sha256Hex(input.state), input.now],
  );
  return r.rows[0]?.verifier ?? null;
}

export interface ConsoleVenue {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly time_zone: string;
}

/** Every venue, through the definer door: app_rw can't list venues on its own. */
export async function consoleVenues(c: Queryable): Promise<ConsoleVenue[]> {
  const r = await c.query<ConsoleVenue>("select id, name, slug, time_zone from console_venues()");
  return r.rows;
}

export async function consoleVenue(c: Queryable, id: string): Promise<ConsoleVenue | null> {
  const r = await c.query<ConsoleVenue>(
    "select id, name, slug, time_zone from console_venues() where id = $1",
    [id],
  );
  return r.rows[0] ?? null;
}
