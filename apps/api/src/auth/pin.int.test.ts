import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import pg from "pg";
import { Worker, parseAuthSecretKey, pinVerifier, recordPunch } from "@west4/db";
import {
  createTestDatabase,
  seedTwoVenues,
  type TestDatabase,
  type TwoVenues,
} from "@west4/db/test-helpers";
import {
  SEED_NOW,
  SimulatedClock,
  Temporal,
  makeDeviceKey,
  signDeviceRequest,
} from "@west4/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { route } from "../http/conventions.js";
import type { Principal } from "../http/principal.js";
import { FakePushSender } from "../push/sender.js";
import { PUSH_SEND_KIND, makePushSendHandler } from "../push/send-push.js";

/**
 * M1-24 acceptance: Maya signs in on the bar computer with her name and PIN;
 * five wrong PINs lock her there for 1 minute while the front desk still
 * works, the next five for 5 minutes, then 15; ten wrong tries across Maya
 * and Diego pause PIN sign-in on the bar computer and Andy's phone gets the
 * alert; while paused, the bar computer's heartbeats and ring channel keep
 * arriving.
 */
const KEY = "b".repeat(64);
const pepper = parseAuthSecretKey(KEY);

let db: TestDatabase;
let v: TwoVenues;
let app: FastifyInstance;
let owner: pg.Pool;
let baseUrl = "";
const clock = new SimulatedClock(SEED_NOW);

type Device = { id: string; key: Awaited<ReturnType<typeof makeDeviceKey>> };
let bar: Device;
let desk: Device;
let maya = "";
let diego = "";
let andy = "";

const headerAuth = async (request: { headers: Record<string, unknown> }) => {
  const raw = request.headers["x-test-principal"];
  return typeof raw === "string" ? (JSON.parse(raw) as Principal) : undefined;
};
const asOwner = (): Record<string, string> => ({
  "x-test-principal": JSON.stringify({
    kind: "user",
    userId: v.ownerA,
    session: "passkey",
    memberships: [{ venueId: v.venueA, membershipId: "m-owner", role: "owner" }],
  } satisfies Principal),
});

const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { error?: { code: string; message: string } };

async function person(name: string, role: string, pin: string): Promise<string> {
  const u = await owner.query<{ id: string }>("insert into users (name) values ($1) returning id", [
    name,
  ]);
  const m = await owner.query<{ id: string }>(
    `insert into memberships (venue_id, user_id, role, status, pin_digits, locale)
     values ($1, $2, $3, 'active', $4, 'en') returning id`,
    [v.venueA, u.rows[0]!.id, role, pin.length],
  );
  await owner.query("update memberships set pin_verifier = $2 where id = $1", [
    m.rows[0]!.id,
    await pinVerifier(pepper, v.venueA, m.rows[0]!.id, pin),
  ]);
  return m.rows[0]!.id;
}

async function sharedDevice(kind: "bar_computer" | "front_desk", name: string): Promise<Device> {
  const key = await makeDeviceKey();
  const r = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, public_key) values ($1, $2, $3, $4) returning id",
    [v.venueA, kind, name, JSON.stringify(key.publicJwk)],
  );
  return { id: r.rows[0]!.id, key };
}

async function signed(device: Device, method: "POST" | "GET", path: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers = await signDeviceRequest({
    deviceId: device.id,
    privateKey: device.key.privateKey,
    method,
    path,
    body: payload,
  });
  return app.inject({
    method,
    url: path,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload }),
  });
}

const pin = (device: Device, membershipId: string, code: string) =>
  signed(device, "POST", "/v1/auth/pin", {
    membership_id: membershipId,
    pin: code,
    client: "shared",
  });

async function wrongTimes(device: Device, membershipId: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    const r = await pin(device, membershipId, "0000");
    expect(r.statusCode, `${i}: ${r.body}`).toBe(401);
  }
}

