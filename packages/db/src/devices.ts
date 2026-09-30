import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { Queryable } from "./tenancy.js";

export type DeviceKind =
  | "bar_computer"
  | "front_desk"
  | "room_tablet"
  | "reader"
  | "printer"
  | "nfc_reader"
  | "router"
  | "staff_phone"
  | "up_next_display"
  | "mic_outlet";
export const deviceKinds: readonly DeviceKind[] = [
  "bar_computer",
  "front_desk",
  "room_tablet",
  "reader",
  "printer",
  "nfc_reader",
  "router",
  "staff_phone",
  "up_next_display",
  "mic_outlet",
];

/** Pairing codes: 8 characters from an alphabet without look-alikes, good for 10 minutes (M1-15 notes; flagged for the founder). */
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_MINUTES = 10;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export interface DeviceRow {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly room_id: string | null;
  readonly user_id: string | null;
  readonly training: boolean;
  readonly last_seen_at: string | null;
  readonly disabled_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

const COLS =
  "id, kind, name, room_id, user_id, training, last_seen_at::text, disabled_at::text, revoked_at::text, created_at::text";

/** A manager makes a one-time code. Inside a venue transaction. Returns the code (shown once) and when it expires. */
export async function createPairingCode(
  client: Queryable,
  args: {
    venueId: string;
    kind: DeviceKind;
    name: string;
    roomId?: string | null;
    createdBy?: string | undefined;
  },
): Promise<{ code: string; expiresAt: string }> {
  const code = makePairingCode();
  const r = await client.query<{ expires_at: string }>(
    `insert into device_pairing_codes (venue_id, code_hash, kind, name, room_id, created_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
     returning expires_at::text`,
    [
      args.venueId,
      hashPairingCode(code),
      args.kind,
      args.name,
      args.roomId ?? null,
      args.createdBy ?? null,
      PAIRING_CODE_MINUTES,
    ],
  );
  return { code, expiresAt: r.rows[0]!.expires_at };
}

/** The device claims its code with its public key. No venue yet: the definer finds it. */
export async function claimDevice(
  pool: pg.Pool,
  code: string,
  publicJwk: unknown,
): Promise<{ deviceId: string; venueId: string } | null> {
  const r = await pool.query<{ device_id: string; venue_id: string }>(
    "select * from claim_device($1, $2)",
    [hashPairingCode(code), JSON.stringify(publicJwk)],
  );
  const row = r.rows[0];
  return row ? { deviceId: row.device_id, venueId: row.venue_id } : null;
}

export interface ResolvedDevice {
  readonly venueId: string;
  readonly kind: DeviceKind;
  /** The device's public key as a JWK (a browser JsonWebKey; the db package has no DOM types). */
  readonly publicJwk: Record<string, unknown> | null;
  readonly revoked: boolean;
  readonly disabled: boolean;
  /** False when this nonce was seen before within the window: a replay. */
  readonly freshNonce: boolean;
}

export async function resolveDevice(
  pool: pg.Pool,
  deviceId: string,
  nonce: string,
  windowMs: number,
): Promise<ResolvedDevice | null> {
  const r = await pool.query<{
    venue_id: string;
    kind: DeviceKind;
    public_key: Record<string, unknown> | null;
    revoked: boolean;
    disabled: boolean;
    fresh_nonce: boolean;
  }>("select * from resolve_device($1, $2, make_interval(secs => $3))", [
    deviceId,
    nonce,
    windowMs / 1000,
  ]);
  const row = r.rows[0];
  return row
    ? {
        venueId: row.venue_id,
        kind: row.kind,
        publicJwk: row.public_key,
        revoked: row.revoked,
        disabled: row.disabled,
        freshNonce: row.fresh_nonce,
      }
    : null;
}

export async function listDevices(client: Queryable, venueId: string): Promise<DeviceRow[]> {
  const r = await client.query<DeviceRow>(
    `select ${COLS} from devices where venue_id = $1 order by kind, name`,
    [venueId],
  );
  return r.rows;
}

export async function updateDevice(
  client: Queryable,
  venueId: string,
  deviceId: string,
  patch: { name?: string | undefined; roomId?: string | null | undefined },
): Promise<DeviceRow | null> {
  const r = await client.query<DeviceRow>(
    `update devices set name = coalesce($3, name), room_id = case when $4::boolean then $5::uuid else room_id end
      where venue_id = $1 and id = $2 and revoked_at is null returning ${COLS}`,
    [venueId, deviceId, patch.name ?? null, patch.roomId !== undefined, patch.roomId ?? null],
  );
  return r.rows[0] ?? null;
}

export async function revokeDevice(
  client: Queryable,
  venueId: string,
  deviceId: string,
): Promise<DeviceRow | null> {
  const r = await client.query<DeviceRow>(
    `update devices set revoked_at = coalesce(revoked_at, now()) where venue_id = $1 and id = $2 returning ${COLS}`,
    [venueId, deviceId],
  );
  return r.rows[0] ?? null;
}
