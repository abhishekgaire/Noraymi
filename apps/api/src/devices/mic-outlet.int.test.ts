import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { loadDemoSeed } from "@west4/db";
import { createTestDatabase, type TestDatabase } from "@west4/db/test-helpers";
import {
  MIC_COMMAND_TTL_MS,
  acceptMicCommand,
  micCommandSigningString,
  outletPower,
  type MicCommand,
  type OutletMemory,
} from "@west4/rules";
import { SEED_NOW, SimulatedClock, makeDeviceKey, signDeviceRequest } from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

/**
 * M8-23: the one-room mic power trial, with an emulated outlet running the
 * firmware rule (packages/rules/src/mic-outlet.ts) against the real API.
 */
let db: TestDatabase;
let raw: pg.Client;
let app: FastifyInstance;
let venueId = "";
let room2 = "";
const clock = new SimulatedClock(SEED_NOW);
type Key = Awaited<ReturnType<typeof makeDeviceKey>>;
let outlet: { id: string; key: Key };
let bar: { id: string; key: Key };

const signed = async (who: { id: string; key: Key }, method: "GET" | "POST", path: string) =>
  app.inject({
    method,
    url: path,
    headers: await signDeviceRequest({
      deviceId: who.id,
      privateKey: who.key.privateKey,
      method,
      path,
    }),
  });

/** The outlet's firmware, emulated: asks, verifies with the pinned key, keeps the last good command. */
class EmulatedOutlet {
  memory: OutletMemory | null = null;
  rejected: string[] = [];
  constructor(
    readonly deviceId: string,
    readonly pinnedKeyPem: string,
  ) {}
  take(command: MicCommand, signature: string, nowMs: number) {
    const signatureValid = verify(
      null,
      Buffer.from(micCommandSigningString(command)),
      this.pinnedKeyPem,
      Buffer.from(signature, "base64"),
    );
    const r = acceptMicCommand(this.memory, command, {
      deviceId: this.deviceId,
      signatureValid,
      nowMs,
    });
    if (r.rejected) this.rejected.push(r.rejected);
    this.memory = r.memory;
  }
  power(nowMs: number) {
    return outletPower(this.memory, nowMs);
  }
}

let emulated: EmulatedOutlet;
let localMs = 1_000_000; // the outlet's own clock
const ask = async () => {
  clock.set(clock.now().add({ seconds: 15 }));
  localMs += 15_000;
  const r = await signed(outlet, "POST", "/v1/devices/mic-outlet/command");
  expect(r.statusCode).toBe(200);
  const b = r.json<{
    device_id: string;
    state: "on" | "off";
    issued_at_ms: number;
    ttl_ms: number;
    signature: string;
    reason: string;
  }>();
  const command: MicCommand = {
    deviceId: b.device_id,
    state: b.state,
    issuedAtMs: b.issued_at_ms,
    ttlMs: b.ttl_ms,
  };
  emulated.take(command, b.signature, localMs);
  return { command, signature: b.signature, reason: b.reason };
};
const setTrialRoom = (roomId: string | null) =>
  raw.query(
    `update venue_settings set value = jsonb_set(value, '{micPowerTrialRoomId}', $2::jsonb)
      where venue_id = $1 and key = 'rooms'`,
    [venueId, JSON.stringify(roomId)],
  );

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  venueId = (await loadDemoSeed({ databaseUrl: db.url, env: { WEST4_ENV: "local" } })).venueId;
  raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  room2 = (
    await raw.query<{ id: string }>(
      "select row_id as id from seed_ids where venue_id = $1 and slug = 'room_2'",
      [venueId],
    )
  ).rows[0]!.id;
  const device = async (kind: string, roomId: string | null) => {
    const key = await makeDeviceKey();
    const id = (
      await raw.query<{ id: string }>(
        "insert into devices (venue_id, kind, name, public_key, room_id) values ($1, $2, $3, $4, $5) returning id",
        [venueId, kind, `${kind} trial`, JSON.stringify(key.publicJwk), roomId],
      )
    ).rows[0]!.id;
    return { id, key };
  };
  outlet = await device("mic_outlet", room2);
  bar = await device("bar_computer", null);
  app = buildApp({
    config: loadConfig({ WEST4_ENV: "local", DATABASE_URL: db.url, APP_DATABASE_URL: db.url }),
    clock,
    moduleCacheMs: 0,
  });
  await app.ready();
  // Pairing: the outlet pins our command key.
  const key = await signed(outlet, "GET", "/v1/devices/mic-outlet/key");
  expect(key.statusCode).toBe(200);
  emulated = new EmulatedOutlet(outlet.id, key.json<{ public_key: string }>().public_key);
});