beforeAll(async () => {
  db = await createTestDatabase({ migrate: true });
  v = await seedTwoVenues(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  const config = loadConfig({
    WEST4_ENV: "local",
    DATABASE_URL: db.url,
    APP_DATABASE_URL: db.url,
    AUTH_SECRET_KEY: KEY,
  });
  app = buildApp({
    config,
    clock,
    moduleCacheMs: 0,
    eventsPollMs: 100,
    authenticators: [headerAuth],
    extraRoutes: (a) => {
      // A later route that asks for the PIN again (refunds, cash counts, no-sale).
      a.post<{ Params: { venueId: string }; Body: { pin: string } }>(
        "/v1/venues/:venueId/fixture/pin-again",
        {
          config: route({
            principals: ["staff", "owner_manager"],
            module: "core",
            idempotency: "none",
          }),
        },
        async (request) => {
          await a.checkPinAgain(request, request.body.pin);
          return { ok: true };
        },
      );
    },
  });
  await app.ready();
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  maya = await person("Maya S.", "bartender", "4071");
  diego = await person("Diego R.", "front_desk", "6358");
  andy = await person("Andy C.", "manager", "730915");
  // Andy on the clock on Manager duty: the manager on duty (M7-01).
  await recordPunch(owner, {
    venueId: v.venueA,
    membershipId: andy,
    kind: "clock_in",
    duty: "manager",
    at: Temporal.Instant.from("2026-09-25T22:00:00Z"),
    venue: { timeZone: "America/New_York", dayCutover: "06:00" },
  });
  bar = await sharedDevice("bar_computer", "Bar computer");
  desk = await sharedDevice("front_desk", "Front desk");
  // Andy's phone, subscribed to push (M1-22).
  const andyUser = await owner.query<{ user_id: string }>(
    "select user_id from memberships where id = $1",
    [andy],
  );
  const phone = await owner.query<{ id: string }>(
    "insert into devices (venue_id, kind, name, user_id, public_key) values ($1, 'staff_phone', 'Andy''s phone', $2, '{}') returning id",
    [v.venueA, andyUser.rows[0]!.user_id],
  );
  await owner.query(
    'insert into push_subscriptions (venue_id, device_id, endpoint, keys) values ($1, $2, \'https://push.example.test/andy\', \'{"p256dh":"k","auth":"a"}\')',
    [v.venueA, phone.rows[0]!.id],
  );
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await db.drop();
});

describe("name and PIN on a shared screen", () => {
  it("Maya signs in on the bar computer with her name and PIN; the session never opens Admin", async () => {
    const r = await pin(bar, maya, "4071");
    expect(r.statusCode, r.body).toBe(200);
    const body = json(r);
    expect((body["session"] as { assurance: string }).assurance).toBe("pin");
    expect(body["membership"]).toMatchObject({ id: maya, role: "bartender" });
    const token = body["token"] as string;
    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(json(me)["memberships"]).toEqual([
      expect.objectContaining({ membership_id: maya, role: "bartender" }),
    ]);
    const admin = await app.inject({
      method: "GET",
      url: `/v1/venues/${v.venueA}/permissions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(admin.statusCode).toBe(403);
    // A wrong tile, a missing device signature, or a phone's client on a shared screen: no session.
    expect((await pin(bar, diego, "4071")).statusCode).toBe(401);
    const unsigned = await app.inject({
      method: "POST",
      url: "/v1/auth/pin",
      payload: { membership_id: maya, pin: "4071", client: "shared" },
    });
    expect(unsigned.statusCode).toBe(403);
    expect(
      (await signed(bar, "POST", "/v1/auth/pin", { pin: "4071", client: "phone" })).statusCode,
    ).toBe(400);
  });

  it("five wrong PINs lock her on the bar computer for 1 minute while the front desk still works; then 5 minutes, then 15", async () => {
    await wrongTimes(bar, maya, 5);
    const locked = await pin(bar, maya, "4071");
    expect(locked.statusCode).toBe(429);
    expect(json(locked).error?.message).toBe("locked for 60 seconds");
    expect((await pin(desk, maya, "4071")).statusCode).toBe(200);
    // Diego's right PIN on the bar computer ends the device's run of wrong tries, not Maya's ladder.
    expect((await pin(bar, diego, "6358")).statusCode).toBe(200);
    clock.advance({ seconds: 61 });
    await wrongTimes(bar, maya, 5);
    expect(json(await pin(bar, maya, "4071")).error?.message).toBe("locked for 300 seconds");
    expect((await pin(bar, diego, "6358")).statusCode).toBe(200);
    clock.advance({ seconds: 301 });
    await wrongTimes(bar, maya, 5);
    expect(json(await pin(bar, maya, "4071")).error?.message).toBe("locked for 900 seconds");
    expect((await pin(bar, diego, "6358")).statusCode).toBe(200);
    clock.advance({ seconds: 901 });
    expect((await pin(bar, maya, "4071")).statusCode).toBe(200);
    const row = await owner.query<{ failures: number; locked_until: string | null }>(
      "select failures, locked_until from pin_lockouts where membership_id = $1 and device_id = $2",
      [maya, bar.id],
    );
    expect(row.rows[0]).toEqual({ failures: 0, locked_until: null });
  });

  it("ten wrong tries across Maya and Diego pause the bar computer, and Andy's phone gets the alert", async () => {
    await wrongTimes(bar, maya, 5);
    await wrongTimes(bar, diego, 5);
    const paused = await pin(bar, diego, "6358");
    expect(paused.statusCode).toBe(403);
    expect(json(paused).error?.message).toMatch(/paused/);
    clock.advance({ minutes: 2 });
    expect((await pin(bar, maya, "4071")).statusCode).toBe(403);
    expect((await pin(desk, diego, "6358")).statusCode).toBe(200);
    // With Andy the manager on duty tonight (M2-15), the alert goes to him by name.
    const job = await owner.query<{ audience: { kind: string } }>(
      "select payload->'audience' as audience from jobs where kind = $1 order by created_at desc limit 1",
      [PUSH_SEND_KIND],
    );
    expect(job.rows[0]!.audience.kind).toBe("person");
    const sender = new FakePushSender();
    const worker = new Worker(owner, {
      pool: "normal",
      handlers: { [PUSH_SEND_KIND]: makePushSendHandler(sender) },
      clock,
      random: () => 0.5,
    });
    expect(await worker.tick()).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.endpoint).toBe("https://push.example.test/andy");
    expect(JSON.parse(sender.sent[0]!.payload).body).toBe(
      "PIN sign-in is paused on Bar computer after 10 wrong tries · pair it again to turn it back on",
    );
    expect(await worker.tick()).toBe(0);
  });

  it("while paused, the bar computer's heartbeats and its ring channel keep arriving", async () => {
    const beat = await signed(bar, "POST", "/v1/devices/heartbeat", {
      app_version: "1.0.0",
      network: { type: "wifi" },
      clock: new Date(Date.now()).toISOString(),
    });
    expect(beat.statusCode, beat.body).toBe(200);
    const path = `/v1/venues/${v.venueA}/events`;
    const headers = await signDeviceRequest({
      deviceId: bar.id,
      privateKey: bar.key.privateKey,
      method: "GET",
      path,
    });
    const ws = new WebSocket(`${baseUrl.replace("http", "ws")}${path}`, { headers });
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once("message", (d) => resolve(JSON.parse(String(d)) as Record<string, unknown>));
      ws.once("error", reject);
      ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    });
    expect(hello["type"]).toBe("hello");
    ws.close();
  });

  it("asks for the PIN again on the session's own device, with the same ladder", async () => {
    const opened = json(await pin(desk, maya, "4071"));
    const auth = { authorization: `Bearer ${opened["token"] as string}` };
    const again = (code: string) =>
      app.inject({
        method: "POST",
        url: `/v1/venues/${v.venueA}/fixture/pin-again`,
        headers: auth,
        payload: { pin: code },
      });
    expect((await again("4071")).statusCode).toBe(200);
    expect((await again("4072")).statusCode).toBe(401);
    for (let i = 0; i < 4; i += 1) expect((await again("4072")).statusCode).toBe(401);
    expect((await again("4071")).statusCode).toBe(429);
    const passkey = await app.inject({
      method: "POST",
      url: `/v1/venues/${v.venueA}/fixture/pin-again`,
      headers: asOwner(),
      payload: { pin: "4071" },
    });
    expect(passkey.statusCode).toBe(403);
  });
});
