import { createHmac, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readSetting, type Queryable } from "@west4/db";
import {
  MIC_COMMAND_TTL_MS,
  businessDate,
  micCommandSigningString,
  micDesired,
  type MicCommand,
  type MicPower,
  type MicReason,
} from "@west4/rules";
import type { Temporal } from "@west4/shared";

/**
 * The mic power trial's server side (M8-23; spec 11 · Mic power trial). The
 * outlet asks; we answer with a command signed by our Ed25519 key, which the
 * outlet pins at pairing (`GET /v1/devices/mic-outlet/key`). Only a mic_outlet
 * device ever gets a command, and nothing here or anywhere else switches the
 * song player's power: there is no such command.
 */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export interface MicSigner {
  readonly publicKeyPem: string;
  sign(command: MicCommand): string;
}

/** Our command key, derived from the API's secret key so every API instance signs alike. */
export function micSigner(secretKey: Buffer): MicSigner {
  const seed = createHmac("sha256", secretKey).update("west4 mic-outlet commands v1").digest();
  const key: KeyObject = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: "der",
    type: "pkcs8",
  });
  return {
    publicKeyPem: createPublicKey(key).export({ format: "pem", type: "spki" }).toString(),
    sign: (command) =>
      sign(null, Buffer.from(micCommandSigningString(command)), key).toString("base64"),
  };
}

/**
 * What the outlet should do now, logged to the trial log whenever the answer
 * for that outlet changes. On at check-in (an open session), off at
 * close-out (the session ends, and cleaning follows it).
 */
export async function micCommandFor(
  c: Queryable,
  venueId: string,
  deviceId: string,
  now: Temporal.Instant,
): Promise<{ state: MicPower; reason: MicReason; roomId: string | null }> {
  const d = await c.query<{ room_id: string | null; time_zone: string; day_cutover: string }>(
    `select d.room_id, v.time_zone, to_char(v.day_cutover, 'HH24:MI') as day_cutover
       from devices d join venues v on v.id = d.venue_id
      where d.venue_id = $1 and d.id = $2 and d.kind = 'mic_outlet'`,
    [venueId, deviceId],
  );
  const device = d.rows[0];
  if (!device) throw new Error("not a mic outlet");
  const date = businessDate(now, device.time_zone, device.day_cutover).businessDate;
  const rooms = await readSetting(c, venueId, "rooms", date);
  const trialRoomId = rooms?.value.micPowerTrialRoomId ?? null;
  const open =
    device.room_id !== null &&
    (
      await c.query(
        "select 1 from room_sessions where venue_id = $1 and room_id = $2 and ended_at is null limit 1",
        [venueId, device.room_id],
      )
    ).rowCount === 1;
  const desired = micDesired({ trialRoomId, outletRoomId: device.room_id, sessionOpen: open });
  const last = await c.query<{ state: string; reason: string }>(
    `select state, reason from mic_outlet_switches where venue_id = $1 and device_id = $2
      order by at desc, id desc limit 1`,
    [venueId, deviceId],
  );
  const prev = last.rows[0];
  if (!prev || prev.state !== desired.state || prev.reason !== desired.reason)
    await c.query(
      `insert into mic_outlet_switches (venue_id, device_id, room_id, state, reason, at)
       values ($1, $2, $3, $4, $5, $6)`,
      [venueId, deviceId, device.room_id, desired.state, desired.reason, now.toString()],
    );
  return { ...desired, roomId: device.room_id };
}

export function signedMicCommand(
  signer: MicSigner,
  deviceId: string,
  state: MicPower,
  now: Temporal.Instant,
): MicCommand & { signature: string } {
  const command: MicCommand = {
    deviceId,
    state,
    issuedAtMs: now.epochMilliseconds,
    ttlMs: MIC_COMMAND_TTL_MS,
  };
  return { ...command, signature: signer.sign(command) };
}