afterAll(async () => {
  await app.close();
  await raw.end();
  await db.drop();
});

describe("the mic power trial (M8-23)", () => {
  it("with the flag off the mics stay on, whatever the room is doing", async () => {
    expect((await ask()).reason).toBe("trial_off");
    expect(emulated.power(localMs)).toBe("on");
  });

  it("with the flag on for one room, check-in turns the mic receiver on and close-out turns it off", async () => {
    await setTrialRoom(room2);
    await ask();
    expect(emulated.power(localMs)).toBe("off"); // no party in Room 2
    const session = (
      await raw.query<{ id: string }>(
        `insert into room_sessions (venue_id, room_id, party_size, started_at, business_date)
         values ($1, $2, 4, $3, '2026-09-25') returning id`,
        [venueId, room2, clock.now().toString()],
      )
    ).rows[0]!.id;
    expect((await ask()).reason).toBe("session_open");
    expect(emulated.power(localMs)).toBe("on");
    await raw.query("update room_sessions set ended_at = $2 where id = $1", [
      session,
      clock.now().toString(),
    ]);
    expect((await ask()).reason).toBe("no_session");
    expect(emulated.power(localMs)).toBe("off");
  });

  it("blocking our server turns the outlet back on", async () => {
    // No answers reach the outlet: its last off command runs out.
    expect(emulated.power(localMs + MIC_COMMAND_TTL_MS - 1)).toBe("off");
    expect(emulated.power(localMs + MIC_COMMAND_TTL_MS)).toBe("on");
  });

  it("ignores a stale command and a tampered one", async () => {
    const old = await ask(); // off
    await ask(); // a newer off
    emulated.take(old.command, old.signature, localMs); // replayed
    emulated.take({ ...old.command, issuedAtMs: localMs * 10 }, old.signature, localMs); // forged
    expect(emulated.rejected.slice(-2)).toEqual(["replayed", "bad_signature"]);
  });

  it("only a signed mic outlet gets a command; a bar computer or an unsigned caller doesn't", async () => {
    expect((await signed(bar, "POST", "/v1/devices/mic-outlet/command")).statusCode).toBe(403);
    expect((await signed(bar, "GET", "/v1/devices/mic-outlet/key")).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/v1/devices/mic-outlet/command" })).statusCode,
    ).toBe(403);
  });

  it("nothing ever changes the song player's power: the only power command is the mic outlet's", () => {
    const routes = app.printRoutes({ commonPrefix: false });
    const power = routes.split("\n").filter((l) => /power|outlet/i.test(l));
    expect(power.every((l) => /mic-outlet/.test(l))).toBe(true);
  });

  it("keeps a trial log of each switch, with why", async () => {
    const log = await raw.query<{ state: string; reason: string; room_id: string | null }>(
      "select state, reason, room_id from mic_outlet_switches where device_id = $1 order by at, id",
      [outlet.id],
    );
    expect(log.rows.map((r) => `${r.state}:${r.reason}`)).toEqual([
      "on:trial_off",
      "off:no_session",
      "on:session_open",
      "off:no_session",
    ]);
    expect(log.rows.every((r) => r.room_id === room2)).toBe(true);
  });
});
