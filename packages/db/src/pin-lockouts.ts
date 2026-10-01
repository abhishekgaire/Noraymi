import type { Queryable } from "./tenancy.js";

/**
 * The lockout ladder (spec 02 · PINs, M1-24): per person and device, five
 * wrong tries lock for 1 minute, the next five for 5, then 15 minutes each
 * time; a right PIN clears the row. Per device, wrong tries in a row across
 * any names: ten pause PIN sign-in on that device until a manager pairs it
 * again.
 */
export const PIN_TRIES_PER_LOCK = 5;
export const DEVICE_PAUSE_AFTER = 10;

export function lockMinutesFor(failures: number): number {
  if (failures % PIN_TRIES_PER_LOCK !== 0) return 0;
  if (failures === PIN_TRIES_PER_LOCK) return 1;
  if (failures === PIN_TRIES_PER_LOCK * 2) return 5;
  return 15;
}

export interface PinLockout {
  readonly failures: number;
  readonly lockedUntil: string | null;
}

export async function pinLockout(
  client: Queryable,
  venueId: string,
  membershipId: string,
  deviceId: string,
): Promise<PinLockout> {
  const r = await client.query<{ failures: number; locked_until: Date | null }>(
    "select failures, locked_until from pin_lockouts where venue_id = $1 and membership_id = $2 and device_id = $3",
    [venueId, membershipId, deviceId],
  );
  const row = r.rows[0];
  return { failures: row?.failures ?? 0, lockedUntil: row?.locked_until?.toISOString() ?? null };
}

/** One more wrong PIN for this person on this device; returns the new count and any lock it starts. */
export async function recordPinFailure(
  client: Queryable,
  args: { venueId: string; membershipId: string; deviceId: string; now: string },
): Promise<PinLockout> {
  const r = await client.query<{ failures: number }>(
    `insert into pin_lockouts (venue_id, membership_id, device_id, failures, updated_at)
     values ($1, $2, $3, 1, $4)
     on conflict (venue_id, membership_id, device_id)
       do update set failures = pin_lockouts.failures + 1, updated_at = excluded.updated_at
     returning failures`,
    [args.venueId, args.membershipId, args.deviceId, args.now],
  );
  const failures = r.rows[0]!.failures;
  const minutes = lockMinutesFor(failures);
  if (minutes === 0) return { failures, lockedUntil: null };
  const until = await client.query<{ locked_until: Date }>(
    `update pin_lockouts set locked_until = $4::timestamptz + make_interval(mins => $5)
     where venue_id = $1 and membership_id = $2 and device_id = $3 returning locked_until`,
    [args.venueId, args.membershipId, args.deviceId, args.now, minutes],
  );
  return { failures, lockedUntil: until.rows[0]!.locked_until.toISOString() };
}

export async function clearPinLockout(
  client: Queryable,
  venueId: string,
  membershipId: string,
  deviceId: string,
): Promise<void> {
  await client.query(
    "update pin_lockouts set failures = 0, locked_until = null, updated_at = now() where venue_id = $1 and membership_id = $2 and device_id = $3",
    [venueId, membershipId, deviceId],
  );
}

export interface DevicePinState {
  readonly failures: number;
  readonly pausedAt: string | null;
}

/** A wrong PIN on the device, whoever's name it was: the tenth in a row pauses it. */
export async function recordDevicePinFailure(
  client: Queryable,
  venueId: string,
  deviceId: string,
  now: string,
): Promise<DevicePinState & { justPaused: boolean }> {
  const r = await client.query<{ pin_failures: number; pin_paused_at: Date | null }>(
    `update devices
     set pin_failures = pin_failures + 1,
         pin_paused_at = case when pin_paused_at is null and pin_failures + 1 >= $3 then $4::timestamptz else pin_paused_at end
     where venue_id = $1 and id = $2
     returning pin_failures, pin_paused_at`,
    [venueId, deviceId, DEVICE_PAUSE_AFTER, now],
  );
  const row = r.rows[0]!;
  return {
    failures: row.pin_failures,
    pausedAt: row.pin_paused_at?.toISOString() ?? null,
    justPaused: row.pin_failures === DEVICE_PAUSE_AFTER && row.pin_paused_at !== null,
  };
}

/** A right PIN on the device: the run of wrong tries is over. */
export async function clearDevicePinFailures(
  client: Queryable,
  venueId: string,
  deviceId: string,
): Promise<void> {
  await client.query("update devices set pin_failures = 0 where venue_id = $1 and id = $2", [
    venueId,
    deviceId,
  ]);
}

/** What the PIN route needs about the device and the person before it checks anything. */
export async function devicePinState(
  client: Queryable,
  venueId: string,
  deviceId: string,
): Promise<(DevicePinState & { kind: string; name: string; userId: string | null }) | null> {
  const r = await client.query<{
    kind: string;
    name: string;
    user_id: string | null;
    pin_failures: number;
    pin_paused_at: Date | null;
  }>(
    "select kind, name, user_id, pin_failures, pin_paused_at from devices where venue_id = $1 and id = $2 and revoked_at is null",
    [venueId, deviceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    kind: row.kind,
    name: row.name,
    userId: row.user_id,
    failures: row.pin_failures,
    pausedAt: row.pin_paused_at?.toISOString() ?? null,
  };
}

export interface PinMembership {
  readonly membershipId: string;
  readonly userId: string;
  readonly name: string;
  readonly role: "owner" | "manager" | "bartender" | "front_desk" | "staff";
  readonly locale: "en" | "es";
  readonly pinVerifier: string | null;
}

/** An active membership at the venue by id, or the one a personal phone's owner holds. */
export async function pinMembership(
  client: Queryable,
  venueId: string,
  by: { membershipId: string } | { userId: string },
): Promise<PinMembership | null> {
  const where = "membershipId" in by ? "m.id = $2" : "m.user_id = $2";
  const r = await client.query<{
    id: string;
    user_id: string;
    name: string;
    role: PinMembership["role"];
    locale: "en" | "es";
    pin_verifier: string | null;
  }>(
    `select m.id, m.user_id, u.name, m.role, m.locale, m.pin_verifier
     from memberships m join users u on u.id = m.user_id
     where m.venue_id = $1 and ${where} and m.status = 'active'`,
    [venueId, "membershipId" in by ? by.membershipId : by.userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    membershipId: row.id,
    userId: row.user_id,
    name: row.name,
    role: row.role,
    locale: row.locale,
    pinVerifier: row.pin_verifier,
  };
}

/** The name tiles a shared screen shows: every active person, never a PIN or a verifier. */
export async function nameTiles(
  client: Queryable,
  venueId: string,
): Promise<
  { membershipId: string; name: string; role: string; locale: string; hasPin: boolean }[]
> {
  const r = await client.query<{
    id: string;
    name: string;
    role: string;
    locale: string;
    has_pin: boolean;
  }>(
    `select m.id, u.name, m.role, m.locale, m.pin_verifier is not null as has_pin
     from memberships m join users u on u.id = m.user_id
     where m.venue_id = $1 and m.status = 'active'
     order by u.name`,
    [venueId],
  );
  return r.rows.map((row) => ({
    membershipId: row.id,
    name: row.name,
    role: row.role,
    locale: row.locale,
    hasPin: row.has_pin,
  }));
}
